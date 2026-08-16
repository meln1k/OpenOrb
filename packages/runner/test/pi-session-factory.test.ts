import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("the audited factory ignores hostile workspace and global Pi resources", async () => {
  const temporaryDirectory = await Deno.makeTempDir();
  const sessionDirectory = `${temporaryDirectory}/pi-sessions`;
  const markerPath = `${temporaryDirectory}/host-execution-marker`;
  const originalCwd = Deno.cwd();
  const originalMarker = Deno.env.get("OPENORB_HOSTILE_PI_MARKER");

  try {
    Deno.chdir(`${hostileFixture}/workspace`);
    Deno.env.set("OPENORB_HOSTILE_PI_MARKER", markerPath);

    const result = await OpenOrbPiSessionFactory.create({
      runnerSessionDirectory: sessionDirectory,
      runnerAgentDirectory: `${hostileFixture}/global-agent`,
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
      assertStringIncludes(result.session.sessionFile ?? "", `${sessionDirectory}/`);
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
    const result = await OpenOrbPiSessionFactory.create({
      runnerSessionDirectory: `${temporaryDirectory}/pi-sessions`,
      runnerAgentDirectory: `${temporaryDirectory}/pi-agent`,
      tools: [guestTool],
    });
    try {
      assertEquals(result.session.getActiveToolNames(), ["guest-test"]);
      assertEquals(
        result.session.getAllTools().map((tool) => tool.name),
        ["guest-test"],
      );
    } finally {
      result.session.dispose();
    }
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
});
