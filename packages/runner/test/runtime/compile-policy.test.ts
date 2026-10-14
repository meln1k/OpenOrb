import { readFile } from "node:fs/promises";
import { test, expect } from "vite-plus/test";

test("runner development scripts use Node without obsolete permission flags", async () => {
  const config = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  expect(config.engines.node).toBe(">=26.11.1");
  for (const name of ["dev", "start"]) {
    expect(config.scripts[name]).toContain("node ");
    expect(config.scripts[name]).toContain("../../scripts/run-development-runner.ts");
    expect(config.scripts[name]).not.toMatch(/deno|--allow-/);
  }
});

test("runner SEA builds disable runtime option injection and platform-specific caches", async () => {
  const source = await readFile(
    new URL("../../../../scripts/build-runner.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain('nodeVersion: "26.11.1"');
  expect(source).toContain('execArgvExtension: "none"');
  expect(source).toContain("useCodeCache: false");
  expect(source).toContain("useSnapshot: false");
  expect(source).toContain('fileName: "openorb-runner"');
  expect(source).toContain('"x64", "arm64"');
});
