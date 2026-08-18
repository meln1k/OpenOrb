import { assert, assertEquals, assertThrows } from "@std/assert";
import { parse } from "@remix-run/data-schema";

import {
  parseRunnerClientMessage,
  parseRunnerServerMessage,
  runnerEnrollmentRequestSchema,
  runnerEnrollmentResponseSchema,
} from "@/src/index.ts";

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
      payload: {
        observedAt: 1234,
        capacity: {
          activeSessions: 0,
          vmCpuCount: 8,
          vmMemoryMiB: 16_384,
          diskFreeMiB: 100_000,
        },
      },
    }).type,
    "runner.heartbeat",
  );
  const connected = parseRunnerServerMessage({
    version: 1,
    id: "connected-1",
    type: "runner.connected",
    payload: { runnerId: RUNNER_ID },
  });
  assert(connected.type === "runner.connected");
  assertEquals(connected.payload.runnerId, RUNNER_ID);

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

Deno.test("validates runner heartbeat capacity", () => {
  const heartbeat = {
    version: 1,
    id: "heartbeat-1",
    type: "runner.heartbeat",
    payload: {
      observedAt: 1234,
      capacity: {
        maxConcurrentSessions: 2,
        activeSessions: 1,
        vmCpuCount: 4,
        vmMemoryMiB: 8192,
        diskFreeMiB: 20_480,
      },
    },
  };

  assertEquals(parseRunnerClientMessage(heartbeat).payload, heartbeat.payload);
  assertThrows(() =>
    parseRunnerClientMessage({
      ...heartbeat,
      payload: {
        ...heartbeat.payload,
        capacity: { ...heartbeat.payload.capacity, maxConcurrentSessions: 0 },
      },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      ...heartbeat,
      payload: {
        ...heartbeat.payload,
        capacity: { ...heartbeat.payload.capacity, maxConcurrentSessions: null },
      },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      ...heartbeat,
      payload: {
        ...heartbeat.payload,
        capacity: { ...heartbeat.payload.capacity, activeSessions: -1 },
      },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      ...heartbeat,
      payload: {
        ...heartbeat.payload,
        capacity: { ...heartbeat.payload.capacity, unexpected: true },
      },
    })
  );
});

Deno.test("validates bounded ordered runner reconciliation messages", () => {
  const snapshotId = "01989d78-65ee-7f6a-a97e-0f16ad134c12";
  const session = {
    id: "01989d78-65ee-7f6a-a97e-0f16ad134c13",
    projectId: "01989d78-65ee-7f6a-a97e-0f16ad134c14",
    createdAt: "2026-08-17T12:00:00Z",
    initialPromptPreview: "Inspect the repository",
    state: "created",
    lastEventCursor: 0,
  };
  const start = {
    version: 1,
    id: "reconcile-start-1",
    type: "runner.reconcile.start",
    payload: { snapshotId },
  };
  const chunk = {
    version: 1,
    id: "reconcile-chunk-1",
    type: "runner.reconcile.chunk",
    payload: { snapshotId, sequence: 0, sessions: [session] },
  };
  const complete = {
    version: 1,
    id: "reconcile-complete-1",
    type: "runner.reconcile.complete",
    payload: { snapshotId, chunkCount: 1, sessionCount: 1 },
  };

  assertEquals(parseRunnerClientMessage(start).type, "runner.reconcile.start");
  assertEquals(parseRunnerClientMessage(chunk).payload, chunk.payload);
  assertEquals(parseRunnerClientMessage(complete).payload, complete.payload);
  assertThrows(() =>
    parseRunnerClientMessage({
      ...chunk,
      payload: { ...chunk.payload, sessions: [] },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      ...chunk,
      payload: { ...chunk.payload, sessions: [session, session] },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      ...chunk,
      payload: {
        ...chunk.payload,
        sessions: [{ ...session, initialPromptPreview: " unnormalized  prompt " }],
      },
    })
  );
  assertThrows(() =>
    parseRunnerClientMessage({
      ...complete,
      payload: { ...complete.payload, chunkCount: -1 },
    })
  );
});
