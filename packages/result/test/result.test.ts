import { assertEquals, assertStrictEquals } from "@std/assert";

import { err, ok, tryAsync, trySync } from "@/src/index.ts";

Deno.test("result constructors preserve values and errors", () => {
  assertEquals(ok(42), [42, undefined]);
  const failure = new Error("failed");
  const result = err(failure);
  assertStrictEquals(result[0], undefined);
  assertStrictEquals(result[1], failure);
});

Deno.test("trySync maps only thrown causes", () => {
  assertEquals(trySync(() => 42, String), [42, undefined]);
  const cause = new Error("failed");
  const result = trySync(
    () => {
      throw cause;
    },
    (error) => ({ type: "sync-failure" as const, cause: error }),
  );
  assertEquals(result, [undefined, { type: "sync-failure", cause }]);
});

Deno.test("tryAsync maps only rejected causes", async () => {
  assertEquals(await tryAsync(Promise.resolve(42), String), [42, undefined]);
  const cause = new Error("failed");
  const result = await tryAsync(
    Promise.reject(cause),
    (error) => ({ type: "async-failure" as const, cause: error }),
  );
  assertEquals(result, [undefined, { type: "async-failure", cause }]);
});
