import { assertEquals } from "@std/assert";
import { object, optional, parse, record, string } from "@remix-run/data-schema";

import { GONDOLIN_TLS_COMPATIBILITY } from "@/src/environment/gondolin/tls-compatibility.ts";
import { isSupportedDenoVersion } from "@/src/runtime/deno-version.ts";

const runnerConfigSchema = object(
  { imports: optional(record(string(), string())) },
  { unknownKeys: "passthrough" },
);

Deno.test("Gondolin TLS compatibility accepts supported Deno and guards the Gondolin pin", async () => {
  assertEquals(isSupportedDenoVersion(Deno.version.deno), true);

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
