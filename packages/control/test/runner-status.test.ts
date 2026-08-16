import { assert, assertEquals } from "@std/assert";

import type { RunnerCapacity } from "@openorb/protocol";
import type { RunnerRecord } from "@/app/data/runner-repository.ts";
import { RunnerConnectionGateway } from "@/app/runner-connection-gateway.ts";
import {
  MIN_RUNNER_DISK_FREE_MIB,
  type RunnerSelectionResult,
  selectRunnerForUser,
} from "@/app/runner-selection.ts";
import { createTestServer } from "@/test/http-test-server.ts";

const USER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const OTHER_USER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
const RUNNER_TOKEN = `openorb_runner_${"a".repeat(43)}`;

const AVAILABLE_CAPACITY: RunnerCapacity = {
  activeSessions: 0,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: MIN_RUNNER_DISK_FREE_MIB,
};

Deno.test("heartbeat capacity is tenant scoped and times out the connection", async () => {
  const gateway = new RunnerConnectionGateway(
    {
      authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId: USER_ID }),
    },
    { heartbeatTimeoutMs: 50 },
  );
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await openWebSocket(server.baseUrl);
    socket.send(JSON.stringify({
      version: 1,
      id: "hello-1",
      type: "runner.hello",
      payload: { token: RUNNER_TOKEN },
    }));
    await nextMessage(socket);
    socket.send(JSON.stringify({
      version: 1,
      id: "heartbeat-1",
      type: "runner.heartbeat",
      payload: { observedAt: Date.now(), capacity: AVAILABLE_CAPACITY },
    }));

    await waitFor(() => gateway.getRunnerLiveState(USER_ID, RUNNER_ID) !== null);
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID)?.capacity, AVAILABLE_CAPACITY);
    assertEquals(gateway.getRunnerLiveState(OTHER_USER_ID, RUNNER_ID), null);

    const closeEvent = await closed(socket);
    assertEquals(closeEvent.code, 4408);
    assertEquals(gateway.getRunnerLiveState(USER_ID, RUNNER_ID), null);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("invalid heartbeat capacity is rejected", async () => {
  const gateway = new RunnerConnectionGateway({
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId: USER_ID }),
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await openWebSocket(server.baseUrl);
    socket.send(JSON.stringify({
      version: 1,
      id: "hello-1",
      type: "runner.hello",
      payload: { token: RUNNER_TOKEN },
    }));
    await nextMessage(socket);
    const closeEvent = closed(socket);
    socket.send(JSON.stringify({
      version: 1,
      id: "heartbeat-1",
      type: "runner.heartbeat",
      payload: {
        observedAt: Date.now(),
        capacity: { ...AVAILABLE_CAPACITY, diskFreeMiB: -1 },
      },
    }));
    assertEquals((await closeEvent).code, 4400);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("selects deterministically by active sessions and runner id", async () => {
  const runners = [runnerRecord("runner-b"), runnerRecord("runner-a"), runnerRecord("runner-c")];
  const capacities = new Map([
    ["runner-a", { ...AVAILABLE_CAPACITY, activeSessions: 1 }],
    ["runner-b", { ...AVAILABLE_CAPACITY, activeSessions: 1 }],
    ["runner-c", { ...AVAILABLE_CAPACITY, activeSessions: 2 }],
  ]);
  const result = await selectRunnerForUser(
    USER_ID,
    undefined,
    { listRunners: () => Promise.resolve(runners) },
    liveConnections(capacities),
  );

  assertEquals(result.status, "selected");
  if (result.status === "selected") assertEquals(result.runner.id, "runner-a");
});

Deno.test("manual selection reports unavailable, full, low-disk, and foreign runners clearly", async () => {
  const available = runnerRecord("available");
  const full = runnerRecord("full");
  const lowDisk = runnerRecord("low-disk");
  const revoked = { ...runnerRecord("revoked"), revokedAt: Temporal.Now.instant() };
  const runners = [available, full, lowDisk, revoked];
  const repository = { listRunners: () => Promise.resolve(runners) };
  const connections = liveConnections(
    new Map([
      ["available", AVAILABLE_CAPACITY],
      ["full", { ...AVAILABLE_CAPACITY, maxConcurrentSessions: 2, activeSessions: 2 }],
      ["low-disk", { ...AVAILABLE_CAPACITY, diskFreeMiB: MIN_RUNNER_DISK_FREE_MIB - 1 }],
    ]),
  );

  assertEquals(
    (await selectRunnerForUser(USER_ID, "available", repository, connections)).status,
    "selected",
  );
  assertEquals(
    await selectRunnerForUser(USER_ID, "full", repository, connections),
    {
      status: "rejected",
      message: "Runner has reached its concurrent session limit.",
    },
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "low-disk", repository, connections),
    `Runner has less than ${MIN_RUNNER_DISK_FREE_MIB} MiB of free disk space.`,
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "revoked", repository, connections),
    "Runner has been revoked.",
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "foreign-runner", repository, connections),
    "Runner is unavailable or does not exist.",
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "offline", {
      listRunners: () => Promise.resolve([...runners, runnerRecord("offline")]),
    }, connections),
    "Runner is offline.",
  );
});

function assertSelectionRejected(
  result: RunnerSelectionResult,
  message: string,
): void {
  assertEquals(result, { status: "rejected", message });
}

function runnerRecord(id: string): RunnerRecord {
  return {
    id,
    name: id,
    architecture: "x64",
    capabilities: ["heartbeat"],
    createdAt: Temporal.Instant.from("2026-01-01T00:00:00Z"),
    revokedAt: null,
  };
}

function liveConnections(capacities: Map<string, RunnerCapacity>) {
  return {
    getRunnerLiveState(userId: string, runnerId: string) {
      assertEquals(userId, USER_ID);
      const capacity = capacities.get(runnerId);
      return capacity ? { capacity, lastHeartbeatAt: Date.now() } : null;
    },
  };
}

async function openWebSocket(url: URL): Promise<WebSocket> {
  const socketUrl = new URL(url);
  socketUrl.protocol = "ws:";
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), {
      once: true,
    });
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket message failed.")), {
      once: true,
    });
  });
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event), { once: true });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert(Date.now() < deadline, "timed out waiting for runner state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
