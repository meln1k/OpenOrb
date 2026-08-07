import assert from "node:assert/strict";
import test from "node:test";

import { parseRunnerMessage } from "../src/index.ts";

test("validates the minimal runner envelope at runtime", () => {
  let message = parseRunnerMessage({
    version: 1,
    id: "message-1",
    type: "runner.heartbeat",
    payload: { activeSessions: 0 },
  });

  assert.equal(message.version, 1);
  assert.equal(message.type, "runner.heartbeat");
  assert.deepEqual(message.payload, { activeSessions: 0 });
});

test("rejects an incompatible protocol version", () => {
  assert.throws(() =>
    parseRunnerMessage({
      version: 2,
      id: "message-1",
      type: "runner.heartbeat",
      payload: {},
    }),
  );
});
