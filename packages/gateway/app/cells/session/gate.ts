import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/**
 * The agent's view of the guest. While project setup or resume is in progress, guest operations
 * wait for it, cancellably; otherwise they reach the provider directly and fail immediately when
 * the environment is stopped or unreachable (ADR 0006).
 */
export function gatedExecutionEnv(
  env: ExecutionEnv,
  readiness: () => Promise<void> | undefined,
): ExecutionEnv {
  const ready = (context: Context) => untilAborted(readiness(), context);
  return {
    get id() {
      return env.id;
    },
    get cwd() {
      return env.cwd;
    },
    set cwd(value) {
      env.cwd = value;
    },
    absolutePath: async (path, context) => {
      await ready(context);
      return await env.absolutePath(path, context);
    },
    joinPath: async (parts, context) => {
      await ready(context);
      return await env.joinPath(parts, context);
    },
    readTextFile: async (path, context) => {
      await ready(context);
      return await env.readTextFile(path, context);
    },
    readBinaryFile: async (path, context) => {
      await ready(context);
      return await env.readBinaryFile(path, context);
    },
    openBinaryReader: async (path, options, context) => {
      await ready(context);
      return await env.openBinaryReader(path, options, context);
    },
    openTextLineReader: async (path, context) => {
      await ready(context);
      return await env.openTextLineReader(path, context);
    },
    readTextLines: async (path, options, context) => {
      await ready(context);
      return await env.readTextLines(path, options, context);
    },
    writeFile: async (path, content, context) => {
      await ready(context);
      return await env.writeFile(path, content, context);
    },
    appendFile: async (path, content, context) => {
      await ready(context);
      return await env.appendFile(path, content, context);
    },
    truncateFile: async (path, size, context) => {
      await ready(context);
      return await env.truncateFile(path, size, context);
    },
    flushFile: async (path, context) => {
      await ready(context);
      return await env.flushFile(path, context);
    },
    renameFile: async (source, destination, context) => {
      await ready(context);
      return await env.renameFile(source, destination, context);
    },
    fileInfo: async (path, context) => {
      await ready(context);
      return await env.fileInfo(path, context);
    },
    listDir: async (path, context) => {
      await ready(context);
      return await env.listDir(path, context);
    },
    openDirReader: async (path, context) => {
      await ready(context);
      return await env.openDirReader(path, context);
    },
    canonicalPath: async (path, context) => {
      await ready(context);
      return await env.canonicalPath(path, context);
    },
    exists: async (path, context) => {
      await ready(context);
      return await env.exists(path, context);
    },
    createDir: async (path, options, context) => {
      await ready(context);
      return await env.createDir(path, options, context);
    },
    remove: async (path, options, context) => {
      await ready(context);
      return await env.remove(path, options, context);
    },
    createTempDir: async (prefix, context) => {
      await ready(context);
      return await env.createTempDir(prefix, context);
    },
    createTempFile: async (options, context) => {
      await ready(context);
      return await env.createTempFile(options, context);
    },
    watch: async (targets, onChange, context) => {
      await ready(context);
      return await env.watch(targets, onChange, context);
    },
    exec: async (command, options, context) => {
      await ready(context);
      return await env.exec(command, options, context);
    },
    cleanup: (context) => env.cleanup(context),
  };
}

/** Waits for `pending`, or for cancellation; the wrapped call then reports the abort itself. */
function untilAborted(pending: Promise<void> | undefined, context: Context): Promise<void> {
  if (pending === undefined) return Promise.resolve();
  const signal = context.abortSignal;
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
    pending.then(resolve, resolve);
  });
}
