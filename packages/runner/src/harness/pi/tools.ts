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
import { Type } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { posix } from "node:path";
import type { SessionArtifact, SessionArtifactMediaType } from "@openorb/protocol/runner-bulk-api";
import { MAX_SESSION_ARTIFACT_BYTES } from "@openorb/protocol/runner-api";

import {
  AGENT_WORKSPACE,
  type AgentEnvironment,
  AgentEnvironmentError,
  resolveAgentPath,
} from "../../environment/agent-environment.ts";
import { executePiEdit } from "./edit.ts";

const SESSION_ARTIFACTS_DIRECTORY = `${AGENT_WORKSPACE}/.openorb/artifacts`;

interface PublishSessionMediaInput {
  readonly fileName: string;
  readonly mediaType: SessionArtifactMediaType;
  readonly bytes: Uint8Array;
}

type PublishSessionMedia = (
  input: PublishSessionMediaInput,
) => Promise<SessionArtifact>;

export function createPiTools(
  environment: AgentEnvironment,
  publishSessionMedia?: PublishSessionMedia,
): readonly ToolDefinition[] {
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
  const { prepareArguments: _prepareArguments, ...bashWithoutArgumentPreparation } = bash;
  const boundedBash = defineTool({
    ...bashWithoutArgumentPreparation,
    description: bash.description.replace(
      "Optionally provide a timeout in seconds.",
      "A timeout in seconds is required.",
    ),
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Number({
        description: "Required timeout in seconds",
        exclusiveMinimum: 0,
      }),
    }),
  });

  const tools: ToolDefinition[] = [
    defineTool({
      ...read,
      execute(_id, params, signal, _onUpdate, context) {
        return executePiRead(
          createReadOperations(environment, signal),
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
        const activeEditOperations: EditOperations = {
          ...editOperations,
          readFile: createReadOperations(environment, signal).readFile,
        };
        return withFileMutation(
          resolvedParams.path,
          () => executePiEdit(activeEditOperations, resolvedParams, signal),
        );
      },
      // Pi falls back to its built-in edit renderer by tool name. Keep that renderer for
      // display, but never mark arguments complete because its preview reads the host filesystem.
      renderCall(args, theme, context) {
        return edit.renderCall!(args, theme, { ...context, argsComplete: false });
      },
    }),
    boundedBash,
  ];
  if (publishSessionMedia !== undefined) {
    tools.push(createPublishMediaTool(environment, publishSessionMedia));
  }
  return tools;
}

function createPublishMediaTool(
  environment: AgentEnvironment,
  publish: PublishSessionMedia,
): ToolDefinition {
  return defineTool({
    name: "publish_media",
    label: "Publish media",
    description:
      `Publish an image or video from ${SESSION_ARTIFACTS_DIRECTORY} for durable display in the session transcript.`,
    promptSnippet:
      "Publish a generated image or video for durable display in the session transcript",
    promptGuidelines: [
      `To show the user an image or video, save it under ${SESSION_ARTIFACTS_DIRECTORY}, call publish_media, and include the exact Markdown returned by the tool in your response`,
    ],
    parameters: Type.Object({
      path: Type.String({
        description: `Absolute or workspace-relative path under ${SESSION_ARTIFACTS_DIRECTORY}`,
      }),
      description: Type.String({ description: "Concise accessible description of the media" }),
    }),
    async execute(_id, params, signal) {
      const path = resolveAgentPath(params.path);
      if (!path.startsWith(`${SESSION_ARTIFACTS_DIRECTORY}/`)) {
        throw new AgentEnvironmentError(
          `Published media must be stored under ${SESSION_ARTIFACTS_DIRECTORY}.`,
          undefined,
        );
      }
      const bytes = await Effect.runPromise(environment.readFile(path, {
        ...(signal === undefined ? {} : { signal }),
        maxBytes: MAX_SESSION_ARTIFACT_BYTES,
      }));
      const mediaType = detectSessionMediaType(bytes);
      if (mediaType === null) {
        throw new AgentEnvironmentError(
          "Published media must be PNG, JPEG, GIF, WebP, MP4, or WebM.",
          undefined,
        );
      }
      const artifact = await publish({
        fileName: posix.basename(path),
        mediaType,
        bytes,
      });
      const kind = mediaType.startsWith("image/") ? "image" : "video";
      const description = escapeMarkdownLabel(params.description.trim() || artifact.fileName);
      return {
        content: [{
          type: "text",
          text:
            `Published ${kind} ${artifact.fileName}.\nUse this exact Markdown in your response:\n![${description}](openorb-artifact:${kind}:${artifact.id})`,
        }],
        details: undefined,
      };
    },
  });
}

function detectSessionMediaType(bytes: Uint8Array): SessionArtifactMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  if (asciiAt(bytes, 4, "ftyp")) return "video/mp4";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.byteLength < offset + expected.length) return false;
  return Array.from(expected).every((character, index) =>
    bytes[offset + index] === character.charCodeAt(0)
  );
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
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

function createReadOperations(
  environment: AgentEnvironment,
  signal?: AbortSignal,
): ReadOperations {
  return {
    readFile: (path) =>
      Effect.runPromise(environment.readFile(
        resolveAgentPath(path),
        signal === undefined ? {} : { signal },
      )).then((bytes) => Buffer.from(bytes)),
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
    async exec(command, cwd, { onData, signal, timeout }) {
      if (timeout === undefined) {
        throw new AgentEnvironmentError("Bash timeout is required.", undefined);
      }
      return await Effect.runPromise(environment.runShell(command, {
        cwd: resolveAgentPath(cwd),
        ...(signal === undefined ? {} : { signal }),
        timeoutSeconds: timeout,
        onOutput: (data) => Effect.sync(() => onData(Buffer.from(data))),
      }));
    },
  };
}
