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
import type { EnvironmentControlResult, SessionEnvironment } from "./environment/provider.ts";

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
  readonly repositoryUrl: string;
  readonly branchName: string;
  readonly models: Models;
  readonly environment: SessionEnvironment;
  /** Host-side Environment Control; works while the guest is unavailable. */
  readonly controlEnvironment: (action: EnvironmentAction) => Promise<EnvironmentControlResult>;
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

export function agentTools(options: Pick<AgentOptions, "controlEnvironment">) {
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
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    }),
  ] satisfies readonly ToolRegistration[];
}

export function systemPrompt(options: Pick<AgentOptions, "branchName" | "repositoryUrl">): string {
  return [
    "You are an expert coding assistant. Use only the tools supplied by OpenOrb.",
    "All shell and file operations run in an isolated guest environment, never on a trusted host. Relative paths resolve from /workspace.",
    "Guest tools fail immediately while the environment is stopped or its runner is offline. The environment tool controls the guest independently of this conversation; stopping preserves disk, not RAM or processes. Do not shut down the guest using bash.",
    "Use bash for ls, rg, and find. Be concise and show file paths clearly.",
    "Create commits or push only when the user explicitly requests it. Preserve existing commits: never amend, squash, reset, rewrite history, or force-push.",
    `Keep all work on session branch ${
      JSON.stringify(options.branchName)
    }. Push only that branch to canonical repository ${
      JSON.stringify(options.repositoryUrl)
    }, never an agent-modified remote destination.`,
  ].join("\n");
}

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
  const storage = await openDurableObjectSqliteStorage(storageHost);
  const harness = await Harness.open(storage, {
    models,
    registry,
    env: () => options.environment.env,
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
