import { assertEquals } from "@std/assert";

import type { RunnerCapacity } from "@openorb/protocol/runner-api";
import { Effect } from "effect";
import type { RunnerRecord } from "@/app/data/runner-repository.ts";
import type { RunnerRegistryService } from "@/app/runner-registry.ts";
import {
  MIN_RUNNER_DISK_FREE_MIB,
  type RunnerSelectionResult,
  selectRunnerForUser,
} from "@/app/runner-selection.ts";

const USER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";

const AVAILABLE_CAPACITY: RunnerCapacity = {
  activeSessions: 0,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: MIN_RUNNER_DISK_FREE_MIB,
};

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
    "medium",
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
    (await selectRunnerForUser(USER_ID, "available", "medium", repository, connections)).status,
    "selected",
  );
  assertEquals(
    await selectRunnerForUser(USER_ID, "full", "medium", repository, connections),
    {
      status: "rejected",
      message: "Runner has reached its concurrent session limit.",
    },
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "low-disk", "medium", repository, connections),
    `Runner has less than ${MIN_RUNNER_DISK_FREE_MIB} MiB of free disk space.`,
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "revoked", "medium", repository, connections),
    "Runner has been revoked.",
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "foreign-runner", "medium", repository, connections),
    "Runner is unavailable or does not exist.",
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "offline", "medium", {
      listRunners: () => Promise.resolve([...runners, runnerRecord("offline")]),
    }, connections),
    "Runner is offline.",
  );
  assertSelectionRejected(
    await selectRunnerForUser(USER_ID, "available", "xxlarge", repository, connections),
    "Runner cannot provision the xxlarge orb size.",
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
    createdAt: Temporal.Instant.from("2026-01-01T00:00:00Z"),
    revokedAt: null,
  };
}

function liveConnections(
  capacities: Map<string, RunnerCapacity>,
): Pick<RunnerRegistryService, "getRunnerLiveState"> {
  return {
    getRunnerLiveState(userId: string, runnerId: string) {
      assertEquals(userId, USER_ID);
      const capacity = capacities.get(runnerId);
      return Effect.succeed(
        capacity
          ? {
            capacity: { ...capacity, maxConcurrentSessions: capacity.maxConcurrentSessions ?? 4 },
            lastObservedAt: Date.now(),
          }
          : null,
      );
    },
  };
}
