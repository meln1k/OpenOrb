import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { parseModelReference, type SessionModelRuntime } from "@openorb/protocol";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const OPENORB_GUEST_WORKSPACE = "/workspace";
export const OPENORB_SYSTEM_PROMPT =
  "You are OpenOrb's coding agent. Use only the tools provided by OpenOrb.";

export interface OpenOrbPiSessionOptions {
  runnerSessionFile: string;
  runnerAgentDirectory: string;
  modelRuntime: SessionModelRuntime;
  tools: readonly ToolDefinition[];
}

export class OpenOrbPiSessionFactory {
  static async create(options: OpenOrbPiSessionOptions) {
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
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: true,
      refreshOnCreate: false,
    });
    const { providerId, modelId } = parseModelReference(options.modelRuntime.model);
    await modelRuntime.setRuntimeApiKey(
      providerId,
      options.modelRuntime.credential.value,
    );
    const model = modelRuntime.getModel(
      providerId,
      modelId,
    );
    if (!model) throw new OpenOrbPiModelError();
    const thinkingLevel = options.modelRuntime.thinkingLevel;

    return await createAgentSession({
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
    });
  }
}

class OpenOrbPiModelError extends Error {
  constructor() {
    super("The configured Pi model is unavailable.");
    this.name = "OpenOrbPiModelError";
  }
}
