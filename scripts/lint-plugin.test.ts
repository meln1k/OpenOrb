import { assertEquals } from "@std/assert";

import plugin from "@/scripts/lint-plugin.ts";

const PI_RULE_ID = "openorb/no-retired-pi-sdk";

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

Deno.test("runner code cannot import the retired Pi SDK", () => {
  const source = `
import { DefaultResourceLoader } from "npm:@earendil-works/pi-coding-agent";
new DefaultResourceLoader({});
`;

  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/runner/src/session.ts",
    source,
  );

  assertEquals(diagnostics.map((diagnostic) => diagnostic.id), [PI_RULE_ID]);
});

Deno.test("runner code cannot hide Pi APIs behind re-exports or dynamic imports", () => {
  const source = `
export { createAgentSession } from "@earendil-works/pi-coding-agent";
export * from "npm:@earendil-works/pi-coding-agent@0.85.1";
void import(\`npm:@earendil-works/pi-coding-agent\`);
`;

  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/runner/src/pi-api.ts",
    source,
  );

  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.id),
    [PI_RULE_ID, PI_RULE_ID, PI_RULE_ID],
  );
});

Deno.test("the former Pi factory has no exemption from the retired SDK ban", () => {
  const source = `
import { AgentSession, createAgentSession } from "@earendil-works/pi-coding-agent";
void AgentSession;
void createAgentSession;
`;

  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/runner/src/harness/pi/session.ts",
    source,
  );

  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.id),
    [PI_RULE_ID],
  );
});

Deno.test("gateway code cannot import retired Pi SDK subpaths", () => {
  const source = `
import * as settings from "@earendil-works/pi-coding-agent/settings";
void settings;
`;

  const diagnostics = Deno.lint.runPlugin(
    plugin,
    "packages/gateway/app/session.ts",
    source,
  );

  assertEquals(diagnostics.map((diagnostic) => diagnostic.id), [PI_RULE_ID]);
});

Deno.test("the Durable integration can import its current SDK", () => {
  const source = `
import { Harness } from "@earendil-works/pi-durable";
import { Models } from "@earendil-works/pi-ai";
void Harness;
void Models;
`;

  assertEquals(
    Deno.lint.runPlugin(
      plugin,
      "packages/runner/src/harness/durable/layer.ts",
      source,
    ),
    [],
  );
});
