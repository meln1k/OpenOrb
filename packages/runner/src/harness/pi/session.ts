import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { parseModelReference } from "@openorb/protocol";
import type {
  DurableSessionEvent,
  SessionId,
  SessionModelRuntime,
} from "@openorb/protocol/runner-api";
import { Effect, Result, type Scope } from "effect";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { AgentHarnessError } from "../agent-harness.ts";
import { eventsFromPiEntries } from "./history.ts";

export const OPENORB_GUEST_WORKSPACE = "/workspace";

export function createOpenOrbSystemPrompt(repositoryUrl: string, branchName: string): string {
  return [
    "You are OpenOrb's coding agent. Use only the tools provided by OpenOrb.",
    "Follow this trusted Git policy:",
    "- Create commits or push them only when the user explicitly requests that operation.",
    `- Keep all work on the session branch ${
      JSON.stringify(branchName)
    } and push only that branch.`,
    `- Push only to the canonical configured repository ${
      JSON.stringify(repositoryUrl)
    }; do not use an agent-modified remote destination.`,
    "- Preserve existing commits; do not amend, squash, reset, or otherwise rewrite them.",
    "- Never force-push and never use a force option for Git or GitHub CLI operations.",
  ].join("\n");
}

/** Audited construction options for the Pi harness adapter. */
export interface OpenOrbPiSessionOptions {
  sessionId: SessionId;
  runnerSessionFile: string;
  runnerAgentDirectory: string;
  repositoryUrl: string;
  branchName: string;
  modelRuntime: SessionModelRuntime;
  tools: readonly ToolDefinition[];
  conversationProjection: ConversationProjectionSink;
}

export interface ActiveConversationProjection {
  readonly update: (
    conversation: readonly DurableSessionEvent[] | undefined,
  ) => void;
  readonly dispose: () => void;
}

export interface ConversationProjectionSink {
  readonly activate: (
    sessionId: SessionId,
    initial: readonly DurableSessionEvent[],
  ) => Effect.Effect<ActiveConversationProjection, AgentHarnessError, Scope.Scope>;
}

export interface OpenOrbPiSessionDependencies {
  readonly createAgentSession?: typeof createAgentSession;
}

export type OpenOrbPiSession = Awaited<ReturnType<typeof createAgentSession>>;

export const createOpenOrbPiSession = Effect.fn("AgentHarness.createPiSession")(
  function* (
    options: OpenOrbPiSessionOptions,
    dependencies: OpenOrbPiSessionDependencies = {},
  ) {
    const toolNames = options.tools.map((tool) => tool.name);
    const settingsManager = SettingsManager.inMemory(
      {
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        defaultTools: [],
      },
      { projectTrusted: false },
    );
    let extensionRuntime = createExtensionRuntime();
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => createOpenOrbSystemPrompt(options.repositoryUrl, options.branchName),
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: () => {
        extensionRuntime = createExtensionRuntime();
        return Promise.resolve();
      },
    };
    const modelRuntime = yield* Effect.tryPromise({
      try: () =>
        ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
          allowModelNetwork: true,
          refreshOnCreate: false,
        }),
      catch: (cause) => new AgentHarnessError("Could not create the Pi model runtime.", cause),
    });
    const { providerId, modelId } = parseModelReference(options.modelRuntime.model);
    yield* Effect.tryPromise({
      try: () =>
        modelRuntime.setRuntimeApiKey(
          providerId,
          options.modelRuntime.credential.value,
        ),
      catch: (cause) => new AgentHarnessError("Could not configure the Pi model runtime.", cause),
    });
    const model = modelRuntime.getModel(
      providerId,
      modelId,
    );
    if (!model) {
      return yield* new AgentHarnessError("The configured Pi model is unavailable.", undefined);
    }
    const thinkingLevel = options.modelRuntime.thinkingLevel;

    const sessionManager = SessionManager.open(
      options.runnerSessionFile,
      undefined,
      OPENORB_GUEST_WORKSPACE,
    );
    const activeConversation = yield* options.conversationProjection.activate(
      options.sessionId,
      eventsFromPiEntries(sessionManager.getBranch()),
    );
    observeSessionManagerPersistence(sessionManager, () => {
      const projected = Result.try(() => eventsFromPiEntries(sessionManager.getBranch()));
      activeConversation.update(Result.getOrElse(projected, () => undefined));
    });

    return yield* Effect.tryPromise({
      try: () =>
        (dependencies.createAgentSession ?? createAgentSession)({
          cwd: OPENORB_GUEST_WORKSPACE,
          agentDir: options.runnerAgentDirectory,
          model,
          modelRuntime,
          resourceLoader,
          sessionManager,
          settingsManager,
          thinkingLevel,
          tools: toolNames,
          customTools: [...options.tools],
        }),
      catch: (cause) => new AgentHarnessError("Could not create the Pi agent session.", cause),
    }).pipe(
      Effect.onError(() => Effect.sync(activeConversation.dispose)),
    );
  },
);

/** Decorates Pi's real manager so observers only see entries after synchronous persistence returns. */
export function observeSessionManagerPersistence(
  manager: SessionManager,
  onPersisted: (entry: SessionEntry) => void,
): SessionManager {
  const notify = (id: string): void => {
    const entry = manager.getEntry(id);
    if (entry === undefined) return;
    // Persistence already succeeded. Observer failures must not change Pi's write result.
    Result.try(() => onPersisted(entry));
  };

  const appendMessage = manager.appendMessage.bind(manager);
  // SAFETY: The wrapper forwards the exact public method parameters and return value unchanged.
  manager.appendMessage = ((...args: Parameters<SessionManager["appendMessage"]>) => {
    const id = appendMessage(...args);
    notify(id);
    return id;
  }) as SessionManager["appendMessage"];

  const appendCustomMessageEntry = manager.appendCustomMessageEntry.bind(manager);
  // SAFETY: The wrapper forwards the exact public method parameters and return value unchanged.
  manager.appendCustomMessageEntry = ((
    ...args: Parameters<SessionManager["appendCustomMessageEntry"]>
  ) => {
    const id = appendCustomMessageEntry(...args);
    notify(id);
    return id;
  }) as SessionManager["appendCustomMessageEntry"];

  const appendCompaction = manager.appendCompaction.bind(manager);
  // SAFETY: The wrapper forwards the exact public method parameters and return value unchanged.
  manager.appendCompaction = ((...args: Parameters<SessionManager["appendCompaction"]>) => {
    const id = appendCompaction(...args);
    notify(id);
    return id;
  }) as SessionManager["appendCompaction"];

  return manager;
}
