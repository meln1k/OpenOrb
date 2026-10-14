import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionError, FileError, Result } from "@earendil-works/pi-durable/env";
import { ok } from "@earendil-works/pi-durable/env";
import { Bash } from "just-bash/browser";
import { JustBashEnv } from "./just-bash-env.ts";
import { SANDBOX_COMMAND_SECONDS, SANDBOX_FILESYSTEM_BYTES } from "./limits.ts";
import { PersistentFs, type SandboxSql } from "./persistent-fs.ts";
import {
  encodeResult,
  FILE_METHODS,
  type FileMethod,
  READER_METHODS,
  type ReaderMethod,
  type SandboxRpc,
  type WireExecOptions,
  type WireExecResult,
  type WireResult,
} from "./rpc.ts";
import { tarCommand } from "./tar.ts";

/**
 * The sandbox's own code, loaded by the Session Durable Object through the Worker Loader into a
 * separate isolate with no bindings and no network (ADR 0007). It runs as a facet of the Session
 * Durable Object with its own SQLite database, which holds the virtual filesystem. A Worker module
 * exports only handlers, so everything else stays private.
 */

const MAX_OPEN_READERS = 64;
const MAX_EARLY_CANCELS = 64;

type Outcome = Result<unknown, FileError | ExecutionError>;
type AnyReader = { readonly [method: string]: (...args: unknown[]) => Promise<Outcome | void> };

/** The parts of the facet's Durable Object state the sandbox uses. */
interface SandboxContext {
  readonly storage: { readonly sql: SandboxSql };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export class Sandbox extends DurableObject<unknown> implements SandboxRpc {
  readonly #env: Promise<JustBashEnv>;
  readonly #readers = new Map<
    string,
    { readonly kind: ReaderMethod; readonly reader: AnyReader }
  >();
  readonly #running = new Map<string, AbortController>();
  readonly #cancelled = new Set<string>();

  constructor(ctx: SandboxContext, env: unknown) {
    super(ctx, env);
    this.#env = ctx.blockConcurrencyWhile(async () => {
      const fs = await PersistentFs.open(ctx.storage.sql, SANDBOX_FILESYSTEM_BYTES);
      await fs.mkdir("/workspace", { recursive: true });
      const bash = new Bash({
        fs,
        cwd: "/workspace",
        customCommands: [tarCommand],
        executionLimitProfile: "hardened",
        executionLimits: { maxExecutionTimeMs: SANDBOX_COMMAND_SECONDS * 1000 },
        // The isolate is the boundary; just-bash's in-process hardening needs Node's async_hooks.
        defenseInDepth: false,
      });
      return new JustBashEnv("sandbox", bash);
    });
  }

  async file(cwd: string, method: FileMethod, args: readonly unknown[]) {
    if (!FILE_METHODS.includes(method)) return invalid(`Unknown operation ${method}.`);
    const env = (await this.#env).withCwd(cwd);
    // SAFETY: every FILE_METHODS member takes its Context last and returns a Result.
    const call = env[method] as (...args: unknown[]) => Promise<Outcome>;
    return encodeResult(await call.apply(env, [...args, BACKGROUND_CONTEXT]));
  }

  async open(
    cwd: string,
    method: ReaderMethod,
    args: readonly unknown[],
  ): Promise<WireResult<string>> {
    if (!Object.hasOwn(READER_METHODS, method)) return invalid(`Unknown reader ${method}.`);
    const env = (await this.#env).withCwd(cwd);
    // SAFETY: every READER_METHODS member takes its Context last and returns a reader Result.
    const call = env[method] as (...args: unknown[]) => Promise<Result<AnyReader, FileError>>;
    const opened = await call.apply(env, [...args, BACKGROUND_CONTEXT]);
    if (!opened.ok) return encodeResult(opened);
    // Readers hold a snapshot; the oldest is dropped if a caller leaks them.
    for (const [handle, { reader }] of this.#readers) {
      if (this.#readers.size < MAX_OPEN_READERS) break;
      this.#readers.delete(handle);
      await reader.close?.(BACKGROUND_CONTEXT);
    }
    const handle = crypto.randomUUID();
    this.#readers.set(handle, { kind: method, reader: opened.value });
    return encodeResult(ok(handle));
  }

  async reader(handle: string, method: string, args: readonly unknown[]) {
    const open = this.#readers.get(handle);
    const methods: readonly string[] = open === undefined ? [] : READER_METHODS[open.kind];
    if (open === undefined || !methods.includes(method)) {
      return invalid("The reader is closed or was lost when the sandbox restarted.");
    }
    if (method === "close") {
      this.#readers.delete(handle);
      await open.reader.close?.(BACKGROUND_CONTEXT);
      return encodeResult(ok(undefined));
    }
    const call = open.reader[method]!;
    // SAFETY: reader methods other than close return a Result.
    return encodeResult((await call.apply(open.reader, [...args, BACKGROUND_CONTEXT])) as Outcome);
  }

  async exec(
    id: string,
    cwd: string,
    command: string | readonly string[],
    options: WireExecOptions,
  ): Promise<WireExecResult> {
    const controller = new AbortController();
    if (this.#cancelled.delete(id)) controller.abort();
    this.#running.set(id, controller);
    using _running = { [Symbol.dispose]: () => this.#running.delete(id) };
    const env = (await this.#env).withCwd(cwd);
    const output: ["stdout" | "stderr", string][] = [];
    const result = await env.exec(
      command,
      {
        ...options,
        onOutput: (text, _context, info) => output.push([info.stream, text]),
      },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    );
    return { result: encodeResult(result), output };
  }

  /**
   * Abort is cooperative: just-bash stops at its next statement, and a command busy in one
   * built-in runs on until the call's CPU limit. A cancel that overtakes its command is kept.
   */
  cancel(id: string): void {
    const running = this.#running.get(id);
    if (running !== undefined) return running.abort();
    this.#cancelled.add(id);
    for (const early of this.#cancelled) {
      if (this.#cancelled.size <= MAX_EARLY_CANCELS) break;
      this.#cancelled.delete(early);
    }
  }

  async cleanup(): Promise<void> {
    await (await this.#env).cleanup();
  }
}

function invalid(message: string): WireResult<never> {
  return { ok: false, error: { kind: "file", code: "invalid", message } };
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
