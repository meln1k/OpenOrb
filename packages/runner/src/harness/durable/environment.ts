import type { Context } from "@earendil-works/chord";
import {
  err,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileInfo,
  LineScanner,
  ok,
  type Result,
  StreamDecoder,
} from "@earendil-works/pi-durable/env";
import { MAX_SESSION_ARTIFACT_BYTES } from "@openorb/protocol/runner-api";
import { tryAsync } from "@openorb/result";
import { Effect, Schema } from "effect";
import { posix } from "node:path";
import { type AgentEnvironment, resolveAgentPath } from "../../environment/agent-environment.ts";

/** An immediate capability object, not acquisition of a VM. No host filesystem fallback. */
export function createGuestExecutionEnv(guest: AgentEnvironment, id: string): ExecutionEnv {
  const perform = async <T>(
    context: Context,
    action: () => Effect.Effect<T, unknown>,
  ): Promise<Result<T, FileError>> => {
    const [value, error] = await tryAsync(
      (async () => {
        context.abortSignal?.throwIfAborted();
        return await Effect.runPromise(action(), { signal: context.abortSignal });
      })(),
      (cause) =>
        context.abortSignal?.aborted
          ? new FileError("aborted", "Guest file operation cancelled")
          : cause instanceof FileError
          ? cause
          : new FileError(
            "unknown",
            "Guest file operation failed",
            undefined,
            cause instanceof Error ? cause : undefined,
          ),
    );
    if (error !== undefined) return err(error);
    return ok(value);
  };
  const unsupported = (): Promise<Result<never, FileError>> =>
    Promise.resolve(err(new FileError("not_supported", "Capability not exposed by Gondolin")));
  const fileInfo = (path: string): Effect.Effect<FileInfo, unknown> =>
    guest.stat(path).pipe(Effect.flatMap((stat) => {
      const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
      return kind === undefined
        ? Effect.fail(new FileError("not_supported", "Unsupported file type", path))
        : Effect.succeed({
          name: posix.basename(path),
          path,
          kind,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
    }));
  const env: ExecutionEnv = {
    id,
    cwd: "/workspace",
    absolutePath: (path, context) =>
      perform(context, () => Effect.sync(() => resolveAgentPath(path))),
    joinPath: (parts, context) => perform(context, () => Effect.sync(() => posix.join(...parts))),
    readTextFile: (path, context) =>
      perform(context, () =>
        guest.readFile(resolveAgentPath(path), {
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          maxBytes: 4 * 1024 * 1024,
        }).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))),
    readBinaryFile: (path, context) =>
      perform(context, () =>
        guest.readFile(resolveAgentPath(path), {
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
          maxBytes: MAX_SESSION_ARTIFACT_BYTES,
        })),
    openBinaryReader: (path, options, context) => {
      // Gondolin exposes bounded whole-file reads, not an open guest handle or no-follow open.
      // Retain one bounded snapshot so a renamed/replaced path cannot redirect later reads.
      if (options?.noFollow) return unsupported();
      return perform(context, () =>
        Effect.gen(function* () {
          const absolute = resolveAgentPath(path);
          const info = yield* fileInfo(absolute);
          if (info.kind !== "file") {
            return yield* Effect.fail(
              new FileError("is_directory", "Expected a regular file", path),
            );
          }
          let bytes: Uint8Array | undefined = yield* guest.readFile(absolute, {
            ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
            maxBytes: MAX_SESSION_ARTIFACT_BYTES,
          }).pipe(Effect.map((content) => content.slice()));
          const snapshotInfo = { ...info, size: bytes.length };
          const readSnapshot = <T>(action: (content: Uint8Array) => T) =>
            Effect.suspend(() => {
              const content = bytes;
              return content === undefined
                ? Effect.fail(new FileError("invalid", "Guest binary reader is closed", path))
                : Effect.sync(() => action(content));
            });
          return {
            info: (context: Context) => perform(context, () => readSnapshot(() => snapshotInfo)),
            read: (offset: number, length: number, context: Context) =>
              perform(context, () =>
                readSnapshot((content) => {
                  if (
                    !Number.isSafeInteger(offset) || offset < 0 ||
                    !Number.isSafeInteger(length) || length < 0
                  ) throw new FileError("invalid", "Invalid guest read range", path);
                  return content.slice(offset, offset + length);
                })),
            scanLines: (options: { startLine: number; endLine?: number }, context: Context) =>
              perform(context, () =>
                readSnapshot((content) => {
                  if (
                    !Number.isSafeInteger(options.startLine) || options.startLine < 0 ||
                    (options.endLine !== undefined &&
                      (!Number.isSafeInteger(options.endLine) ||
                        options.endLine <= options.startLine))
                  ) throw new FileError("invalid", "Invalid guest line range", path);
                  const scanner = new LineScanner(options.startLine, options.endLine);
                  scanner.push(content);
                  return scanner.finish();
                })),
            close: () => {
              bytes = undefined;
              return Promise.resolve();
            },
          };
        }));
    },
    writeFile: (path, content, context) =>
      perform(context, () => {
        const absolute = resolveAgentPath(path);
        return guest.makeDirectory(posix.dirname(absolute)).pipe(
          Effect.andThen(guest.writeFile(absolute, content)),
        );
      }),
    appendFile: unsupported,
    truncateFile: unsupported,
    flushFile: unsupported,
    renameFile: (source, destination, context) =>
      perform(
        context,
        () => guest.renameFile(resolveAgentPath(source), resolveAgentPath(destination)),
      ),
    fileInfo: (path, context) => perform(context, () => fileInfo(resolveAgentPath(path))),
    listDir: (path, context) =>
      perform(context, () => {
        const absolute = resolveAgentPath(path);
        return guest.listDirectory(absolute).pipe(
          Effect.flatMap((names) =>
            Effect.forEach(names, (name) => fileInfo(posix.join(absolute, name)))
          ),
        );
      }),
    exists: (path, context) =>
      perform(context, () =>
        guest.run(["/usr/bin/test", "-e", resolveAgentPath(path)], {
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        }).pipe(Effect.flatMap(({ exitCode }) =>
          exitCode === 0 || exitCode === 1
            ? Effect.succeed(exitCode === 0)
            : Effect.fail(new FileError("unknown", "Guest existence check failed", path))
        ))),
    canonicalPath: unsupported,
    createDir: (path, options, context) =>
      perform(context, () => guest.makeDirectory(resolveAgentPath(path), options)),
    remove: (path, options, context) =>
      perform(context, () => guest.remove(resolveAgentPath(path), options)),
    createTempDir: unsupported,
    createTempFile: unsupported,
    openTextLineReader: unsupported,
    readTextLines: unsupported,
    // The backend has neither paged directory handles nor change notifications.
    openDirReader: unsupported,
    watch: unsupported,
    async exec(command, options, context) {
      const timeout = options?.timeout;
      if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) {
        return err(
          new ExecutionError("unknown", "Bash requires a finite timeout of 0 < seconds <= 86400"),
        );
      }
      if (
        (options?.env !== undefined && Object.keys(options.env).length > 0) ||
        options?.inheritEnv === false || options?.spill
      ) {
        return err(new ExecutionError("unknown", "Execution options not exposed by Gondolin"));
      }
      if (
        !Schema.is(Schema.String)(command) && (command.length === 0 || !command[0]?.startsWith("/"))
      ) {
        return err(new ExecutionError("spawn_error", "Guest argv requires an absolute executable"));
      }
      const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
      const [result, error] = await tryAsync(
        (async () => {
          context.abortSignal?.throwIfAborted();
          using cleanup = new DisposableStack();
          cleanup.defer(() => {
            for (const stream of ["stdout", "stderr"] as const) {
              const tail = decoders[stream].decode();
              if (tail) options?.onOutput?.(tail, context, { stream });
            }
          });
          // Gondolin starts command deadlines after readiness. Output is streamed, not spooled.
          const result = await Effect.runPromise(
            guest.runShell(command, {
              cwd: resolveAgentPath(options?.cwd ?? env.cwd),
              timeoutSeconds: timeout,
              ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
              onOutput: (bytes, stream) =>
                Effect.sync(() =>
                  options?.onOutput?.(decoders[stream].decode(bytes), context, { stream })
                ),
            }),
            { signal: context.abortSignal },
          );
          context.abortSignal?.throwIfAborted();
          return result;
        })(),
        (cause) =>
          new ExecutionError(
            context.abortSignal?.aborted ? "aborted" : "unknown",
            "Guest command failed",
            cause instanceof Error ? cause : undefined,
          ),
      );
      if (error !== undefined) return err(error);
      return ok(result);
    },
    cleanup: () => Promise.resolve(),
  };
  return env;
}
