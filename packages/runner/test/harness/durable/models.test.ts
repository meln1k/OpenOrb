import { assertEquals, assertFalse } from "@std/assert";
import { createDurableModels } from "../../../src/harness/durable/models.ts";
import { optionsFor } from "./helpers.ts";

Deno.test({
  name: "model credentials are isolated per harness, rotate in memory, and never read ambient auth",
  permissions: { read: false, write: false, env: false, sys: false, net: false },
  async fn() {
    const runtime = { ...optionsFor("unused").modelRuntime, model: "anthropic/claude-sonnet-4-6" };
    const first = await createDurableModels(runtime);
    const second = await createDurableModels({
      ...runtime,
      credential: { type: "api_key", value: "second-secret" },
    });
    const originalAuth = await first.models.getAuth("anthropic");
    assertFalse(originalAuth === undefined);
    assertFalse(JSON.stringify(originalAuth).includes("second-secret"));
    await first.update({ ...runtime, credential: { type: "api_key", value: "rotated-secret" } });
    assertEquals(
      JSON.stringify(await first.models.getAuth("anthropic")).includes("rotated-secret"),
      true,
    );
    assertEquals(
      JSON.stringify(await second.models.getAuth("anthropic")).includes("second-secret"),
      true,
    );
    assertEquals(await first.models.getAuth("openai"), undefined);
  },
});
