import { deepStrictEqual as assertEquals } from "node:assert";
import { test } from "vite-plus/test";
import { type Diagnostic, lintPlugin } from "../lint-rules/test-lint.ts";
import { callAntiSlopRules } from "./call-rules.ts";

const plugin = { meta: { name: "openorb" }, rules: callAntiSlopRules };

function lint(source: string): Diagnostic[] {
  return lintPlugin(plugin, "fixture.ts", source);
}

for (const [rule, method] of [
  ["no-reflect-apply", "apply"],
  ["no-reflect-get", "get"],
] as const) {
  test(`${rule} rejects static and computed global calls with representative ranges`, () => {
    const source = `Reflect.${method}(target, key);\nReflect["${method}"](target, key);`;
    const diagnostics = lint(source).filter(({ id }) => id === `openorb/${rule}`);
    assertEquals(
      diagnostics.map(({ id }) => id),
      [`openorb/${rule}`, `openorb/${rule}`],
    );
    assertEquals(
      diagnostics.map(({ range }) => source.slice(...range)),
      [`Reflect.${method}(target, key)`, `Reflect["${method}"](target, key)`],
    );
  });

  test(`${rule} allows other methods and lexical Reflect shadows`, () => {
    const source = `Reflect.other(target, key);
function use(Reflect: { ${method}(...values: unknown[]): void }) { Reflect.${method}(); }
{ Reflect.${method}(); const Reflect = { ${method}() {} }; }
const { Reflect } = helpers;
Reflect.${method}();`;
    assertEquals(lint(source), []);
  });
}
