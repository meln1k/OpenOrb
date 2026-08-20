import { assert, assertEquals } from "@std/assert";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import {
  OPENORB_GUEST_WORKSPACE,
  OPENORB_SYSTEM_PROMPT,
  OpenOrbPiSessionFactory,
} from "@/src/pi-session-factory.ts";

const hostileFixture = decodeURIComponent(
  new URL("./fixtures/hostile-pi", import.meta.url).pathname,
);
const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "test-model-provider-key" },
};
const RUN_REAL_MODEL_TEST = Deno.env.get("OPENORB_RUN_PI_MODEL_TESTS") === "1";
const REAL_MODEL_API_KEY = Deno.env.get("OPENCODE_API_KEY");

Deno.test("the audited factory ignores hostile workspace and global Pi resources", async () => {
  const temporaryDirectory = await Deno.makeTempDir();
  const sessionDirectory = `${temporaryDirectory}/pi-sessions`;
  const markerPath = `${temporaryDirectory}/host-execution-marker`;
  const originalCwd = Deno.cwd();
  const originalMarker = Deno.env.get("OPENORB_HOSTILE_PI_MARKER");

  try {
    Deno.chdir(`${hostileFixture}/workspace`);
    Deno.env.set("OPENORB_HOSTILE_PI_MARKER", markerPath);
    await Deno.mkdir(sessionDirectory);
    const sessionFile = `${sessionDirectory}/session.jsonl`;
    await Deno.writeTextFile(sessionFile, "");

    const result = await OpenOrbPiSessionFactory.create({
      runnerSessionFile: sessionFile,
      runnerAgentDirectory: `${hostileFixture}/global-agent`,
      modelRuntime: MODEL_RUNTIME,
      tools: [],
    });
    try {
      const loader = result.session.resourceLoader;
      const extensions = loader.getExtensions();

      assertEquals(result.extensionsResult.extensions, []);
      assertEquals(result.extensionsResult.errors, []);
      assertEquals(extensions.extensions, []);
      assertEquals(extensions.errors, []);
      assertEquals(extensions.runtime.flagValues.size, 0);
      assertEquals(loader.getSkills(), { skills: [], diagnostics: [] });
      assertEquals(loader.getPrompts(), { prompts: [], diagnostics: [] });
      assertEquals(loader.getThemes(), { themes: [], diagnostics: [] });
      assertEquals(loader.getAgentsFiles(), { agentsFiles: [] });
      assertEquals(loader.getAppendSystemPrompt(), []);
      assertEquals(loader.getAppendSystemPromptSources(), []);
      assertEquals(loader.getSystemPrompt(), OPENORB_SYSTEM_PROMPT);
      assertEquals(loader.getSystemPromptSource(), undefined);
      assertEquals(result.session.getActiveToolNames(), []);
      assertEquals(result.session.getAllTools(), []);
      assertEquals(
        result.session.systemPrompt,
        `${OPENORB_SYSTEM_PROMPT}\nCurrent working directory: ${OPENORB_GUEST_WORKSPACE}\n`,
      );
      assertEquals(result.session.sessionFile, sessionFile);
      assertEquals(result.session.settingsManager.getGlobalSettings().packages, []);
      assertEquals(result.session.settingsManager.getProjectSettings(), {});

      const initialRuntime = extensions.runtime;
      await loader.reload();
      assert(
        loader.getExtensions().runtime !== initialRuntime,
        "Reloading must create a fresh empty extension runtime",
      );

      let markerExists = true;
      try {
        await Deno.stat(markerPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) markerExists = false;
        else throw error;
      }
      assert(!markerExists, "A hostile Pi extension executed on the runner host");
    } finally {
      result.session.dispose();
    }
  } finally {
    Deno.chdir(originalCwd);
    if (originalMarker === undefined) Deno.env.delete("OPENORB_HOSTILE_PI_MARKER");
    else Deno.env.set("OPENORB_HOSTILE_PI_MARKER", originalMarker);
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
});

Deno.test("the factory allowlists supplied tools without enabling Pi host tools", async () => {
  const temporaryDirectory = await Deno.makeTempDir();
  const guestTool = defineTool({
    name: "guest-test",
    label: "Guest test",
    description: "A test stand-in for a Gondolin-backed tool",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "guest" }], details: {} }),
  });

  try {
    const sessionFile = `${temporaryDirectory}/session.jsonl`;
    const agentDirectory = `${temporaryDirectory}/pi-agent`;
    await Deno.writeTextFile(sessionFile, "");
    const result = await OpenOrbPiSessionFactory.create({
      runnerSessionFile: sessionFile,
      runnerAgentDirectory: agentDirectory,
      modelRuntime: MODEL_RUNTIME,
      tools: [guestTool],
    });
    try {
      assertEquals(result.session.getActiveToolNames(), ["guest-test"]);
      assertEquals(
        result.session.getAllTools().map((tool) => tool.name),
        ["guest-test"],
      );
      assert(!(await Deno.readTextFile(sessionFile)).includes(MODEL_RUNTIME.credential.value));
      assertEquals(await pathExists(`${agentDirectory}/auth.json`), false);
    } finally {
      result.session.dispose();
    }
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
});

Deno.test({
  name: "a real DeepSeek run streams and persists a response without persisting its credential",
  ignore: !RUN_REAL_MODEL_TEST || !REAL_MODEL_API_KEY,
  async fn() {
    const apiKey = REAL_MODEL_API_KEY;
    if (!apiKey) throw new Error("OPENCODE_API_KEY is required.");
    const temporaryDirectory = await Deno.makeTempDir();
    try {
      const sessionFile = `${temporaryDirectory}/session.jsonl`;
      const agentDirectory = `${temporaryDirectory}/agent`;
      await Deno.writeTextFile(sessionFile, "");
      await Deno.mkdir(agentDirectory);
      const result = await OpenOrbPiSessionFactory.create({
        runnerSessionFile: sessionFile,
        runnerAgentDirectory: agentDirectory,
        modelRuntime: {
          ...MODEL_RUNTIME,
          credential: { type: "api_key", value: apiKey },
        },
        tools: [],
      });
      let responseText = "";
      let sawTextDelta = false;
      let sawThinkingDelta = false;
      const unsubscribe = result.session.subscribe((event) => {
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") sawTextDelta = true;
          if (event.assistantMessageEvent.type === "thinking_delta") sawThinkingDelta = true;
          return;
        }
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        responseText = event.message.content.flatMap((block) =>
          block.type === "text" ? [block.text] : []
        ).join("");
      });

      try {
        await result.session.prompt("Reply with exactly OPENORB_PI_E2E_OK and nothing else.");
      } finally {
        unsubscribe();
        result.session.dispose();
      }

      assert(sawTextDelta);
      assert(sawThinkingDelta);
      assert(responseText.includes("OPENORB_PI_E2E_OK"));
      const persistedSession = await Deno.readTextFile(sessionFile);
      assert(persistedSession.includes("OPENORB_PI_E2E_OK"));
      assert(!persistedSession.includes(apiKey));
      assertEquals(
        [...Deno.readDirSync(agentDirectory)].some((entry) => entry.name === "auth.json"),
        false,
      );
    } finally {
      await Deno.remove(temporaryDirectory, { recursive: true });
    }
  },
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
