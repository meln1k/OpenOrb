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
import { Effect } from "effect";

import {
  AGENT_WORKSPACE,
  type AgentEnvironment,
  AgentEnvironmentError,
  resolveAgentWorkspacePath,
} from "../../environment/agent-environment.ts";

export function createPiTools(environment: AgentEnvironment): readonly ToolDefinition[] {
  const readOperations = createReadOperations(environment);
  const writeOperations = createWriteOperations(environment);
  const editOperations: EditOperations = {
    readFile: readOperations.readFile,
    writeFile: writeOperations.writeFile,
    access: readOperations.access,
  };
  const read = createReadToolDefinition(AGENT_WORKSPACE, { operations: readOperations });
  const write = createWriteToolDefinition(AGENT_WORKSPACE, { operations: writeOperations });
  // Pi's default edit preview reads directly from the runner host, so it must stay disabled.
  const { renderCall: _renderCall, ...edit } = createEditToolDefinition(AGENT_WORKSPACE, {
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
          { ...params, path: resolveAgentWorkspacePath(params.path) },
          signal,
          context.model?.input.includes("image") ?? true,
        );
      },
    }),
    defineTool({
      ...write,
      execute(id, params, signal, onUpdate, context) {
        return write.execute(
          id,
          { ...params, path: resolveAgentWorkspacePath(params.path) },
          signal,
          onUpdate,
          context,
        );
      },
    }),
    defineTool({
      ...edit,
      execute(id, params, signal, onUpdate, context) {
        return edit.execute(
          id,
          { ...params, path: resolveAgentWorkspacePath(params.path) },
          signal,
          onUpdate,
          context,
        );
      },
    }),
    defineTool(bash),
  ];
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

function createReadOperations(environment: AgentEnvironment): ReadOperations {
  return {
    readFile: (path) =>
      Effect.runPromise(environment.readFile(resolveAgentWorkspacePath(path))).then((bytes) =>
        Buffer.from(bytes)
      ),
    access: (path) => Effect.runPromise(environment.access(resolveAgentWorkspacePath(path))),
    detectImageMimeType: (path) =>
      Effect.runPromise(environment.detectImageMimeType(resolveAgentWorkspacePath(path))),
  };
}

function createWriteOperations(environment: AgentEnvironment): WriteOperations {
  return {
    writeFile: (path, content) =>
      Effect.runPromise(environment.writeFile(resolveAgentWorkspacePath(path), content)),
    mkdir: (path) => Effect.runPromise(environment.makeDirectory(resolveAgentWorkspacePath(path))),
  };
}

function createBashOperations(environment: AgentEnvironment): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      Effect.runPromise(environment.runShell(command, {
        cwd: resolveAgentWorkspacePath(cwd),
        ...(signal === undefined ? {} : { signal }),
        ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
        onOutput: (data) => Effect.sync(() => onData(Buffer.from(data))),
      })),
  };
}
