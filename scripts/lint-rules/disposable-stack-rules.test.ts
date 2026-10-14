import { deepStrictEqual as assertEquals } from "node:assert";
import { test } from "vite-plus/test";
import { lintPlugin } from "./test-lint.ts";

import plugin from "../lint-plugin.ts";

const RULE = "openorb/prefer-disposable-stack";
const FILENAME = "packages/runner/src/example.ts";

function diagnostics(source: string, filename = FILENAME) {
  return lintPlugin(plugin, filename, source).filter(({ id }) => id === RULE);
}

test("application try/finally cleanup must use a disposable stack", () => {
  assertEquals(
    diagnostics("try { work(); } finally { cleanup(); }").map(({ id }) => id),
    [RULE],
  );
  assertEquals(
    diagnostics("try { work(); } catch { recover(); } finally { cleanup(); }").map(({ id }) => id),
    [RULE],
  );
});

test("try/catch and disposable stacks remain valid", () => {
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

test("test cleanup may continue using try/finally", () => {
  assertEquals(
    diagnostics(
      "try { await exercise(); } finally { await cleanup(); }",
      "packages/runner/test/example.test.ts",
    ),
    [],
  );
});

test("browser cleanup may use try/finally without unsupported disposable syntax", () => {
  const source = "try { await exercise(); } finally { await cleanup(); }";
  assertEquals(diagnostics(source, "packages/gateway/app/actions/sessions/public/example.tsx"), []);
  assertEquals(diagnostics(source, "packages/gateway/app/ui/public/components/example.tsx"), []);
  assertEquals(diagnostics(source, "packages/gateway/app/public/client.ts"), []);
  assertEquals(
    diagnostics(source, "packages/gateway/app/actions/example.tsx").map(({ id }) => id),
    [RULE],
  );
});
