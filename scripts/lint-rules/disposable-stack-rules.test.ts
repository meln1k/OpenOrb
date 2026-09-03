/// <reference lib="deno.unstable" />

import { assertEquals } from "@std/assert";

import plugin from "@/scripts/lint-plugin.ts";

const RULE = "openorb/prefer-disposable-stack";
const FILENAME = "packages/runner/src/example.ts";

function diagnostics(source: string, filename = FILENAME) {
  return Deno.lint.runPlugin(plugin, filename, source).filter(({ id }) => id === RULE);
}

Deno.test("application try/finally cleanup must use a disposable stack", () => {
  assertEquals(
    diagnostics("try { work(); } finally { cleanup(); }").map(({ id }) => id),
    [RULE],
  );
  assertEquals(
    diagnostics("try { work(); } catch { recover(); } finally { cleanup(); }").map(({ id }) => id),
    [RULE],
  );
});

Deno.test("try/catch and disposable stacks remain valid", () => {
  assertEquals(diagnostics("try { work(); } catch { recover(); }"), []);
  assertEquals(
    diagnostics(`
using cleanup = new DisposableStack();
cleanup.defer(() => release());
work();
`),
    [],
  );
  assertEquals(
    diagnostics(`
await using cleanup = new AsyncDisposableStack();
cleanup.defer(async () => await release());
await work();
`),
    [],
  );
});

Deno.test("test cleanup may continue using try/finally", () => {
  assertEquals(
    diagnostics(
      "try { await exercise(); } finally { await cleanup(); }",
      "packages/runner/test/example.test.ts",
    ),
    [],
  );
});

Deno.test("browser cleanup may use try/finally without unsupported disposable syntax", () => {
  const source = "try { await exercise(); } finally { await cleanup(); }";
  assertEquals(
    diagnostics(source, "packages/gateway/app/ui/session/example.tsx"),
    [],
  );
  assertEquals(
    diagnostics(source, "packages/gateway/app/assets/client.ts"),
    [],
  );
  assertEquals(
    diagnostics(source, "packages/gateway/app/actions/example.tsx").map(({ id }) => id),
    [RULE],
  );
});
