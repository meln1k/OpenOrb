import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
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
  runnerSessionDirectory: string;
  runnerAgentDirectory: string;
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
      allowModelNetwork: false,
      refreshOnCreate: false,
    });

    return await createAgentSession({
      cwd: OPENORB_GUEST_WORKSPACE,
      agentDir: options.runnerAgentDirectory,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.create(
        OPENORB_GUEST_WORKSPACE,
        options.runnerSessionDirectory,
      ),
      settingsManager,
      tools: toolNames,
      customTools: [...options.tools],
    });
  }
}
