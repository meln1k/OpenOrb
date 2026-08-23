import { basename, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { RealFSProvider, VM } from "@earendil-works/gondolin";
import { err, ok, type Result, tryAsync } from "@openorb/result";
import {
  type AgentToolResult,
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  defineTool,
  type EditOperations,
  formatSize,
  type ReadOperations,
  type ReadToolDetails,
  type ReadToolInput,
  type ToolDefinition,
  truncateHead,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import { OPENORB_GUEST_WORKSPACE } from "@/src/pi-session-factory.ts";
import { type DeveloperImage, prepareDeveloperImageForVm } from "@/src/developer-image.ts";
import {
  createOpenOrbGitHubVmOptions,
  type OpenOrbGitHubMediationOptions,
  type OpenOrbGitHubVmOptions,
} from "@/src/github-mediation.ts";
import { installGondolinTlsCompatibility } from "@/src/gondolin-tls-compatibility.ts";

export const OPENORB_GUEST_MARKER = "OPENORB_GUEST";

const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface OpenOrbGondolinToolRuntimeOptions {
  workspacePath: string;
  developerImage: DeveloperImage;
  sessionLabel?: string;
  github?: OpenOrbGitHubMediationOptions;
  cpuCount?: number;
  memoryMiB?: number;
}

interface RunningVm {
  vm: VM;
  shellPath: string;
}

export interface OpenOrbGondolinToolRuntime {
  readonly tools: readonly ToolDefinition[];
  run(
    command: string[],
    options?: OpenOrbGuestCommandOptions,
  ): Promise<Result<OpenOrbGuestCommandResult, GondolinRuntimeError>>;
  close(): Promise<Result<void, GondolinRuntimeError>>;
}

export interface OpenOrbGuestCommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  onOutput?: (output: { stream: "stdout" | "stderr"; text: string }) => void | Promise<void>;
}

export interface OpenOrbGuestCommandResult {
  exitCode: number;
}

export async function createOpenOrbGondolinToolRuntime(
  options: OpenOrbGondolinToolRuntimeOptions,
): Promise<Result<OpenOrbGondolinToolRuntime, GondolinRuntimeError>> {
  const [workspace, inspectionError] = await tryAsync(
    Deno.lstat(options.workspacePath),
    (cause) => new GondolinRuntimeError("The Gondolin workspace could not be inspected.", cause),
  );
  if (inspectionError !== undefined) return err(inspectionError);
  if (!workspace.isDirectory || workspace.isSymlink) {
    return err(
      new GondolinRuntimeError(
        "The Gondolin workspace must be a real host directory.",
        undefined,
      ),
    );
  }

  const [runtime, creationError] = await tryAsync(
    (async () => {
      return new GondolinToolRuntime(
        await Deno.realPath(options.workspacePath),
        options.developerImage,
        options.sessionLabel,
        options.github,
        options.cpuCount,
        options.memoryMiB,
      );
    })(),
    (cause) => new GondolinRuntimeError("The Gondolin runtime could not be created.", cause),
  );
  if (creationError !== undefined) return err(creationError);
  const [, startError] = await runtime.start();
  if (startError !== undefined) return err(startError);
  return ok(runtime);
}

export function resolveGuestWorkspacePath(inputPath: string): string {
  if (inputPath.includes("\0")) {
    throw new GondolinRuntimeError("Workspace paths must not contain NUL bytes.", undefined);
  }

  let normalized = inputPath.replace(PI_UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~" || normalized.startsWith("~/")) {
    throw new GondolinRuntimeError(
      `Path must remain within ${OPENORB_GUEST_WORKSPACE}.`,
      undefined,
    );
  }
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  if (normalized.includes("\0")) {
    throw new GondolinRuntimeError("Workspace paths must not contain NUL bytes.", undefined);
  }

  const resolved = posix.isAbsolute(normalized)
    ? posix.resolve(normalized)
    : posix.resolve(OPENORB_GUEST_WORKSPACE, normalized);
  if (
    resolved !== OPENORB_GUEST_WORKSPACE &&
    !resolved.startsWith(`${OPENORB_GUEST_WORKSPACE}/`)
  ) {
    throw new GondolinRuntimeError(
      `Path must remain within ${OPENORB_GUEST_WORKSPACE}.`,
      undefined,
    );
  }
  return resolved;
}

class GondolinToolRuntime implements OpenOrbGondolinToolRuntime {
  readonly tools: readonly ToolDefinition[];

  readonly #workspacePath: string;
  readonly #developerImage: DeveloperImage;
  readonly #sessionLabel: string;
  readonly #github: OpenOrbGitHubMediationOptions | undefined;
  readonly #cpuCount: number | undefined;
  readonly #memoryMiB: number | undefined;
  #running: RunningVm | undefined;
  #starting: Promise<Result<RunningVm, GondolinRuntimeError>> | undefined;
  #cleanup: Promise<Result<void, GondolinRuntimeError>> | undefined;
  #closePromise?: Promise<Result<void, GondolinRuntimeError>>;
  #closed = false;

  constructor(
    workspacePath: string,
    developerImage: DeveloperImage,
    sessionLabel?: string,
    github?: OpenOrbGitHubMediationOptions,
    cpuCount?: number,
    memoryMiB?: number,
  ) {
    this.#workspacePath = workspacePath;
    this.#developerImage = developerImage;
    this.#sessionLabel = sessionLabel ?? `openorb ${basename(workspacePath)}`;
    this.#github = github;
    this.#cpuCount = cpuCount;
    this.#memoryMiB = memoryMiB;
    this.tools = createTools(this);
  }

  async start(): Promise<Result<void, GondolinRuntimeError>> {
    const [, startError] = await this.getVm();
    if (startError !== undefined) return err(startError);
    return ok(undefined);
  }

  async getVm(): Promise<Result<RunningVm, GondolinRuntimeError>> {
    if (this.#closed) {
      return err(new GondolinRuntimeError("The Gondolin tool runtime is closed.", undefined));
    }
    if (this.#cleanup) {
      const [, cleanupError] = await this.#cleanup;
      if (cleanupError !== undefined) return err(cleanupError);
    }
    if (this.#running) return ok(this.#running);

    if (!this.#starting) {
      const starting = this.#startVm();
      this.#starting = starting;
      void starting.finally(() => {
        if (this.#starting === starting) this.#starting = undefined;
      });
    }
    return await this.#starting;
  }

  async getVmForTool(): Promise<RunningVm> {
    const [running, startError] = await this.getVm();
    if (startError !== undefined) throw startError;
    return running;
  }

  async discard(running: RunningVm): Promise<Result<void, GondolinRuntimeError>> {
    if (this.#running !== running) return ok(undefined);
    this.#running = undefined;
    const cleanup = tryAsync(
      running.vm.close(),
      (cause) => new GondolinRuntimeError("The Gondolin VM could not be discarded.", cause),
    );
    this.#cleanup = cleanup;
    const [value, cleanupError] = await cleanup;
    if (cleanupError !== undefined) {
      if (this.#cleanup === cleanup) this.#cleanup = undefined;
      return err(cleanupError);
    }
    if (this.#cleanup === cleanup) this.#cleanup = undefined;
    return ok(value);
  }

  async run(
    command: string[],
    options: OpenOrbGuestCommandOptions = {},
  ): Promise<Result<OpenOrbGuestCommandResult, GondolinRuntimeError>> {
    if (command.length === 0 || !command[0]?.startsWith("/")) {
      return err(
        new GondolinRuntimeError("Guest commands require an absolute executable path.", undefined),
      );
    }
    if (options.signal?.aborted) {
      return err(new GondolinRuntimeError("Command aborted.", options.signal.reason));
    }
    const [running, startError] = await this.getVm();
    if (startError !== undefined) return err(startError);
    if (options.signal?.aborted) {
      return err(new GondolinRuntimeError("Command aborted.", options.signal.reason));
    }

    let observerFailed = false;
    let observerError: GondolinRuntimeError | undefined;
    const [exitCode, commandError] = await tryAsync(
      (async () => {
        const process = running.vm.exec(command, {
          cwd: options.cwd === undefined
            ? OPENORB_GUEST_WORKSPACE
            : resolveGuestWorkspacePath(options.cwd),
          env: { [OPENORB_GUEST_MARKER]: "1" },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of process.output()) {
          if (!observerFailed && options.onOutput) {
            const [, outputError] = await tryAsync(
              Promise.resolve().then(() =>
                options.onOutput?.({ stream: chunk.stream, text: chunk.text })
              ),
              (cause) => new GondolinRuntimeError("Guest command output handling failed.", cause),
            );
            if (outputError !== undefined) {
              observerFailed = true;
              observerError = outputError;
              continue;
            }
          }
        }
        return (await process).exitCode;
      })(),
      (cause) => new GondolinRuntimeError("Guest command execution failed.", cause),
    );
    if (commandError !== undefined) {
      const [, discardError] = await this.discard(running);
      if (discardError !== undefined) return err(discardError);
      if (options.signal?.aborted) {
        return err(new GondolinRuntimeError("Command aborted.", options.signal.reason));
      }
      return err(commandError);
    }
    if (observerFailed && observerError !== undefined) return err(observerError);
    return ok({ exitCode: exitCode! });
  }

  close(): Promise<Result<void, GondolinRuntimeError>> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<Result<void, GondolinRuntimeError>> {
    if (this.#closed) return ok(undefined);
    this.#closed = true;

    if (this.#starting) await this.#starting;
    if (this.#cleanup) {
      const [, cleanupError] = await this.#cleanup;
      if (cleanupError !== undefined) return err(cleanupError);
    }

    const running = this.#running;
    this.#running = undefined;
    if (!running) return ok(undefined);
    return await tryAsync(
      running.vm.close(),
      (cause) => new GondolinRuntimeError("The Gondolin VM could not be closed.", cause),
    );
  }

  async #startVm(): Promise<Result<RunningVm, GondolinRuntimeError>> {
    const [imagePath, imageError] = await prepareDeveloperImageForVm(this.#developerImage);
    if (imageError !== undefined) {
      return err(
        new GondolinRuntimeError("The developer image could not be prepared.", imageError),
      );
    }
    let githubOptions: OpenOrbGitHubVmOptions | undefined;
    if (this.#github) {
      const [options, githubError] = createOpenOrbGitHubVmOptions(this.#github);
      if (githubError !== undefined) {
        return err(
          new GondolinRuntimeError("GitHub mediation could not be configured.", githubError),
        );
      }
      githubOptions = options;
    }
    const [vm, creationError] = await tryAsync(
      Promise.resolve().then(() => {
        if (githubOptions) installGondolinTlsCompatibility();
        return VM.create({
          sessionLabel: this.#sessionLabel,
          ...(this.#cpuCount === undefined ? {} : { cpus: this.#cpuCount }),
          ...(this.#memoryMiB === undefined ? {} : { memory: `${this.#memoryMiB}M` }),
          rootfs: { mode: "cow" },
          ...githubOptions,
          sandbox: {
            imagePath,
          },
          vfs: {
            mounts: {
              [OPENORB_GUEST_WORKSPACE]: new RealFSProvider(this.#workspacePath),
            },
          },
        });
      }),
      (cause) => new GondolinRuntimeError("The Gondolin VM could not be created.", cause),
    );
    if (creationError !== undefined) return err(creationError);

    const [running, probeError] = await tryAsync(
      (async () => {
        const shellProbe = await vm.exec(["/bin/sh", "-lc", "command -v bash || true"]);
        const running = { vm, shellPath: shellProbe.stdout.trim() || "/bin/sh" };
        if (this.#closed) {
          throw new GondolinRuntimeError(
            "The Gondolin tool runtime was closed during startup.",
            undefined,
          );
        }
        this.#running = running;
        return running;
      })(),
      (cause) => new GondolinRuntimeError("The Gondolin VM shell probe failed.", cause),
    );
    if (probeError !== undefined) {
      const [, closeError] = await tryAsync(
        vm.close(),
        (cause) => new GondolinRuntimeError("The failed Gondolin VM could not be closed.", cause),
      );
      if (closeError !== undefined) return err(closeError);
      return err(probeError);
    }
    return ok(running);
  }
}

export class GondolinRuntimeError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "GondolinRuntimeError";
  }
}

function createTools(runtime: GondolinToolRuntime): readonly ToolDefinition[] {
  const readOperations = createReadOperations(runtime);
  const writeOperations = createWriteOperations(runtime);
  const editOperations: EditOperations = {
    readFile: readOperations.readFile,
    writeFile: writeOperations.writeFile,
    access: readOperations.access,
  };

  const read = createReadToolDefinition(OPENORB_GUEST_WORKSPACE, {
    operations: readOperations,
  });
  const write = createWriteToolDefinition(OPENORB_GUEST_WORKSPACE, {
    operations: writeOperations,
  });
  // Pi's edit preview renderer reads files directly from the runner host.
  const { renderCall: _renderCall, ...edit } = createEditToolDefinition(
    OPENORB_GUEST_WORKSPACE,
    { operations: editOperations },
  );
  const bash = createBashToolDefinition(OPENORB_GUEST_WORKSPACE, {
    operations: createBashOperations(runtime),
    exposeSessionEnvironment: false,
  });

  return [
    defineTool({
      ...read,
      execute(_id, params, signal, _onUpdate, context) {
        const path = resolveGuestWorkspacePath(params.path);
        return executeGondolinRead(
          readOperations,
          { ...params, path },
          signal,
          context.model?.input.includes("image") ?? true,
        );
      },
    }),
    defineTool({
      ...write,
      execute(id, params, signal, onUpdate, context) {
        const path = resolveGuestWorkspacePath(params.path);
        return write.execute(id, { ...params, path }, signal, onUpdate, context);
      },
    }),
    defineTool({
      ...edit,
      execute(id, params, signal, onUpdate, context) {
        const path = resolveGuestWorkspacePath(params.path);
        return edit.execute(id, { ...params, path }, signal, onUpdate, context);
      },
    }),
    defineTool(bash),
  ];
}

async function executeGondolinRead(
  operations: ReadOperations,
  { path, offset, limit }: ReadToolInput,
  signal: AbortSignal | undefined,
  supportsImages: boolean,
): Promise<AgentToolResult<ReadToolDetails | undefined>> {
  const throwIfAborted = () => {
    if (signal?.aborted) throw new GondolinRuntimeError("Operation aborted.", signal.reason);
  };

  throwIfAborted();
  await operations.access(path);
  throwIfAborted();
  const mimeType = await operations.detectImageMimeType?.(path);
  const buffer = await operations.readFile(path);
  throwIfAborted();

  if (mimeType) {
    let text = `Read image file [${mimeType}]`;
    if (!supportsImages) {
      text +=
        "\n[Current model does not support images. The image will be omitted from this request.]";
    }
    return {
      content: [
        { type: "text", text },
        { type: "image", data: buffer.toString("base64"), mimeType },
      ],
      details: undefined,
    };
  }

  const allLines = buffer.toString("utf-8").split("\n");
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    throw new GondolinRuntimeError(
      `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
      undefined,
    );
  }

  const endLine = limit === undefined
    ? allLines.length
    : Math.min(startLine + limit, allLines.length);
  const selectedContent = allLines.slice(startLine, endLine).join("\n");
  const truncation = truncateHead(selectedContent);
  let outputText = truncation.content;
  let details: ReadToolDetails | undefined;

  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${
      formatSize(DEFAULT_MAX_BYTES)
    } limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText += truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}. Use offset=${nextOffset} to continue.]`
      : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length} (${
        formatSize(DEFAULT_MAX_BYTES)
      } limit). Use offset=${nextOffset} to continue.]`;
    details = { truncation };
  } else if (limit !== undefined && endLine < allLines.length) {
    const remaining = allLines.length - endLine;
    outputText += `\n\n[${remaining} more lines in file. Use offset=${endLine + 1} to continue.]`;
  }

  return { content: [{ type: "text", text: outputText }], details };
}

function createReadOperations(runtime: GondolinToolRuntime): ReadOperations {
  return {
    async readFile(filePath) {
      const { vm } = await runtime.getVmForTool();
      return await vm.fs.readFile(resolveGuestWorkspacePath(filePath));
    },
    async access(filePath) {
      const { vm } = await runtime.getVmForTool();
      await vm.fs.access(resolveGuestWorkspacePath(filePath));
    },
    detectImageMimeType(filePath) {
      const extension = posix.extname(resolveGuestWorkspacePath(filePath)).toLowerCase();
      if (extension === ".png") return Promise.resolve("image/png");
      if (extension === ".jpg" || extension === ".jpeg") {
        return Promise.resolve("image/jpeg");
      }
      if (extension === ".gif") return Promise.resolve("image/gif");
      if (extension === ".webp") return Promise.resolve("image/webp");
      return Promise.resolve(null);
    },
  };
}

function createWriteOperations(runtime: GondolinToolRuntime): WriteOperations {
  return {
    async writeFile(filePath, content) {
      const { vm } = await runtime.getVmForTool();
      await vm.fs.writeFile(resolveGuestWorkspacePath(filePath), content, { encoding: "utf8" });
    },
    async mkdir(directoryPath) {
      const { vm } = await runtime.getVmForTool();
      await vm.fs.mkdir(resolveGuestWorkspacePath(directoryPath), { recursive: true });
    },
  };
}

function createBashOperations(runtime: GondolinToolRuntime): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (signal?.aborted) throw new GondolinRuntimeError("Command aborted.", signal.reason);
      const running = await runtime.getVmForTool();
      if (signal?.aborted) throw new GondolinRuntimeError("Command aborted.", signal.reason);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });

      let timedOut = false;
      const timeoutHandle = timeout && timeout > 0
        ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeout * 1000)
        : undefined;
      using cleanup = new DisposableStack();
      cleanup.defer(() => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", abort);
      });

      const [result, commandError] = await tryAsync(
        (async () => {
          const process = running.vm.exec([running.shellPath, "-lc", command], {
            cwd: resolveGuestWorkspacePath(cwd),
            // Never copy Pi's host process environment into the untrusted guest.
            env: { [OPENORB_GUEST_MARKER]: "1" },
            signal: controller.signal,
            stdout: "pipe",
            stderr: "pipe",
          });
          for await (const chunk of process.output()) onData(chunk.data);
          const completed = await process;
          return { exitCode: completed.exitCode };
        })(),
        (cause) => new GondolinRuntimeError("Guest shell command execution failed.", cause),
      );
      if (commandError !== undefined) {
        cleanup.dispose();
        const [, discardError] = await runtime.discard(running);
        if (discardError !== undefined) throw discardError;
        if (signal?.aborted) throw new GondolinRuntimeError("Command aborted.", signal.reason);
        if (timedOut) {
          throw new GondolinRuntimeError(
            `Command timed out after ${timeout} seconds.`,
            commandError,
          );
        }
        throw commandError;
      }
      return result;
    },
  };
}
