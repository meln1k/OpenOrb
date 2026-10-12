import type { Context } from "@earendil-works/chord";
import {
  type BinaryReader,
  type DirReader,
  err,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  LineScanner,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { tryAsync, trySync } from "@openorb/result";
import type { Bash } from "just-bash/browser";
import { join } from "@std/path/posix";

const ERROR_CODES = {
  ENOENT: "not_found",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  EINVAL: "invalid",
  EEXIST: "invalid",
  ENOTEMPTY: "invalid",
  ENOSPC: "invalid",
} satisfies Record<string, FileErrorCode>;

/**
 * Pi's ExecutionEnv over one just-bash interpreter and its virtual filesystem. It runs only inside
 * the sandbox isolate, so every untrusted path is interpreted there. just-bash buffers output, so
 * commands report it when they finish. Readers read a snapshot of the file when they are opened.
 * Adapted from pi-celld's JustBashEnv.
 */
export class JustBashEnv implements ExecutionEnv {
  readonly #active: Set<AbortController>;

  constructor(
    readonly id: string,
    readonly bash: Bash,
    public cwd = "/workspace",
    active = new Set<AbortController>(),
  ) {
    this.#active = active;
  }

  /** The same environment seen from another working directory. */
  withCwd(cwd: string): JustBashEnv {
    return new JustBashEnv(this.id, this.bash, cwd, this.#active);
  }

  get #fs() {
    return this.bash.fs;
  }

  #path(path: string): string {
    return this.#fs.resolvePath(this.cwd, path);
  }

  async #file<T>(
    context: Context,
    work: () => Promise<T> | T,
    path?: string,
  ): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted"));
    const [value, failure] = await tryAsync(
      (async () => await work())(),
      (cause) => {
        if (cause instanceof FileError) return cause;
        if (cause instanceof RangeError) return new FileError("invalid", cause.message);
        const message = cause instanceof Error ? cause.message : String(cause);
        // just-bash reports filesystem errors as "ENOENT: no such file or directory, …".
        const name = /^(E[A-Z]+):/.exec(message)?.[1];
        const code = Object.entries(ERROR_CODES).find(([known]) => known === name)?.[1];
        return new FileError(code ?? "unknown", message, path);
      },
    );
    if (failure !== undefined) return err(failure);
    return ok(value);
  }

  absolutePath(path: string, context: Context) {
    return this.#file(context, () => this.#path(path));
  }

  joinPath(parts: string[], context: Context) {
    // A pure join, as on other environments: relative parts stay relative.
    return this.#file(context, () => join(...parts));
  }

  readTextFile(path: string, context: Context) {
    return this.#file(context, () => this.#fs.readFile(this.#path(path)), path);
  }

  readBinaryFile(path: string, context: Context) {
    return this.#file(context, () => this.#fs.readFileBuffer(this.#path(path)), path);
  }

  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.#file(context, () => this.#fs.writeFile(this.#path(path), content), path);
  }

  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.#file(context, () => this.#fs.appendFile(this.#path(path), content), path);
  }

  truncateFile(path: string, size: number, context: Context) {
    return this.#file(context, async () => {
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new FileError("invalid", "Invalid size", path);
      }
      const absolute = this.#path(path);
      const bytes = await this.#fs.readFileBuffer(absolute);
      const resized = new Uint8Array(size);
      resized.set(bytes.subarray(0, size));
      await this.#fs.writeFile(absolute, resized);
    }, path);
  }

  flushFile(path: string, context: Context) {
    // Every write is already in the sandbox's SQLite database when it returns.
    return this.#file(context, async () => {
      await this.#fs.stat(this.#path(path));
    }, path);
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context) {
    return this.#file(
      context,
      () => this.#fs.mv(this.#path(sourcePath), this.#path(destinationPath)),
    );
  }

  async #info(absolute: string): Promise<FileInfo> {
    const stat = await this.#fs.lstat(absolute);
    return {
      name: absolute.slice(absolute.lastIndexOf("/") + 1),
      path: absolute,
      kind: stat.isSymbolicLink ? "symlink" : stat.isDirectory ? "directory" : "file",
      size: stat.size,
      mtimeMs: stat.mtime.getTime(),
    };
  }

  fileInfo(path: string, context: Context) {
    return this.#file(context, () => this.#info(this.#path(path)), path);
  }

  listDir(path: string, context: Context) {
    return this.#file(context, async () => {
      const directory = this.#path(path);
      const names = await this.#fs.readdir(directory);
      return await Promise.all(
        names.map((name) => this.#info(this.#fs.resolvePath(directory, name))),
      );
    }, path);
  }

  openDirReader(path: string, context: Context) {
    return this.#file(context, async (): Promise<DirReader> => {
      const directory = this.#path(path);
      const names = await this.#fs.readdir(directory);
      let offset = 0;
      let closed = false;
      return {
        next: (maxEntries, nextContext) =>
          this.#file(nextContext, async () => {
            if (closed || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
              throw new FileError("invalid", "The directory reader is closed or the page empty.");
            }
            const entries: FileInfo[] = [];
            while (entries.length < maxEntries && offset < names.length) {
              // Entries removed since the reader opened are skipped.
              const entry = this.#fs.resolvePath(directory, names[offset++]!);
              const info = await this.#info(entry).then((value) => value, () => undefined);
              if (info !== undefined) entries.push(info);
            }
            return { entries, done: offset >= names.length };
          }),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      };
    }, path);
  }

  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
    return this.#file(context, async (): Promise<BinaryReader> => {
      const absolute = this.#path(path);
      const link = await this.#fs.lstat(absolute);
      if (options?.noFollow && link.isSymbolicLink) {
        throw new FileError("invalid", "The path is a symbolic link.", path);
      }
      const stat = await this.#fs.stat(absolute);
      if (stat.isDirectory) throw new FileError("is_directory", "The path is a directory.", path);
      if (!stat.isFile) throw new FileError("invalid", "The path is not a regular file.", path);
      const bytes = await this.#fs.readFileBuffer(absolute);
      const info: FileInfo = {
        ...await this.#info(absolute),
        kind: "file",
        size: bytes.byteLength,
      };
      return {
        info: (infoContext) => this.#file(infoContext, () => info),
        read: (offset, length, readContext) =>
          this.#file(readContext, () => {
            if (
              !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
              length < 0
            ) throw new FileError("invalid", "Invalid read range.", path);
            return bytes.slice(offset, offset + length);
          }),
        scanLines: (range, scanContext) =>
          this.#file(scanContext, () => {
            const scanner = new LineScanner(range.startLine, range.endLine);
            scanner.push(bytes);
            return scanner.finish();
          }),
        close: () => Promise.resolve(),
      };
    }, path);
  }

  openTextLineReader(path: string, context: Context) {
    return this.#file(context, async (): Promise<TextLineReader> => {
      const text = await this.#fs.readFile(this.#path(path));
      let offset = 0;
      return {
        readLine: (lineContext) =>
          this.#file(lineContext, () => {
            if (offset >= text.length) return undefined;
            const end = text.indexOf("\n", offset);
            const terminated = end !== -1;
            const line = text.slice(offset, terminated ? end : text.length);
            offset = terminated ? end + 1 : text.length;
            return { text: line, terminated };
          }),
        close: () => Promise.resolve(),
      };
    }, path);
  }

  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.#file(context, async () => {
      const lines = (await this.#fs.readFile(this.#path(path))).split("\n");
      if (lines.at(-1) === "") lines.pop();
      return lines.slice(0, options?.maxLines ?? lines.length);
    }, path);
  }

  watch(): Promise<Result<FileWatcher, FileError>> {
    return Promise.resolve(
      err(new FileError("not_supported", "The sandbox filesystem cannot be watched.")),
    );
  }

  canonicalPath(path: string, context: Context) {
    return this.#file(context, () => this.#fs.realpath(this.#path(path)), path);
  }

  exists(path: string, context: Context) {
    return this.#file(context, () => this.#fs.exists(this.#path(path)), path);
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.#file(context, () => this.#fs.mkdir(this.#path(path), options), path);
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ) {
    return this.#file(context, () => this.#fs.rm(this.#path(path), options), path);
  }

  createTempDir(prefix: string | undefined, context: Context) {
    return this.#file(context, async () => {
      const path = `/tmp/${prefix ?? "pi-"}${crypto.randomUUID()}`;
      await this.#fs.mkdir(path, { recursive: true });
      return path;
    });
  }

  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
    return this.#file(context, async () => {
      await this.#fs.mkdir("/tmp", { recursive: true });
      const path = `/tmp/${options?.prefix ?? "pi-"}${crypto.randomUUID()}${options?.suffix ?? ""}`;
      await this.#fs.writeFile(path, "");
      return path;
    });
  }

  cleanup(): Promise<void> {
    for (const controller of this.#active) controller.abort();
    return Promise.resolve();
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (Array.isArray(command) && command.length === 0) {
      return err(new ExecutionError("spawn_error", "No program was given."));
    }
    const controller = new AbortController();
    this.#active.add(controller);
    using _active = { [Symbol.dispose]: () => this.#active.delete(controller) };
    const timeout = options?.timeout === undefined
      ? undefined
      : AbortSignal.timeout(options.timeout * 1000);
    const signal = AbortSignal.any([
      controller.signal,
      ...(context.abortSignal ? [context.abortSignal] : []),
      ...(timeout ? [timeout] : []),
    ]);
    const stopped = () =>
      new ExecutionError(timeout?.aborted ? "timeout" : "aborted", "The command was stopped.");
    if (signal.aborted) return err(stopped());
    const [result, failure] = await tryAsync(
      this.bash.exec(Array.isArray(command) ? shellWords(command) : String(command), {
        cwd: options?.cwd === undefined ? this.cwd : this.#path(options.cwd),
        ...(options?.env === undefined ? {} : { env: options.env }),
        replaceEnv: options?.inheritEnv === false,
        signal,
        rawScript: true,
      }),
      (cause) =>
        signal.aborted
          ? stopped()
          : new ExecutionError("spawn_error", cause instanceof Error ? cause.message : "failed"),
    );
    if (failure !== undefined) return err(failure);
    const program = Array.isArray(command) ? String(command[0]) : undefined;
    if (result.exitCode === 127 && program && result.stderr.includes(`${program}: `)) {
      return err(new ExecutionError("spawn_error", result.stderr.trim()));
    }
    const [, callbackFailure] = trySync(
      () => {
        if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: "stdout" });
        if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: "stderr" });
      },
      (cause) => new ExecutionError("callback_error", String(cause)),
    );
    if (callbackFailure !== undefined) return err(callbackFailure);
    const spillPath = await this.#spill(result.stdout + result.stderr, options);
    if (signal.aborted) {
      const error = stopped();
      if (spillPath !== undefined) error.spillPath = spillPath;
      return err(error);
    }
    return ok({ exitCode: result.exitCode, ...(spillPath === undefined ? {} : { spillPath }) });
  }

  async #spill(output: string, options: ShellExecOptions | undefined): Promise<string | undefined> {
    const spill = options?.spill;
    if (spill === undefined) return undefined;
    const lines = (output.match(/\n/g)?.length ?? 0) + (output.endsWith("\n") ? 0 : 1);
    if (
      new TextEncoder().encode(output).byteLength <= spill.afterBytes && lines <= spill.afterLines
    ) {
      return undefined;
    }
    const path = `/tmp/pi-output-${crypto.randomUUID()}`;
    await this.#fs.mkdir("/tmp", { recursive: true });
    await this.#fs.writeFile(path, output);
    return path;
  }
}

/**
 * An argument vector as one just-bash command line, every word quoted so it reaches the program
 * unparsed. just-bash has no login shells; a profile could not change anything, so `sh -lc` runs
 * as `sh -c`.
 */
function shellWords(argv: readonly string[]): string {
  const [program, flag, ...rest] = argv;
  const login = /^(?:\/bin\/|\/usr\/bin\/)?(?:ba)?sh$/.test(program ?? "") &&
    (flag === "-lc" || flag === "-cl");
  const words = login ? [program!, "-c", ...rest] : argv;
  return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}
