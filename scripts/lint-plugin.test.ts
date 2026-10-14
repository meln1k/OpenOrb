import { deepStrictEqual as assertEquals } from "node:assert";
import { describe, test } from "vite-plus/test";
import { type Rule, RuleTester } from "eslint";
import * as parser from "@typescript-eslint/parser";
import { lintPlugin } from "./lint-rules/test-lint.ts";

import plugin from "./lint-plugin.ts";

const PI_RULE_ID = "openorb/no-retired-pi-sdk";

test("the OpenOrb plugin registers all configured rules", () => {
  const expected = [
    "no-retired-pi-sdk",
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
  assertEquals(Object.keys(plugin.rules).sort(), expected.sort());
});

test("runner code cannot import the retired Pi SDK", () => {
  const source = `
import { DefaultResourceLoader } from "npm:@earendil-works/pi-coding-agent";
new DefaultResourceLoader({});
`;

  const diagnostics = lintPlugin(plugin, "packages/runner/src/session.ts", source);

  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.id),
    [PI_RULE_ID],
  );
});

test("runner code cannot hide Pi APIs behind re-exports or dynamic imports", () => {
  const source = `
export { createAgentSession } from "@earendil-works/pi-coding-agent";
export * from "npm:@earendil-works/pi-coding-agent@0.85.1";
void import(\`npm:@earendil-works/pi-coding-agent\`);
`;

  const diagnostics = lintPlugin(plugin, "packages/runner/src/pi-api.ts", source);

  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.id),
    [PI_RULE_ID, PI_RULE_ID, PI_RULE_ID],
  );
});

test("the former Pi factory has no exemption from the retired SDK ban", () => {
  const source = `
import { AgentSession, createAgentSession } from "@earendil-works/pi-coding-agent";
void AgentSession;
void createAgentSession;
`;

  const diagnostics = lintPlugin(plugin, "packages/runner/src/harness/pi/session.ts", source);

  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.id),
    [PI_RULE_ID],
  );
});

test("gateway code cannot import retired Pi SDK subpaths", () => {
  const source = `
import * as settings from "@earendil-works/pi-coding-agent/settings";
void settings;
`;

  const diagnostics = lintPlugin(plugin, "packages/gateway/app/session.ts", source);

  assertEquals(
    diagnostics.map((diagnostic) => diagnostic.id),
    [PI_RULE_ID],
  );
});

test("the Durable integration can import its current SDK", () => {
  const source = `
import { Harness } from "@earendil-works/pi-durable";
import { Models } from "@earendil-works/pi-ai";
void Harness;
void Models;
`;

  assertEquals(lintPlugin(plugin, "packages/runner/src/harness/durable/layer.ts", source), []);
});

// Exercise every rule through ESLint's supported plugin API. Oxlint's native
// RuleTester reserves a 6 GiB ArrayBuffer, which cannot run in small Linux orbs
// using heuristic memory overcommit; use the compatible public Linter instead.
RuleTester.describe = describe;
RuleTester.it = test;
const tester = new RuleTester({
  languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
});
const filename = "packages/runner/src/lint-fixture.ts";
const cases = new Map(
  Object.entries({
    "no-retired-pi-sdk": "void import(`@earendil-works/pi-coding-agent`);",
    "no-reflect-apply": "Reflect.apply(target, receiver, []);",
    "no-reflect-get": "Reflect['get'](target, key);",
    "no-chained-type-assertions": "const value = input as unknown as string;",
    "no-known-value-widening": "const value: unknown = {};",
    "no-widen-then-assert": "const value: unknown = {}; const narrowed = value as string;",
    "no-runtime-typeof": "typeof input;",
    "require-safety-comment-for-type-assertion": "const value = input as string;",
    "no-object-parameters": "function use(value: object) {}",
    "no-unknown-returns": "function use(): unknown {}",
    "no-unknown-type-aliases": "type Value = unknown;",
    "no-unsafe-dictionary-type": "type Value = Record<string, unknown>;",
    "prefer-disposable-stack": "try { work(); } finally { release(); }",
    "require-result-handling":
      "import { trySync } from '@openorb/result'; const result = trySync(work, toError);",
    "no-generic-error-throw": "throw new Error('failed');",
    "no-catch": "try { work(); } catch { recover(); }",
  }),
);
for (const [name, rule] of Object.entries(plugin.rules)) {
  // SAFETY: these are ESLint rules using TypeScript-ESTree's extended AST;
  // ESLint's own RuleModule type describes only the narrower JavaScript AST.
  // oxlint-disable-next-line openorb/no-chained-type-assertions
  tester.run(`openorb/${name}`, rule as unknown as Rule.RuleModule, {
    valid: [{ code: "const value = 1;", filename }],
    invalid: [{ code: cases.get(name)!, filename, errors: 1 }],
  });
}

test("custom rules honor standard rule-scoped suppression directives", () => {
  const source =
    "// eslint-disable-next-line openorb/no-runtime-typeof -- intentional boundary check\ntypeof input;\ntypeof second;";
  assertEquals(
    lintPlugin(plugin, filename, source).map(({ id }) => id),
    ["openorb/no-runtime-typeof"],
  );
});
