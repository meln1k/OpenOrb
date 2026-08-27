import { assert, assertEquals } from "@std/assert";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionId } from "@openorb/protocol/runner-api";
import { Effect, Schema } from "effect";

import {
  createOpenOrbPiSession,
  observeSessionManagerPersistence,
  OPENORB_GUEST_WORKSPACE,
  OPENORB_SYSTEM_PROMPT,
} from "@/src/harness/pi/session.ts";

const hostileFixture = decodeURIComponent(
  new URL("../../fixtures/hostile-pi", import.meta.url).pathname,
);
const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "test-model-provider-key" },
};
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const CONVERSATION_PROJECTION = {
  activate: () => Effect.succeed({ update() {}, dispose() {} }),
};
const RUN_REAL_MODEL_TEST = Deno.env.get("OPENORB_RUN_PI_MODEL_TESTS") === "1";
const REAL_MODEL_API_KEY = Deno.env.get("OPENCODE_API_KEY");

Deno.test("SessionManager observer runs post-write for every durable conversation append", async () => {
  const temporaryDirectory = await Deno.makeTempDir();
  try {
    const sessionFile = `${temporaryDirectory}/session.jsonl`;
    await Deno.writeTextFile(sessionFile, "");
    const manager = SessionManager.open(sessionFile, undefined, "/workspace");
    const originalAppendMessage = manager.appendMessage.bind(manager);
    let originalReturned = false;
    // SAFETY: The test wrapper forwards the exact method parameters and return value unchanged.
    manager.appendMessage = ((...args: Parameters<SessionManager["appendMessage"]>) => {
      const id = originalAppendMessage(...args);
      originalReturned = true;
      return id;
    }) as SessionManager["appendMessage"];
    const observed: string[] = [];
    observeSessionManagerPersistence(manager, (entry) => {
      assert(originalReturned, "observer ran before Pi's append method returned");
      assertEquals(manager.getEntry(entry.id), entry);
      assert(Deno.readTextFileSync(sessionFile).includes(`\"id\":\"${entry.id}\"`));
      observed.push(entry.type);
    });

    const messageId = manager.appendMessage({ role: "user", content: "Inspect", timestamp: 1 });
    originalReturned = true;
    manager.appendCustomMessageEntry("openorb-test", "Context", true);
    manager.appendCompaction("Summary", messageId, 100);

    assertEquals(observed, ["message", "custom_message", "compaction"]);
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
});

Deno.test("SessionManager observer is infallible and is not called after a failed append", () => {
  const manager = SessionManager.inMemory("/workspace");
  // SAFETY: A function that always throws is assignable for every appendMessage input and output.
  manager.appendMessage = (() => {
    throw new Error("write failed");
  }) as SessionManager["appendMessage"];
  let calls = 0;
  observeSessionManagerPersistence(manager, () => calls++);
  try {
    manager.appendMessage({ role: "user", content: "Inspect", timestamp: 1 });
  } catch {
    // Expected original failure.
  }
  assertEquals(calls, 0);

  const healthy = SessionManager.inMemory("/workspace");
  observeSessionManagerPersistence(healthy, () => {
    throw new Error("cache failed");
  });
  assert(healthy.appendMessage({ role: "user", content: "Still persisted", timestamp: 2 }));
});

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

    const result = await Effect.runPromise(Effect.scoped(createOpenOrbPiSession({
      sessionId: SESSION_ID,
      runnerSessionFile: sessionFile,
      runnerAgentDirectory: `${hostileFixture}/global-agent`,
      modelRuntime: MODEL_RUNTIME,
      tools: [],
      conversationProjection: CONVERSATION_PROJECTION,
    })));
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
    const result = await Effect.runPromise(Effect.scoped(createOpenOrbPiSession({
      sessionId: SESSION_ID,
      runnerSessionFile: sessionFile,
      runnerAgentDirectory: agentDirectory,
      modelRuntime: MODEL_RUNTIME,
      tools: [guestTool],
      conversationProjection: CONVERSATION_PROJECTION,
    })));
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
      const result = await Effect.runPromise(Effect.scoped(createOpenOrbPiSession({
        sessionId: SESSION_ID,
        runnerSessionFile: sessionFile,
        runnerAgentDirectory: agentDirectory,
        modelRuntime: {
          ...MODEL_RUNTIME,
          credential: { type: "api_key", value: apiKey },
        },
        tools: [],
        conversationProjection: CONVERSATION_PROJECTION,
      })));
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
