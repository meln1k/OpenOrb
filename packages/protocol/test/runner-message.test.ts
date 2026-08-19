import { assertEquals, assertThrows } from "@std/assert";

import { parseRunnerMessage, type RunnerCapacity, type RunnerMessage } from "@/src/index.ts";

Deno.test("validates the minimal runner envelope at runtime", () => {
  const input = {
    version: 1,
    id: "message-1",
    type: "runner.heartbeat",
    payload: { activeSessions: 0 },
  } satisfies RunnerMessage<{ activeSessions: number }>;
  const message = parseRunnerMessage(input);

  assertEquals(message.version, 1);
  assertEquals(message.type, "runner.heartbeat");
  assertEquals(message.payload, { activeSessions: 0 });
  assertEquals("sessionId" in message, false);
  assertEquals("correlationId" in message, false);
});

Deno.test("keeps schema-optional capacity fields optional in public types", () => {
  const capacity = {
    activeSessions: 0,
    vmCpuCount: 8,
    vmMemoryMiB: 16_384,
    diskFreeMiB: 100_000,
  } satisfies RunnerCapacity;

  assertEquals("maxConcurrentSessions" in capacity, false);
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
