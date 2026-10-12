import {
  err,
  type ExecutionEnv,
  ExecutionError,
  type ExecutionErrorCode,
  FileError,
  type FileErrorCode,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";

/**
 * The native RPC between the Session Durable Object and its sandbox facet. It carries Pi's
 * ExecutionEnv calls; paths cross it as opaque strings and are interpreted only in the sandbox.
 */

/** ExecutionEnv operations that return a plain Result. */
export const FILE_METHODS = [
  "absolutePath",
  "joinPath",
  "readTextFile",
  "readTextLines",
  "readBinaryFile",
  "writeFile",
  "appendFile",
  "truncateFile",
  "flushFile",
  "renameFile",
  "fileInfo",
  "listDir",
  "canonicalPath",
  "exists",
  "createDir",
  "remove",
  "createTempDir",
  "createTempFile",
] as const satisfies readonly (keyof ExecutionEnv)[];
export type FileMethod = (typeof FILE_METHODS)[number];

/** ExecutionEnv operations that open a reader, which stays in the sandbox behind a handle. */
export const READER_METHODS = {
  openBinaryReader: ["info", "read", "scanLines", "close"],
  openTextLineReader: ["readLine", "close"],
  openDirReader: ["next", "close"],
} as const;
export type ReaderMethod = keyof typeof READER_METHODS;

export interface WireError {
  readonly kind: "file" | "execution";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly spillPath?: string;
}

export type WireResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WireError };

export type WireExecOptions = Omit<ShellExecOptions, "onOutput" | "window">;

export interface WireExecResult {
  readonly result: WireResult<ShellExecResult>;
  /** Output in arrival order; just-bash reports it when the command finishes. */
  readonly output: readonly (readonly ["stdout" | "stderr", string])[];
}

/** The sandbox facet's RPC surface. */
export interface SandboxRpc {
  file(cwd: string, method: FileMethod, args: readonly unknown[]): Promise<WireResult<unknown>>;
  /** Opens a reader and returns its handle, random so it never names a reader after a restart. */
  open(cwd: string, method: ReaderMethod, args: readonly unknown[]): Promise<WireResult<string>>;
  reader(handle: string, method: string, args: readonly unknown[]): Promise<WireResult<unknown>>;
  exec(
    id: string,
    cwd: string,
    command: string | readonly string[],
    options: WireExecOptions,
  ): Promise<WireExecResult>;
  cancel(id: string): void;
  cleanup(): Promise<void>;
}

const FILE_ERROR_CODES: readonly FileErrorCode[] = [
  "aborted",
  "not_found",
  "permission_denied",
  "not_directory",
  "is_directory",
  "invalid",
  "not_supported",
  "unknown",
];
const EXECUTION_ERROR_CODES: readonly ExecutionErrorCode[] = [
  "aborted",
  "timeout",
  "shell_unavailable",
  "spawn_error",
  "callback_error",
  "unknown",
];

/** Pi's error classes do not survive RPC; results cross it as plain data. */
export function encodeResult<T>(result: Result<T, FileError | ExecutionError>): WireResult<T> {
  if (result.ok) return { ok: true, value: result.value };
  const { error } = result;
  return {
    ok: false,
    error: {
      kind: error instanceof ExecutionError ? "execution" : "file",
      code: error.code,
      message: error.message,
      ...("path" in error && error.path !== undefined ? { path: error.path } : {}),
      ...("spillPath" in error && error.spillPath !== undefined
        ? { spillPath: error.spillPath }
        : {}),
    },
  };
}

export function decodeFileResult<T>(result: WireResult<T>): Result<T, FileError> {
  if (result.ok) return ok(result.value);
  const { code, message, path } = result.error;
  const known = FILE_ERROR_CODES.find((candidate) => candidate === code);
  return err(new FileError(known ?? "unknown", message, path));
}

export function decodeExecResult<T>(result: WireResult<T>): Result<T, ExecutionError> {
  if (result.ok) return ok(result.value);
  const { code, message, spillPath } = result.error;
  const known = EXECUTION_ERROR_CODES.find((candidate) => candidate === code);
  const error = new ExecutionError(known ?? "unknown", message);
  if (spillPath !== undefined) error.spillPath = spillPath;
  return err(error);
}
