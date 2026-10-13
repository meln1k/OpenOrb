import type { Context } from "@earendil-works/chord";
import { clampThinkingLevel, type CredentialStore, type Models, Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type Conversation,
  createRegistry,
  defineTool,
  Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  type DurableObjectSqliteStorage,
  openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { parseModelReference } from "@openorb/protocol";
import type { EnvironmentAction, ThinkingLevel } from "@openorb/protocol/runner-api";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { EnvironmentControlResult } from "./environment/provider.ts";
import { ARTIFACTS_DIRECTORY, detectMediaType } from "./media.ts";
import { REPOSITORY_SKILLS_SECTION } from "./skills.ts";
import type { SessionProject } from "./record.ts";

export class SessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionError";
  }
}

export interface AgentOptions {
  readonly sessionId: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  /** The project checked out in /workspace; absent when the Session has none. */
  readonly project: SessionProject | undefined;
  /** What the provider says about its guest in the system prompt. */
  readonly guestPrompt: readonly string[];
  readonly models: Models;
  /** The guest as the agent sees it: the provider's ExecutionEnv behind the readiness gate. */
  readonly env: ExecutionEnv;
  /** Host-side Environment Control; works while the guest is unavailable. */
  readonly controlEnvironment: (action: EnvironmentAction) => Promise<EnvironmentControlResult>;
  /** Copies a guest artifact into Session media storage and returns its transcript Markdown. */
  readonly publishMedia: (path: string, description: string) => Promise<string>;
  /** The repository skills prompt section, rendered for every generation. */
  readonly repositorySkills: () => string;
}

export interface Agent {
  readonly models: Models;
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly storage: Awaited<ReturnType<typeof openDurableObjectSqliteStorage>>;
}

export function createAgentModels(credentials: CredentialStore): Models {
  // Neither ambient environment variables nor host files may supply credentials.
  return builtinModels({
    credentials,
    authContext: {
      env: () => Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false),
    },
  });
}

export function modelRef(model: string) {
  const { providerId, modelId } = parseModelReference(model);
  return { provider: providerId, modelId };
}

export function effectiveThinkingLevel(
  models: Models,
  model: string,
  requested: ThinkingLevel,
): ThinkingLevel {
  const ref = modelRef(model);
  const resolved = models.getModel(ref.provider, ref.modelId);
  if (resolved === undefined) throw new SessionError("The configured model is unavailable.");
  return clampThinkingLevel(resolved, requested);
}

/** Inline images become model context; larger guest files belong in publish_media. */
const MAX_READ_IMAGE_BYTES = 8 * 1024 * 1024;

export function agentTools(
  options: Pick<AgentOptions, "controlEnvironment" | "publishMedia" | "env">,
) {
  return [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
    defineTool({
      name: "environment",
      description:
        "Start, stop, or restart the guest environment. This host-side control works while the guest is unavailable. Stopping preserves disk but not processes or RAM.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart")]),
      }),
      async execute({ action }) {
        const result = await options.controlEnvironment(action);
        return { output: [{ type: "text", text: JSON.stringify(result) }] };
      },
    }),
    defineTool({
      name: "readImage",
      description:
        "Read a guest PNG, JPEG, GIF, or WebP image into the conversation. Use read for text files.",
      parameters: Type.Object({ path: Type.String() }),
      async execute({ path }, _api, context) {
        const info = await options.env.fileInfo(path, context);
        if (!info.ok) throw new SessionError(info.error.message);
        if (info.value.size > MAX_READ_IMAGE_BYTES) {
          throw new SessionError(`readImage reads images up to ${MAX_READ_IMAGE_BYTES} bytes.`);
        }
        const bytes = await options.env.readBinaryFile(path, context);
        if (!bytes.ok) throw new SessionError(bytes.error.message);
        const mimeType = detectMediaType(bytes.value);
        if (!mimeType?.startsWith("image/")) {
          throw new SessionError("readImage requires a PNG, JPEG, GIF, or WebP image");
        }
        return {
          output: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", mimeType, data: bytes.value.toBase64() },
          ],
        };
      },
    }),
    defineTool({
      name: "publish_media",
      description:
        `Publish an image or video under ${ARTIFACTS_DIRECTORY}. Include the returned Markdown in your response.`,
      parameters: Type.Object({ path: Type.String(), description: Type.String() }),
      async execute({ path, description }) {
        return {
          output: [{ type: "text", text: await options.publishMedia(path, description) }],
        };
      },
    }),
  ] satisfies readonly ToolRegistration[];
}

export function systemPrompt(options: Pick<AgentOptions, "guestPrompt" | "project">): string {
  return [
    "You are an expert coding assistant. Use only the tools supplied by OpenOrb.",
    "All shell and file operations run in an isolated guest environment, never on a trusted host. Relative paths resolve from /workspace.",
    "Guest tools fail immediately while the environment is stopped or unreachable. The environment tool controls the guest independently of this conversation; stopping preserves disk, not RAM or processes. Do not shut down the guest using bash.",
    "Use bash for ls, rg, and find. Be concise and show file paths clearly.",
    "Use read for text files and readImage to inspect images.",
    "To show media, use publish_media and include its exact returned Markdown.",
    ...options.guestPrompt,
    ...(options.project === undefined ? NO_PROJECT_PROMPT : projectPrompt(options.project)),
  ].join("\n");
}

function projectPrompt(project: SessionProject) {
  return [
    "Create commits or push only when the user explicitly requests it. Preserve existing commits: never amend, squash, reset, rewrite history, or force-push.",
    `Keep all work on session branch ${
      JSON.stringify(project.branchName)
    }. Push only that branch to canonical repository ${
      JSON.stringify(project.repositoryUrl)
    }, never an agent-modified remote destination.`,
  ];
}

const NO_PROJECT_PROMPT = [
  "This Session has no project: /workspace starts empty, and OpenOrb tracks no repository or Git changes for it.",
];

/** Opens Pi Durable on the Durable Object's own SQLite storage. Opening never resumes work. */
export async function openAgent(
  storageHost: DurableObjectSqliteStorage,
  options: AgentOptions,
  context: Context,
): Promise<Agent> {
  const models = options.models;
  const registry = createRegistry();
  registry.install({
    name: "openorb",
    tools: agentTools(options),
    sections: [{ key: "openorb", render: () => systemPrompt(options) }],
  });
  registry.install({
    name: REPOSITORY_SKILLS_SECTION,
    sections: [{ key: REPOSITORY_SKILLS_SECTION, render: options.repositorySkills }],
  });
  const storage = await openDurableObjectSqliteStorage(storageHost);
  const harness = await Harness.open(storage, {
    models,
    registry,
    env: () => options.env,
    settings: {
      stream: {
        headers: options.model.startsWith("opencode-go/")
          ? { "x-opencode-session": options.sessionId }
          : {},
      },
    },
  }, context);
  const conversation = await harness.root(context, {
    agent: {
      model: modelRef(options.model),
      thinkingLevel: effectiveThinkingLevel(models, options.model, options.thinkingLevel),
      cwd: "/workspace",
    },
  });
  return { models, harness, conversation, storage };
}
