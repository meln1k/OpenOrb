import { deepStrictEqual as assertEquals } from "node:assert";
import { test } from "vite-plus/test";
import { lintPlugin } from "../lint-rules/test-lint.ts";
import { syntaxAntiSlopRules } from "./syntax-rules.ts";

function findings(
  source: string,
  ruleName: string,
  filename = "fixture.ts",
): { ids: string[]; texts: string[] } {
  const rule = syntaxAntiSlopRules[ruleName];
  if (!rule) throw new Error(`Missing rule: ${ruleName}`);
  const plugin = {
    meta: { name: "openorb" },
    rules: { [ruleName]: rule },
  };
  const diagnostics = lintPlugin(plugin, filename, source);
  return {
    ids: diagnostics.map((diagnostic) => diagnostic.id),
    texts: diagnostics.map((diagnostic) => source.slice(...diagnostic.range)),
  };
}

test("no-chained-type-assertions preserves chains and const exemptions", () => {
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

test("no-runtime-typeof rejects ordinary checks and type guards", () => {
  const rule = "no-runtime-typeof";
  const source =
    'if (typeof input === "string") {} function isString(v: unknown): v is string { return typeof v === "string"; }';
  assertEquals(findings(source, rule), {
    ids: ["openorb/no-runtime-typeof", "openorb/no-runtime-typeof"],
    texts: ["typeof input", "typeof v"],
  });
  assertEquals(findings("const value = input;", rule).ids, []);
});

test("require-safety-comment-for-type-assertion enforces preceding comments", () => {
  const rule = "require-safety-comment-for-type-assertion";
  const accepted =
    "// SAFETY: parser checked it\nconst a = value as UserId; const b = [1] as const; const c = /* SAFETY: checked */ value as UserId;";
  assertEquals(findings(accepted, rule).ids, []);
  const source = "const a = value as UserId; // SAFETY: too late";
  assertEquals(findings(source, rule), {
    ids: ["openorb/require-safety-comment-for-type-assertion"],
    texts: ["value as UserId"],
  });
  assertEquals(
    findings("// SAFETY: checked export\nexport const id = value as UserId;", rule).ids,
    [],
  );
  assertEquals(
    findings("// SAFETY: checked export\nexport default value as UserId;", rule).ids,
    [],
  );
  assertEquals(
    findings("// SAFETY: checked condition\nif ((value as UserId) === id) {}", rule).ids,
    [],
  );
  assertEquals(
    findings(
      "function read() {\n// SAFETY: checked branch\nif (ready) return value as UserId;\n}",
      rule,
    ).ids,
    [],
  );
  assertEquals(
    findings("// SAFETY: only the condition\nif (ready) { const id = value as UserId; }", rule).ids,
    ["openorb/require-safety-comment-for-type-assertion"],
  );
  assertEquals(
    findings(
      "// SAFETY: only the preceding export\nexport const id = value as UserId;\nexport const other = value as UserId;",
      rule,
    ).ids,
    ["openorb/require-safety-comment-for-type-assertion"],
  );
});
