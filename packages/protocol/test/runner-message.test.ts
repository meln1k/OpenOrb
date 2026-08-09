import { assertEquals, assertThrows } from "@std/assert";

import { parseRunnerMessage } from "../src/index.ts";

Deno.test("validates the minimal runner envelope at runtime", () => {
  const message = parseRunnerMessage({
    version: 1,
    id: "message-1",
    type: "runner.heartbeat",
    payload: { activeSessions: 0 },
  });

  assertEquals(message.version, 1);
  assertEquals(message.type, "runner.heartbeat");
  assertEquals(message.payload, { activeSessions: 0 });
});

Deno.test("rejects an incompatible protocol version", () => {
  assertThrows(() =>
    parseRunnerMessage({
      version: 2,
      id: "message-1",
      type: "runner.heartbeat",
      payload: {},
    })
  );
});
