import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";

import { importStandaloneRunner } from "@/src/standalone.ts";

const SECRET_CANARY = "INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN";

Deno.test("standalone imports see only the approved environment and restore the host environment", async () => {
  const process = (await import("node:process")).default;
  const originalEnvironment = process.env;
  const originalCanary = Deno.env.get(SECRET_CANARY);
  Deno.env.set(SECRET_CANARY, "must-not-enter-the-module-graph");

  try {
    await importStandaloneRunner(() => {
      assertEquals(Object.getPrototypeOf(process.env), null);
      assertEquals(
        Object.keys(process.env).sort(),
        ["PATH", "PWD"].filter((name) => originalEnvironment[name] !== undefined),
      );
      assertEquals(process.env[SECRET_CANARY], undefined);
      assertEquals(process.env.AI_AGENT, undefined);
      assertEquals(process.env.APPVEYOR, undefined);
      assertEquals(process.env.CI, undefined);
      return Promise.resolve({ runMain() {} });
    });

    assertStrictEquals(process.env, originalEnvironment);
    assertEquals(process.env[SECRET_CANARY], "must-not-enter-the-module-graph");

    await assertRejects(
      () => importStandaloneRunner(() => Promise.reject(new Error("import failed"))),
      Error,
      "import failed",
    );
    assertStrictEquals(process.env, originalEnvironment);
  } finally {
    if (originalCanary === undefined) Deno.env.delete(SECRET_CANARY);
    else Deno.env.set(SECRET_CANARY, originalCanary);
  }
});
