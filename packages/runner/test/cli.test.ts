import { assertEquals } from "@std/assert";

import { main } from "../src/index.ts";

Deno.test("does not accept a configurable data directory", async () => {
  assertEquals(await main(["--data-dir", "/tmp/openorb"]), 2);
  assertEquals(await main(["--data-dir=/tmp/openorb"]), 2);
});

Deno.test("reports standalone build metadata without probing QEMU", async () => {
  assertEquals(await main(["--version"]), 0);
});
