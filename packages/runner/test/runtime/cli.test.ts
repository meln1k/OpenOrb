import { test } from "vite-plus/test";
import { assertEquals } from "@jsr/std__assert";
import { execFileSync } from "node:child_process";

import { main } from "../../src/index.ts";

test("source entrypoint runs directly on Node without a TypeScript transformer", () => {
  const output = execFileSync(
    process.execPath,
    [new URL("../../src/standalone.ts", import.meta.url).pathname, "--help"],
    { encoding: "utf8" },
  );
  assertEquals(output.includes("--enrollment-token"), true);
});

test("help succeeds without enrollment or working-directory configuration", async () => {
  assertEquals(await main(["--help"]), 0);
  assertEquals(await main(["-h"]), 0);
});

test("does not accept a configurable data directory", async () => {
  assertEquals(await main(["--data-dir", "/tmp/openorb"]), 2);
  assertEquals(await main(["--data-dir=/tmp/openorb"]), 2);
});
