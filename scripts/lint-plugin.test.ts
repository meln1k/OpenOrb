import { assertEquals } from "@std/assert";

import plugin from "@/scripts/lint-plugin.ts";

const RULE_ID = "openorb/no-record-string-unknown";

Deno.test("no-record-string-unknown rejects the prohibited type", () => {
  const source = `
type Direct = Record<string, unknown>;
type Nested = Readonly<Record< string, unknown >>;
`;

  const diagnostics = Deno.lint.runPlugin(plugin, "example.ts", source);

  assertEquals(diagnostics.map((diagnostic) => diagnostic.id), [RULE_ID, RULE_ID]);
  assertEquals(
    diagnostics.map((diagnostic) => source.slice(...diagnostic.range)),
    ["Record<string, unknown>", "Record< string, unknown >"],
  );
});

Deno.test("no-record-string-unknown allows other record shapes", () => {
  const source = `
type KnownValues = Record<string, string>;
type NumericKeys = Record<number, unknown>;
interface IndexSignature { [key: string]: unknown }
`;

  assertEquals(Deno.lint.runPlugin(plugin, "example.ts", source), []);
});
