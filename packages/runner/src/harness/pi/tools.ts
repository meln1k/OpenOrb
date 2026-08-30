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
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { posix } from "node:path";

import {
  AGENT_WORKSPACE,
  type AgentEnvironment,
  AgentEnvironmentError,
  resolveAgentPath,
} from "../../environment/agent-environment.ts";
import { executePiEdit } from "./edit.ts";

export function createPiTools(environment: AgentEnvironment): readonly ToolDefinition[] {
  const readOperations = createReadOperations(environment);
  const writeOperations = createWriteOperations(environment);
  const withFileMutation = createFileMutationQueue();
  const editOperations: EditOperations = {
    readFile: readOperations.readFile,
    writeFile: writeOperations.writeFile,
    access: readOperations.access,
  };
  const read = createReadToolDefinition(AGENT_WORKSPACE, { operations: readOperations });
  const write = createWriteToolDefinition(AGENT_WORKSPACE, { operations: writeOperations });
  const edit = createEditToolDefinition(AGENT_WORKSPACE, {
    operations: editOperations,
  });
  const bash = createBashToolDefinition(AGENT_WORKSPACE, {
    operations: createBashOperations(environment),
    exposeSessionEnvironment: false,
  });

  return [
    defineTool({
      ...read,
      execute(_id, params, signal, _onUpdate, context) {
        return executePiRead(
          readOperations,
          { ...params, path: resolveAgentPath(params.path) },
          signal,
          context.model?.input.includes("image") ?? true,
        );
      },
    }),
    defineTool({
      ...write,
      execute(_id, params, signal) {
        const resolvedParams = { ...params, path: resolveAgentPath(params.path) };
        return withFileMutation(
          resolvedParams.path,
          () => executePiWrite(writeOperations, resolvedParams, signal),
        );
      },
    }),
    defineTool({
      ...edit,
      execute(_id, params, signal) {
        const resolvedParams = { ...params, path: resolveAgentPath(params.path) };
        return withFileMutation(
          resolvedParams.path,
          () => executePiEdit(editOperations, resolvedParams, signal),
        );
      },
      // Pi falls back to its built-in edit renderer by tool name. Keep that renderer for
      // display, but never mark arguments complete because its preview reads the host filesystem.
      renderCall(args, theme, context) {
        return edit.renderCall!(args, theme, { ...context, argsComplete: false });
      },
    }),
    defineTool(bash),
  ];
}

type FileMutationQueue = <A>(path: string, mutation: () => Promise<A>) => Promise<A>;

function createFileMutationQueue(): FileMutationQueue {
  const queues = new Map<string, Promise<void>>();
  return async <A>(path: string, mutation: () => Promise<A>): Promise<A> => {
    const current = queues.get(path) ?? Promise.resolve();
    const next = Promise.withResolvers<void>();
    const chained = current.then(() => next.promise);
    queues.set(path, chained);
    await current;
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      next.resolve();
      if (queues.get(path) === chained) queues.delete(path);
    });
    return await mutation();
  };
}

// Pi's built-in read executor probes candidate paths with node:fs before calling custom
// operations. Reimplement the executor so agent-controlled paths never touch the runner host,
// while preserving Pi's image, offset, and truncation behavior.
async function executePiRead(
  operations: ReadOperations,
  { path, offset, limit }: ReadToolInput,
  signal: AbortSignal | undefined,
  supportsImages: boolean,
): Promise<AgentToolResult<ReadToolDetails | undefined>> {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new AgentEnvironmentError("Operation aborted.", signal.reason);
    }
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
    throw new AgentEnvironmentError(
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

async function executePiWrite(
  operations: WriteOperations,
  { path, content }: WriteToolInput,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<undefined>> {
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new AgentEnvironmentError("Operation aborted.", signal.reason);
    }
  };

  throwIfAborted();
  await operations.mkdir(posix.dirname(path));
  throwIfAborted();
  await operations.writeFile(path, content);
  throwIfAborted();
  return {
    content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
    details: undefined,
  };
}

function createReadOperations(environment: AgentEnvironment): ReadOperations {
  return {
    readFile: (path) =>
      Effect.runPromise(environment.readFile(resolveAgentPath(path))).then((bytes) =>
        Buffer.from(bytes)
      ),
    access: (path) => Effect.runPromise(environment.access(resolveAgentPath(path))),
    detectImageMimeType: (path) =>
      Effect.runPromise(environment.detectImageMimeType(resolveAgentPath(path))),
  };
}

function createWriteOperations(environment: AgentEnvironment): WriteOperations {
  return {
    writeFile: (path, content) =>
      Effect.runPromise(environment.writeFile(resolveAgentPath(path), content)),
    mkdir: (path) => Effect.runPromise(environment.makeDirectory(resolveAgentPath(path))),
  };
}

function createBashOperations(environment: AgentEnvironment): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      Effect.runPromise(environment.runShell(command, {
        cwd: resolveAgentPath(cwd),
        ...(signal === undefined ? {} : { signal }),
        ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
        onOutput: (data) => Effect.sync(() => onData(Buffer.from(data))),
      })),
  };
}
