import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { Effect } from "effect";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { MAX_SESSION_ARTIFACT_BYTES } from "@openorb/protocol/runner-api";
import { AgentEnvironmentError, resolveAgentPath } from "../../environment/agent-environment.ts";
import { detectMediaType, type SessionArtifactStore } from "../../session/artifact-store.ts";
import type { AgentHarnessOpenOptions } from "../agent-harness.ts";

const SESSION_ARTIFACTS_DIRECTORY = "/workspace/.openorb/artifacts";

export function createDurableTools(
  options: AgentHarnessOpenOptions,
  artifacts: SessionArtifactStore,
): readonly ToolRegistration[] {
  const guest = options.environment;
  return [
    createEditTool(),
    createWriteTool(),
    createReadTool(),
    {
      ...createBashTool(),
      description:
        "Execute a command exclusively in the guest. A positive timeout in seconds is required (at most 86400). Output retains the last 2000 lines or 50 KiB; full output is not saved.",
      parameters: Type.Object({
        command: Type.String(),
        timeout: Type.Number({ exclusiveMinimum: 0, maximum: 86400 }),
      }),
    },
    defineTool({
      name: "readImage",
      description:
        "Read a guest PNG, JPEG, GIF, or WebP image into the conversation. Use read for text files.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(args, _api, context) {
        const bytes = await Effect.runPromise(
          guest.readFile(resolveAgentPath(args.path), {
            ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
            maxBytes: MAX_SESSION_ARTIFACT_BYTES,
          }),
          { signal: context.abortSignal },
        );
        context.abortSignal?.throwIfAborted();
        const mimeType = detectMediaType(bytes);
        if (!mimeType?.startsWith("image/")) {
          throw new AgentEnvironmentError(
            "readImage requires a PNG, JPEG, GIF, or WebP image",
            undefined,
          );
        }
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") },
          ],
        };
      },
    }),
    defineTool({
      name: "environment",
      description:
        "Start, stop, or restart the guest environment. This host-side control works even while the guest is unavailable. Stopping preserves disk but not processes or RAM.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart")]),
      }),
      async execute({ action }, _api, context) {
        const result = await Effect.runPromise(options.controlEnvironment(action), {
          signal: context.abortSignal,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    }),
    defineTool({
      name: "publish_media",
      description:
        `Publish an image or video under ${SESSION_ARTIFACTS_DIRECTORY}. Include the returned Markdown in your response.`,
      parameters: Type.Object({ path: Type.String(), description: Type.String() }),
      async execute(args, _api, context) {
        const path = resolveAgentPath(args.path);
        if (!path.startsWith(`${SESSION_ARTIFACTS_DIRECTORY}/`)) {
          throw new AgentEnvironmentError(
            `Published media must be under ${SESSION_ARTIFACTS_DIRECTORY}`,
            undefined,
          );
        }
        const bytes = await Effect.runPromise(
          guest.readFile(path, {
            ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
            maxBytes: MAX_SESSION_ARTIFACT_BYTES,
          }),
          { signal: context.abortSignal },
        );
        const mediaType = detectMediaType(bytes);
        if (mediaType === null) {
          throw new AgentEnvironmentError(
            "Published media must be PNG, JPEG, GIF, WebP, MP4, or WebM",
            undefined,
          );
        }
        context.abortSignal?.throwIfAborted();
        const artifact = await Effect.runPromise(
          artifacts.publish(options.sessionId, {
            fileName: posix.basename(path),
            bytes,
            mediaType,
          }),
          { signal: context.abortSignal },
        );
        const kind = mediaType.startsWith("image/") ? "image" : "video";
        const label = (args.description.trim() || artifact.fileName).replaceAll("\\", "\\\\")
          .replaceAll("]", "\\]").replaceAll("\n", " ");
        return {
          content: [{ type: "text", text: `![${label}](openorb-artifact:${kind}:${artifact.id})` }],
        };
      },
    }),
  ];
}
