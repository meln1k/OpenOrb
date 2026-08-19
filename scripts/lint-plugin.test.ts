import { assertEquals } from "@std/assert";

import plugin from "@/scripts/lint-plugin.ts";

const PI_RESOURCE_RULE_ID = "openorb/no-default-pi-resource-loader";
const PI_SESSION_RULE_ID = "openorb/no-direct-pi-session-construction";
const PI_SETTINGS_RULE_ID = "openorb/no-file-backed-pi-settings";

Deno.test("the OpenOrb plugin registers all configured rules", () => {
  const expected = [
    "no-chained-type-assertions",
    "no-known-value-widening",
    "no-object-parameters",
    "no-reflect-apply",
    "no-reflect-get",
    "no-runtime-typeof",
    "no-catch",
    "no-generic-error-throw",
    "no-unknown-returns",
    "no-unknown-type-aliases",
    "no-unsafe-dictionary-type",
    "no-widen-then-assert",
    "prefer-disposable-stack",
    "require-safety-comment-for-type-assertion",
    "require-result-handling",
  ];
  assertEquals(
    expected.filter((rule) => !(rule in plugin.rules)),
    [],
  );
});

Deno.test("runner code cannot import Pi's default resource loader", () => {
  const source = `
import { DefaultResourceLoader } from "npm:@earendil-works/pi-coding-agent";
new DefaultResourceLoader({});
`;

  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/runner/src/session.ts",
    source,
  );

  assertEquals(diagnostics.map((diagnostic) => diagnostic.id), [PI_RESOURCE_RULE_ID]);
});

Deno.test("runner code cannot hide Pi APIs behind re-exports or dynamic imports", () => {
  const source = `
export { createAgentSession } from "@earendil-works/pi-coding-agent";
export * from "npm:@earendil-works/pi-coding-agent@0.84.2";
void import(\`npm:@earendil-works/pi-coding-agent\`);
`;

  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/runner/src/pi-api.ts",
    source,
  );

  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.id),
    [PI_RESOURCE_RULE_ID, PI_RESOURCE_RULE_ID, PI_RESOURCE_RULE_ID],
  );
});

Deno.test("runner code cannot construct Pi sessions outside the audited factory", () => {
  const source = `
import { AgentSession, createAgentSession } from "@earendil-works/pi-coding-agent";
void AgentSession;
void createAgentSession;
`;

  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/runner/src/session.ts",
    source,
  );

  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.id),
    [PI_SESSION_RULE_ID, PI_SESSION_RULE_ID],
  );
});

Deno.test("runner code cannot create file-backed Pi settings", () => {
  const source = `
import { SettingsManager as PiSettings } from "@earendil-works/pi-coding-agent";
const settings = PiSettings.create("/workspace");
`;

  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/runner/src/session.ts",
    source,
  );

  assertEquals(diagnostics.map((diagnostic) => diagnostic.id), [PI_SETTINGS_RULE_ID]);
});

Deno.test("the audited factory may use only the safe Pi construction APIs", () => {
  const source = `
import {
  createAgentSession,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
const settings = SettingsManager.inMemory({});
void createAgentSession({ settingsManager: settings });
`;

  assertEquals(
    Deno.lint.runPlugin(
      plugin,
      "packages/runner/src/pi-session-factory.ts",
      source,
    ),
    [],
  );
});
