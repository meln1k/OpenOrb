/// <reference lib="deno.unstable" />

import { assertEquals } from "@std/assert";
import { flowAntiSlopRules } from "./flow-rules.ts";

const plugin = { name: "openorb", rules: flowAntiSlopRules } satisfies Deno.lint.Plugin;

function diagnostics(code: string, rule: keyof typeof flowAntiSlopRules) {
  return Deno.lint.runPlugin(plugin, "fixture.ts", code).filter((item) =>
    item.id === `openorb/${rule}`
  );
}

Deno.test("no-known-value-widening covers explicit flows and aliases", () => {
  const cases = [
    "const value: unknown = {};",
    "const value: object = [];",
    "type Command = () => void; const start = () => {}; const commands: Record<string, Command> = { start };",
    "type Command = () => void; type Index<T> = Record<string, T>; const start = () => {}; const commands: Index<Command> = { start };",
    "function create(): unknown { return {}; }",
    "const create = (): object => [];",
    "class Registry { commands: Record<string, () => void> = { start() {} }; }",
    "let value: unknown; value = {};",
    "const source = { id: 1 }; const value: object = source;",
    "const value = { id: 1 } as object;",
  ];
  for (const code of cases) {
    const result = diagnostics(code, "no-known-value-widening");
    assertEquals(result.length, 1, code);
    assertEquals(result[0]?.id, "openorb/no-known-value-widening");
  }
  const range = diagnostics("const value: unknown = {};", "no-known-value-widening")[0]?.range;
  assertEquals(range, [23, 25]);
});

Deno.test("no-known-value-widening permits inference, contracts, and empty accumulators", () => {
  const cases = [
    "const value = { id: 1 };",
    "interface Value { id: number } const value: Value = { id: 1 };",
    "type Value = { id: number }; const value: Value = { id: 1 };",
    "type PermissionLevels = { [Level in Permission]: number }; const levels: PermissionLevels = { admin: 1 };",
    "const value = { id: 1 } satisfies Record<string, number>;",
    "const commands: Record<string, () => void> = {};",
    "type Index<T> = Record<string, T>; const commands: Index<() => void> = {};",
    "declare function make(): object; const value: object = make();",
    "import { Record } from './types.ts'; const value: Record<string, number> = { id: 1 };",
  ];
  for (const code of cases) assertEquals(diagnostics(code, "no-known-value-widening"), [], code);
});

Deno.test("no-widen-then-assert requires a certain immutable binding", () => {
  const code =
    "const source = { id: 'second' }; const widened: unknown = source; const parsed = widened as { readonly id: string };";
  const result = diagnostics(code, "no-widen-then-assert");
  assertEquals(result.length, 1);
  assertEquals(result[0]?.id, "openorb/no-widen-then-assert");
  assertEquals(result[0]?.range, [81, 115]);

  const assertedWidening =
    "const source = { id: 1 }; const widened = source as unknown; const parsed = widened as { id: number };";
  assertEquals(diagnostics(assertedWidening, "no-widen-then-assert").length, 1);
  const recordWidening =
    "const source = { id: 1 }; const widened: Record<string, unknown> = source; const parsed = widened as Record<string, number>;";
  assertEquals(diagnostics(recordWidening, "no-widen-then-assert").length, 1);

  const valid = [
    "const source = { id: 'first' }; const widened: unknown = source;",
    "declare const input: unknown; const parsed = input as { readonly id: string };",
    "let widened: unknown = { id: 1 }; widened = input; const parsed = widened as { id: number };",
    "const value: unknown = { id: 1 }; { const value = input; const parsed = value as { id: number }; }",
    "function outer() { const value: unknown = { id: 1 }; function inner(value: unknown) { return value as { id: number }; } }",
    "const value: unknown = make(); const parsed = value as { id: number };",
    "const value: object = { id: 1 }; const parsed = value as string;",
    "const value: Record<string, unknown> = { id: 1 }; const parsed = value as string;",
  ];
  for (const sample of valid) assertEquals(diagnostics(sample, "no-widen-then-assert"), [], sample);
});
