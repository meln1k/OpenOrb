/// <reference lib="deno.unstable" />

import { assertEquals } from "@std/assert";
import { syntaxAntiSlopRules } from "./syntax-rules.ts";

function findings(
  source: string,
  ruleName: string,
  filename = "fixture.ts",
): { ids: string[]; texts: string[] } {
  const rule = syntaxAntiSlopRules[ruleName];
  if (!rule) throw new Error(`Missing rule: ${ruleName}`);
  const plugin = {
    name: "openorb",
    rules: { [ruleName]: rule },
  } satisfies Deno.lint.Plugin;
  const diagnostics = Deno.lint.runPlugin(plugin, filename, source);
  return {
    ids: diagnostics.map((diagnostic) => diagnostic.id),
    texts: diagnostics.map((diagnostic) => source.slice(...diagnostic.range)),
  };
}

Deno.test("no-chained-type-assertions preserves chains and const exemptions", () => {
  const rule = "no-chained-type-assertions";
  assertEquals(findings("const a = (value as unknown) as string;", rule).texts, [
    "(value as unknown) as string",
  ]);
  assertEquals(findings("const a = <string>(<unknown>value);", rule).ids, [
    "openorb/no-chained-type-assertions",
  ]);
  assertEquals(findings("const a = value as string; const b = [1] as const;", rule), {
    ids: [],
    texts: [],
  });
});

Deno.test("no-runtime-typeof rejects ordinary checks and type guards", () => {
  const rule = "no-runtime-typeof";
  const source =
    'if (typeof input === "string") {} function isString(v: unknown): v is string { return typeof v === "string"; }';
  assertEquals(findings(source, rule), {
    ids: ["openorb/no-runtime-typeof", "openorb/no-runtime-typeof"],
    texts: ["typeof input", "typeof v"],
  });
  assertEquals(findings("const value = input;", rule).ids, []);
});

Deno.test("require-safety-comment-for-type-assertion enforces preceding comments", () => {
  const rule = "require-safety-comment-for-type-assertion";
  const accepted =
    "// SAFETY: parser checked it\nconst a = value as UserId; const b = [1] as const; const c = /* SAFETY: checked */ value as UserId;";
  assertEquals(findings(accepted, rule).ids, []);
  const source = "const a = value as UserId; // SAFETY: too late";
  assertEquals(findings(source, rule), {
    ids: ["openorb/require-safety-comment-for-type-assertion"],
    texts: ["value as UserId"],
  });
});
