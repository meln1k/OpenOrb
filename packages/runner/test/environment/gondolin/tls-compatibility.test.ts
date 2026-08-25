import { assertEquals } from "@std/assert";
import { object, optional, parse, record, string } from "@remix-run/data-schema";

import { GONDOLIN_TLS_COMPATIBILITY } from "@/src/environment/gondolin/tls-compatibility.ts";
import { REQUIRED_DENO_VERSION } from "@/src/runtime/prerequisites.ts";

const runnerConfigSchema = object(
  { imports: optional(record(string(), string())) },
  { unknownKeys: "passthrough" },
);

Deno.test("Gondolin TLS compatibility requires review when Deno or Gondolin changes", async () => {
  assertEquals(
    REQUIRED_DENO_VERSION,
    GONDOLIN_TLS_COMPATIBILITY.denoVersion,
    "Review the TLS compatibility shim before changing the required Deno version.",
  );
  assertEquals(
    Deno.version.deno,
    GONDOLIN_TLS_COMPATIBILITY.denoVersion,
    "Run the repository with the Deno version validated by the TLS compatibility shim.",
  );

  const config = parse(
    runnerConfigSchema,
    JSON.parse(await Deno.readTextFile(new URL("../../../deno.json", import.meta.url))),
  );
  assertEquals(
    config.imports?.["@earendil-works/gondolin"],
    `npm:@earendil-works/gondolin@${GONDOLIN_TLS_COMPATIBILITY.gondolinVersion}`,
    "Review the TLS compatibility shim before changing the Gondolin version.",
  );
});
