import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { parseModelReference } from "@openorb/protocol";
import type { SessionModelRuntime } from "@openorb/protocol/runner-api";
import { Effect } from "effect";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { AgentHarnessError } from "../agent-harness.ts";

export const OPENORB_GUEST_WORKSPACE = "/workspace";
export const OPENORB_SYSTEM_PROMPT =
  "You are OpenOrb's coding agent. Use only the tools provided by OpenOrb.";

/** Audited construction options for the Pi harness adapter. */
export interface OpenOrbPiSessionOptions {
  runnerSessionFile: string;
  runnerAgentDirectory: string;
  modelRuntime: SessionModelRuntime;
  tools: readonly ToolDefinition[];
}

export type OpenOrbPiSession = Awaited<ReturnType<typeof createAgentSession>>;

export const createOpenOrbPiSession = Effect.fn("AgentHarness.createPiSession")(
  function* (options: OpenOrbPiSessionOptions) {
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
      getSystemPrompt: () => OPENORB_SYSTEM_PROMPT,
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

    return yield* Effect.tryPromise({
      try: () =>
        createAgentSession({
          cwd: OPENORB_GUEST_WORKSPACE,
          agentDir: options.runnerAgentDirectory,
          model,
          modelRuntime,
          resourceLoader,
          sessionManager: SessionManager.open(
            options.runnerSessionFile,
            undefined,
            OPENORB_GUEST_WORKSPACE,
          ),
          settingsManager,
          thinkingLevel,
          tools: toolNames,
          customTools: [...options.tools],
        }),
      catch: (cause) => new AgentHarnessError("Could not create the Pi agent session.", cause),
    });
  },
);
