import { assertEquals, assertStringIncludes } from "@std/assert";
import { Effect } from "effect";

import { shellWaitTimeoutMs } from "@/src/environment/gondolin/shell-timeout.ts";

Deno.test("shell timeout omission disables the host deadline", async () => {
  assertEquals(await Effect.runPromise(shellWaitTimeoutMs(undefined)), undefined);
});

Deno.test("shell timeouts include host grace and accept fractional seconds and the maximum", async () => {
  for (
    const [seconds, milliseconds] of [
      [0.001, 2001],
      [0.1, 2100],
      [120, 122000],
      [2147481.647, 2147483647],
    ] as const
  ) {
    assertEquals(await Effect.runPromise(shellWaitTimeoutMs(seconds)), milliseconds);
  }
});

Deno.test("shell timeouts reject zero, negative and nonfinite values", async () => {
  for (const seconds of [0, -0, -1, NaN, Infinity, -Infinity]) {
    const error = await Effect.runPromise(Effect.flip(shellWaitTimeoutMs(seconds)));
    assertEquals(error.message, "Invalid timeout: must be a finite, positive number of seconds.");
  }
});

Deno.test("shell timeouts reject host timer overflow including the two-second grace", async () => {
  for (const seconds of [2147481.648, 2147483.647, Number.MAX_VALUE]) {
    const error = await Effect.runPromise(Effect.flip(shellWaitTimeoutMs(seconds)));
    assertStringIncludes(error.message, "maximum is 2147481.647 seconds");
  }
});
