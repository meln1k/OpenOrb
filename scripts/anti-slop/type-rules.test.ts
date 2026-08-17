/// <reference lib="deno.unstable" />

import { assertEquals } from "@std/assert";
import { typeAntiSlopRules } from "./type-rules.ts";

function lint(code: string, rule: string) {
  const selected = typeAntiSlopRules[rule];
  if (!selected) throw new Error(`Missing rule ${rule}`);
  const plugin: Deno.lint.Plugin = { name: "openorb", rules: { [rule]: selected } };
  return Deno.lint.runPlugin(plugin, "fixture.ts", code);
}

function expect(code: string, rule: string, ranges: [number, number][]) {
  const diagnostics = lint(code, rule);
  assertEquals(diagnostics.map((item) => item.id), ranges.map(() => `openorb/${rule}`));
  assertEquals(diagnostics.map((item) => [item.range[0], item.range[1]]), ranges);
}

Deno.test("no-object-parameters handles wrappers, aliases, unions, and generic shadowing", () => {
  const code = `type Broad = object; function a(value: object) {} function b(...values: Broad[]) {}
function c<T>(value: T) {} function d<Broad>(value: Broad) {} function e(value: string | object) {}`;
  expect(code, "no-object-parameters", [[39, 45], [164, 179]]);
});

Deno.test("no-unknown-returns handles aliases, promises, unions, cycles, and shadowing", () => {
  const code = `type U = unknown; type A = B; type B = A;
function a(): unknown {} const b = (): Promise<U> => Promise.resolve(1); function c(): string | unknown { return ""; }
function d<U>(): U { throw 1; } function e(): A { throw 1; }`;
  expect(code, "no-unknown-returns", [[56, 63], [81, 91], [129, 145]]);
});

Deno.test("no-unknown-type-aliases reports direct and transitive but not generic or cycles", () => {
  const code =
    `type A = unknown; type B = A; type Box<T> = T; type C = Box<unknown>; type X = Y; type Y = X;`;
  expect(code, "no-unknown-type-aliases", [[5, 6], [23, 24]]);
});

Deno.test("no-unsafe-dictionary-type classifies Record, index, mapped, aliases and shadowing", () => {
  const code = `type Box<T = unknown> = Record<string, T>; type A = Box;
type B = Record<string, unknown>; type C = { [key: string]: object };
type D = { [K in "x"]: any }; interface Escape {} type E = Record<string, Escape>;
interface Indexed { [key: string]: unknown }
type Good = Record<string, number>; const first: B = {}; const second: B = {};`;
  const diagnostics = lint(code, "no-unsafe-dictionary-type");
  assertEquals(
    diagnostics.map((item) => item.id),
    Array(6).fill("openorb/no-unsafe-dictionary-type"),
  );
  assertEquals(diagnostics.map((item) => code.slice(...item.range)), [
    "Box",
    "Record<string, unknown>",
    "{ [key: string]: object }",
    '{ [K in "x"]: any }',
    "Record<string, Escape>",
    "[key: string]: unknown",
  ]);
});

Deno.test("no-unsafe-dictionary-type honors shadowed built-ins and merged interfaces", () => {
  const code = `type Record<K, V> = Map<K, V>; type Local = Record<string, unknown>;
interface Escape {} interface Escape { readonly id: string }
type Merged = globalThis.Record<string, Escape>;`;
  assertEquals(lint(code, "no-unsafe-dictionary-type"), []);
});

Deno.test("no-unsafe-dictionary-type resolves chained generic defaults without recursing", () => {
  const safe =
    "type Value<T> = T; type Index<T = Command, U = Value<T>> = Record<string, U>; type A = Index;";
  assertEquals(lint(safe, "no-unsafe-dictionary-type"), []);

  const unsafe =
    "type Value<T> = T; type Index<T, U = Value<T>> = Record<string, U>; type A = Index<unknown>;";
  assertEquals(
    lint(unsafe, "no-unsafe-dictionary-type").map((diagnostic) => diagnostic.id),
    ["openorb/no-unsafe-dictionary-type"],
  );
});
