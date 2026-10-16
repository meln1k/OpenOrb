import { Effect, Schedule, Schema, Stream } from "effect";
import {
  RunnerCapacity,
  type RunnerStateEvent,
  RunnerWatchError,
} from "@openorb/protocol/runner-api";

import { EnvironmentSupervisor } from "../environment/session/supervisor.ts";

export function watchRunner(getCapacity: () => Promise<RunnerCapacity>) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const environments = yield* EnvironmentSupervisor;
      // Subscribed before the snapshot is read, so no change between the two is missed.
      const changes = yield* environments.changes;
      const capacity = yield* readCapacity(getCapacity);
      const snapshot = environments.snapshots();
      const observed = Stream.fromEffect(readCapacity(getCapacity)).pipe(
        Stream.repeat(Schedule.spaced("10 seconds")),
        Stream.map((capacity): RunnerStateEvent => ({
          type: "runner.observed",
          observedAt: Date.now(),
          capacity,
        })),
      );
      const environmentChanges = changes.pipe(
        Stream.map((environment): RunnerStateEvent => ({
          type: "environment.changed",
          environment,
        })),
      );
      return Stream.concat(
        Stream.make({
          type: "snapshot" as const,
          observedAt: Date.now(),
          capacity,
          environments: snapshot,
        } satisfies RunnerStateEvent),
        Stream.mergeAll([observed, environmentChanges], { concurrency: "unbounded" }).pipe(
          Stream.onStart(
            Effect.logInfo("snapshot.sent").pipe(
              Effect.annotateLogs({
                component: "openorb-runner",
                environmentCount: snapshot.length,
              }),
            ),
          ),
        ),
      );
    }),
  );
}

/** Capacity as the runner measured it, validated so a bad reading fails the watch. */
function readCapacity(getCapacity: () => Promise<RunnerCapacity>) {
  return Effect.callback<RunnerCapacity, RunnerWatchError>((resume) => {
    getCapacity().then(
      (capacity) => resume(Effect.succeed(capacity)),
      () => resume(capacityReadFailure()),
    );
  }).pipe(
    Effect.flatMap((capacity) =>
      Schema.decodeUnknownEffect(RunnerCapacity)(capacity).pipe(
        Effect.mapError(() => new RunnerWatchError({ message: "Runner capacity was invalid." })),
      ),
    ),
  );
}

function capacityReadFailure(): Effect.Effect<never, RunnerWatchError> {
  return new RunnerWatchError({ message: "Runner capacity could not be read." });
}
