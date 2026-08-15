import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "@remix-run/data-schema";

import {
  parseRunnerClientMessage,
  parseRunnerServerMessage,
  runnerEnrollmentRequestSchema,
  runnerEnrollmentResponseSchema,
} from "../src/index.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const ENROLLMENT_PSK = `openorb_enroll_${"a".repeat(43)}`;
const RUNNER_TOKEN = `openorb_runner_${"b".repeat(43)}`;

Deno.test("validates runner enrollment request and response payloads", () => {
  assertEquals(
    parse(runnerEnrollmentRequestSchema, {
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "arm64",
      capabilities: ["heartbeat"],
    }),
    {
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "arm64",
      capabilities: ["heartbeat"],
    },
  );
  assertEquals(
    parse(runnerEnrollmentResponseSchema, { runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN }),
    { runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN },
  );

  assertThrows(() =>
    parse(runnerEnrollmentRequestSchema, {
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "riscv64",
      capabilities: ["heartbeat"],
    })
  );
  assertThrows(() =>
    parse(runnerEnrollmentRequestSchema, {
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "x64",
      capabilities: ["heartbeat", "heartbeat"],
    })
  );
});

Deno.test("validates only the connection messages used by runner enrollment", () => {
  assertEquals(
    parseRunnerClientMessage({
      version: 1,
      id: "hello-1",
      type: "runner.hello",
      payload: { token: RUNNER_TOKEN },
    }).type,
    "runner.hello",
  );
  assertEquals(
    parseRunnerClientMessage({
      version: 1,
      id: "heartbeat-1",
      type: "runner.heartbeat",
      payload: { observedAt: 1234 },
    }).type,
    "runner.heartbeat",
  );
  assertEquals(
    parseRunnerServerMessage({
      version: 1,
      id: "connected-1",
      type: "runner.connected",
      payload: { runnerId: RUNNER_ID },
    }).payload.runnerId,
    RUNNER_ID,
  );

  assertThrows(() =>
    parseRunnerClientMessage({
      version: 2,
      id: "hello-1",
      type: "runner.hello",
      payload: { token: RUNNER_TOKEN },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      version: 1,
      id: "future-1",
      type: "session.provision",
      payload: {},
    })
  );
});
