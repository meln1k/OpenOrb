import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ToolDiagnostic,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import {
  Connection,
  type EnvLink,
  type EnvLinkHandlers,
  RemoteExecutionEnv,
} from "@openorb/pi-env";
import { assert, assertEquals } from "@jsr/std__assert";
import { Effect } from "effect";
import type { AgentEnvironment } from "../../../src/environment/agent-environment.ts";
import {
  type EnvironmentLinkEnd,
  relayEnvironmentDaemon,
} from "../../../src/environment/link/relay.ts";

/** An Environment Link that delivers one frame per message asynchronously, as a WebSocket does. */
interface InMemoryLink {
  readonly client: EnvLink;
  readonly runner: EnvironmentLinkEnd;
}

function inMemoryLink(handlers: EnvLinkHandlers): InMemoryLink {
  let open = true;
  let toRunner!: ReadableStreamDefaultController<Uint8Array>;
  const messages = new ReadableStream<Uint8Array>({
    start: (controller) => void (toRunner = controller),
  });
  const close = (reason: string) => {
    if (!open) return;
    open = false;
    toRunner.close();
    handlers.closed(reason);
  };
  return {
    client: {
      send: (frame) => open && toRunner.enqueue(frame.slice()),
      close: () => close("client closed the link"),
    },
    runner: {
      send: (frame) => queueMicrotask(() => open && handlers.frame(frame.slice())),
      messages,
      close,
    },
  };
}

/** The guest's Environment Daemon behind the runner relay, as a Session Durable Object sees it. */
export function relayedConnection(environment: AgentEnvironment): Connection {
  return new Connection({
    open: async (handlers) => {
      const daemon = await Effect.runPromise(environment.startDaemon);
      const link = inMemoryLink(handlers);
      void Effect.runPromise(relayEnvironmentDaemon(daemon, link.runner));
      return link.client;
    },
  });
}

/** The agent's `ExecutionEnv`: the guest checkout through the Environment Daemon. */
export function guestExecutionEnv(environment: AgentEnvironment) {
  const connection = relayedConnection(environment);
  return {
    env: new RemoteExecutionEnv({ connection, id: "guest", cwd: "/workspace" }),
    /** Closes the link; the daemon then kills every command it started. */
    close: () => connection.close(),
  };
}

/** Pi Durable's file and shell tools over the guest, as the Session Durable Object runs them. */
export function guestTools(env: RemoteExecutionEnv) {
  // SAFETY: each registration validates its own arguments; the test passes model-shaped JSON.
  const tools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
  ] as readonly ToolRegistration[];
  return {
    tools,
    async execute(
      name: "bash" | "read" | "write" | "edit",
      args: Record<string, JsonValue>,
      options: {
        signal?: AbortSignal;
        onOutput?: (text: string) => void;
        expectError?: boolean;
      } = {},
    ) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert(tool, `Missing Durable tool: ${name}`);
      let output = "";
      const decoder = new TextDecoder();
      const diagnostics: ToolDiagnostic[] = [];
      // SAFETY: these executors only use env, output, and diagnostic; no harness task or storage
      // operation is emulated.
      const api = Object.assign({} as ToolExecutionApi, {
        env,
        output: (chunk: string | Uint8Array) => {
          const text =
            chunk instanceof Uint8Array ? decoder.decode(chunk, { stream: true }) : chunk;
          output += text;
          options.onOutput?.(text);
        },
        diagnostic: (diagnostic: ToolDiagnostic) => diagnostics.push(diagnostic),
      });
      const context =
        options.signal === undefined
          ? BACKGROUND_CONTEXT
          : withAbortSignal(options.signal, BACKGROUND_CONTEXT);
      const result: ToolExecutionResult = await tool
        .execute(args, api, context)
        .catch((error: unknown) => {
          if (!options.expectError) throw error;
          return {
            isError: true,
            diagnostics: [
              {
                severity: "error",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        });
      output += decoder.decode();
      diagnostics.push(...(result.diagnostics ?? []));
      assertEquals(
        result.isError ?? false,
        options.expectError ?? false,
        JSON.stringify(diagnostics),
      );
      const text =
        result.output
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("") ?? "";
      return { result, output, text, diagnostics };
    },
  };
}

/** A guest file's contents through the runner's own exec path, independent of the daemon. */
export async function readGuestText(environment: AgentEnvironment, path: string) {
  let output = "";
  const result = await Effect.runPromise(
    environment.run(["/bin/cat", "--", path], {
      onOutput: (chunk) =>
        Effect.sync(() => {
          if (chunk.stream === "stdout") output += chunk.text;
        }),
    }),
  );
  assertEquals(result.exitCode, 0, `could not read ${path}`);
  return output;
}

/** Whether a guest path exists, through the runner's own exec path. */
export async function guestPathExists(environment: AgentEnvironment, path: string) {
  return (await Effect.runPromise(environment.run(["/usr/bin/test", "-e", path]))).exitCode === 0;
}

/** Writes a guest file through the runner's own exec path, independent of the daemon. */
export async function writeGuestText(environment: AgentEnvironment, path: string, content: string) {
  const result = await Effect.runPromise(
    environment.run(["/bin/sh", "-c", 'printf %s "$1" > "$2"', "openorb-write", content, path]),
  );
  assertEquals(result.exitCode, 0, `could not write ${path}`);
}
