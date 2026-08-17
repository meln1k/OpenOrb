import { basename, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { RealFSProvider, VM } from "@earendil-works/gondolin";
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
} from "@/src/github-mediation.ts";
import { installGondolinTlsCompatibility } from "@/src/gondolin-tls-compatibility.ts";

export const OPENORB_GUEST_MARKER = "OPENORB_GUEST";

const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface OpenOrbGondolinToolRuntimeOptions {
  workspacePath: string;
  developerImage: DeveloperImage;
  sessionLabel?: string;
  github?: OpenOrbGitHubMediationOptions;
}

interface RunningVm {
  vm: VM;
  shellPath: string;
}

export interface OpenOrbGondolinToolRuntime {
  readonly tools: readonly ToolDefinition[];
  close(): Promise<void>;
}

export async function createOpenOrbGondolinToolRuntime(
  options: OpenOrbGondolinToolRuntimeOptions,
): Promise<OpenOrbGondolinToolRuntime> {
  const workspace = await Deno.lstat(options.workspacePath);
  if (!workspace.isDirectory || workspace.isSymlink) {
    throw new Error("The Gondolin workspace must be a real host directory.");
  }

  const runtime = new GondolinToolRuntime(
    await Deno.realPath(options.workspacePath),
    options.developerImage,
    options.sessionLabel,
    options.github,
  );
  await runtime.start();
  return runtime;
}

export function resolveGuestWorkspacePath(inputPath: string): string {
  if (inputPath.includes("\0")) throw new Error("Workspace paths must not contain NUL bytes.");

  let normalized = inputPath.replace(PI_UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~" || normalized.startsWith("~/")) {
    throw new Error(`Path must remain within ${OPENORB_GUEST_WORKSPACE}.`);
  }
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  if (normalized.includes("\0")) {
    throw new Error("Workspace paths must not contain NUL bytes.");
  }

  const resolved = posix.isAbsolute(normalized)
    ? posix.resolve(normalized)
    : posix.resolve(OPENORB_GUEST_WORKSPACE, normalized);
  if (
    resolved !== OPENORB_GUEST_WORKSPACE &&
    !resolved.startsWith(`${OPENORB_GUEST_WORKSPACE}/`)
  ) {
    throw new Error(`Path must remain within ${OPENORB_GUEST_WORKSPACE}.`);
  }
  return resolved;
}

class GondolinToolRuntime implements OpenOrbGondolinToolRuntime {
  readonly tools: readonly ToolDefinition[];

  readonly #workspacePath: string;
  readonly #developerImage: DeveloperImage;
  readonly #sessionLabel: string;
  readonly #github?: OpenOrbGitHubMediationOptions;
  #running?: RunningVm;
  #starting?: Promise<RunningVm>;
  #cleanup?: Promise<void>;
  #closePromise?: Promise<void>;
  #closed = false;

  constructor(
    workspacePath: string,
    developerImage: DeveloperImage,
    sessionLabel?: string,
    github?: OpenOrbGitHubMediationOptions,
  ) {
    this.#workspacePath = workspacePath;
    this.#developerImage = developerImage;
    this.#sessionLabel = sessionLabel ?? `openorb ${basename(workspacePath)}`;
    this.#github = github;
    this.tools = createTools(this);
  }

  async start(): Promise<void> {
    await this.getVm();
  }

  async getVm(): Promise<RunningVm> {
    if (this.#closed) throw new Error("The Gondolin tool runtime is closed.");
    if (this.#cleanup) await this.#cleanup;
    if (this.#running) return this.#running;

    if (!this.#starting) {
      const starting = this.#startVm();
      this.#starting = starting;
      void starting.finally(() => {
        if (this.#starting === starting) this.#starting = undefined;
      }).catch(() => undefined);
    }
    return await this.#starting;
  }

  async discard(running: RunningVm): Promise<void> {
    if (this.#running !== running) return;
    this.#running = undefined;
    const cleanup = running.vm.close();
    this.#cleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.#cleanup === cleanup) this.#cleanup = undefined;
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    try {
      await this.#starting;
    } catch {
      // A failed or concurrently cancelled startup has no active VM to retain.
    }
    await this.#cleanup;

    const running = this.#running;
    this.#running = undefined;
    if (running) await running.vm.close();
  }

  async #startVm(): Promise<RunningVm> {
    const imagePath = await prepareDeveloperImageForVm(this.#developerImage);
    const githubOptions = this.#github ? createOpenOrbGitHubVmOptions(this.#github) : undefined;
    if (githubOptions) installGondolinTlsCompatibility();
    const vm = await VM.create({
      sessionLabel: this.#sessionLabel,
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

    try {
      const shellProbe = await vm.exec(["/bin/sh", "-lc", "command -v bash || true"]);
      const running = { vm, shellPath: shellProbe.stdout.trim() || "/bin/sh" };
      if (this.#closed) {
        throw new Error("The Gondolin tool runtime was closed during startup.");
      }
      this.#running = running;
      return running;
    } catch (error) {
      await vm.close();
      throw error;
    }
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
  const edit = {
    ...createEditToolDefinition(OPENORB_GUEST_WORKSPACE, {
      operations: editOperations,
    }),
    // Pi's edit preview renderer reads files directly from the runner host.
    renderCall: undefined,
  };
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
    if (signal?.aborted) throw new Error("Operation aborted");
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
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
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
      const { vm } = await runtime.getVm();
      return await vm.fs.readFile(resolveGuestWorkspacePath(filePath));
    },
    async access(filePath) {
      const { vm } = await runtime.getVm();
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
      const { vm } = await runtime.getVm();
      await vm.fs.writeFile(resolveGuestWorkspacePath(filePath), content, { encoding: "utf8" });
    },
    async mkdir(directoryPath) {
      const { vm } = await runtime.getVm();
      await vm.fs.mkdir(resolveGuestWorkspacePath(directoryPath), { recursive: true });
    },
  };
}

function createBashOperations(runtime: GondolinToolRuntime): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (signal?.aborted) throw new Error("aborted");
      const running = await runtime.getVm();
      if (signal?.aborted) throw new Error("aborted");
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

      try {
        const process = running.vm.exec([running.shellPath, "-lc", command], {
          cwd: resolveGuestWorkspacePath(cwd),
          // Never copy Pi's host process environment into the untrusted guest.
          env: { [OPENORB_GUEST_MARKER]: "1" },
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of process.output()) onData(chunk.data);
        const result = await process;
        return { exitCode: result.exitCode };
      } catch (error) {
        await runtime.discard(running);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
