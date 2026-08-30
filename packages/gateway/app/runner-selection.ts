import { type OrbSize, orbSizeResources } from "@openorb/protocol";
import { Effect } from "effect";

import type { RunnerRecord, RunnerRepository } from "@/app/data/runner-repository.ts";
import type { RunnerLiveState, RunnerRegistryService } from "@/app/runner-registry.ts";

export const MIN_RUNNER_DISK_FREE_MIB = 10 * 1024;

export type RunnerSelectionResult =
  | {
    status: "selected";
    runner: RunnerRecord;
    liveState: RunnerLiveState;
  }
  | {
    status: "rejected";
    message: string;
  };

export async function selectRunnerForUser(
  userId: string,
  manualRunnerId: string | undefined,
  orbSize: OrbSize,
  repository: Pick<RunnerRepository, "listRunners">,
  connections: Pick<RunnerRegistryService, "getRunnerLiveState">,
): Promise<RunnerSelectionResult> {
  const runners = await repository.listRunners(userId);

  if (manualRunnerId !== undefined) {
    const runner = runners.find((candidate) => candidate.id === manualRunnerId);
    if (!runner) return rejected("Runner is unavailable or does not exist.");
    return await assessRunner(userId, runner, orbSize, connections);
  }

  const available: Array<Extract<RunnerSelectionResult, { status: "selected" }>> = [];
  for (const runner of runners) {
    const assessed = await assessRunner(userId, runner, orbSize, connections);
    if (assessed.status === "selected") available.push(assessed);
  }
  available.sort((left, right) =>
    left.liveState.capacity.activeSessions - right.liveState.capacity.activeSessions ||
    left.runner.id.localeCompare(right.runner.id)
  );

  return available[0] ?? rejected(
    `No connected runner has available capacity and at least ${MIN_RUNNER_DISK_FREE_MIB} MiB of free disk space.`,
  );
}

async function assessRunner(
  userId: string,
  runner: RunnerRecord,
  orbSize: OrbSize,
  connections: Pick<RunnerRegistryService, "getRunnerLiveState">,
): Promise<RunnerSelectionResult> {
  if (runner.revokedAt !== null) return rejected("Runner has been revoked.");
  const liveState = await Effect.runPromise(connections.getRunnerLiveState(userId, runner.id));
  if (!liveState) return rejected("Runner is offline.");

  const { diskFreeMiB } = liveState.capacity;
  if (diskFreeMiB < MIN_RUNNER_DISK_FREE_MIB) {
    return rejected(
      `Runner has less than ${MIN_RUNNER_DISK_FREE_MIB} MiB of free disk space.`,
    );
  }
  const resources = orbSizeResources(orbSize);
  if (
    resources.cpuCount > liveState.capacity.vmCpuCount ||
    resources.memoryMiB > liveState.capacity.vmMemoryMiB
  ) {
    return rejected(`Runner cannot provision the ${orbSize} orb size.`);
  }
  return { status: "selected", runner, liveState };
}

function rejected(message: string): RunnerSelectionResult {
  return { status: "rejected", message };
}
