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

type PromptTool = Pick<ToolDefinition, "name" | "promptSnippet" | "promptGuidelines">;

export function createOpenOrbSystemPrompt(
  repositoryUrl: string,
  branchName: string,
  tools: readonly PromptTool[],
): string {
  const toolSnippets = tools.flatMap((tool) => {
    const snippet = tool.promptSnippet?.trim();
    return snippet ? [`- ${tool.name}: ${snippet}`] : [];
  });
  const toolNames = new Set(tools.map((tool) => tool.name));
  const guidelines = new Set<string>();
  if (
    toolNames.has("bash") &&
    !toolNames.has("grep") &&
    !toolNames.has("find") &&
    !toolNames.has("ls")
  ) {
    guidelines.add("Use bash for file operations like ls, rg, find");
  }
  for (const tool of tools) {
    for (const guideline of tool.promptGuidelines ?? []) {
      const normalized = guideline.trim();
      if (normalized) guidelines.add(normalized);
    }
  }
  guidelines.add("Be concise in your responses");
  guidelines.add("Show file paths clearly when working with files");

  return [
    "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
    "",
    "Available tools:",
    toolSnippets.length > 0 ? toolSnippets.join("\n") : "(none)",
    "",
    "Use only the tools provided by OpenOrb.",
    "",
    "Guidelines:",
    ...Array.from(guidelines, (guideline) => `- ${guideline}`),
    "",
    "OpenOrb environment:",
    "- Pi runs in the trusted OpenOrb runner outside the Gondolin guest VM.",
    "- Filesystem and shell tools operate exclusively on the guest; they cannot access the runner host, Pi installation, configuration, or host filesystem.",
    `- Relative paths resolve from ${OPENORB_GUEST_WORKSPACE}. Absolute paths refer to the guest filesystem.`,
    `- ${OPENORB_GUEST_WORKSPACE} contains the persistent repository checkout and is the only guest path included in Git change review.`,
    "- OpenOrb manages the VM lifecycle. Do not attempt to stop or restart the VM yourself.",
    "- OpenOrb may stop the VM only after agent and tool activity has finished. It reopens the persistent root disk before dispatching another prompt.",
    `- A successful stop and resume preserves the guest root disk, ${OPENORB_GUEST_WORKSPACE}, and the Pi conversation, but not RAM or running processes.`,
    "- Temporary filesystems, including /root, /tmp, and /var/log, do not survive stop and resume.",
    "- Do not rely on background processes surviving stop and resume. If the project provides an executable .agents/resume hook, OpenOrb runs it before dispatching the next prompt.",
    "",
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
      getSystemPrompt: () =>
        createOpenOrbSystemPrompt(options.repositoryUrl, options.branchName, options.tools),
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
