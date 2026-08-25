import { assertEquals } from "@std/assert";

import { modelReference, parseModelReference } from "@/src/index.ts";

Deno.test("treats provider and model as one reference split only at the first slash", () => {
  const reference = modelReference("openai", "organization/model/version");

  assertEquals(reference, "openai/organization/model/version");
  assertEquals(parseModelReference(reference), {
    providerId: "openai",
    modelId: "organization/model/version",
  });
});
