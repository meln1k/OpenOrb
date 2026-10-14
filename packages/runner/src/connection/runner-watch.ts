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
      let revision = 0;
      // Subscribed before the snapshot is read, so no change between the two is missed.
      const environmentChanges = yield* environments.changes;
      const reportedCapacity = yield* readCapacity(getCapacity);
      const capacity = yield* Schema.decodeUnknownEffect(RunnerCapacity)(reportedCapacity).pipe(
        Effect.catch(() => new RunnerWatchError({ message: "Runner capacity was invalid." })),
      );
      const environmentSnapshots = environments.snapshots().map((environment) => ({
        type: "snapshot.environment" as const,
        environment,
      }));
      const snapshot = Stream.fromIterable([
        ...environmentSnapshots,
        {
          type: "snapshot.complete" as const,
          revision,
          environmentCount: environmentSnapshots.length,
          observedAt: Date.now(),
          capacity,
        },
      ]);
      const observed = Stream.fromEffect(readCapacity(getCapacity)).pipe(
        Stream.repeat(Schedule.spaced("10 seconds")),
        Stream.mapEffect((capacity) =>
          Schema.decodeUnknownEffect(RunnerCapacity)(capacity).pipe(
            Effect.catch(() => new RunnerWatchError({ message: "Runner capacity was invalid." })),
          ),
        ),
        Stream.map((capacity) => ({
          type: "runner.observed" as const,
          revision: ++revision,
          observedAt: Date.now(),
          capacity,
        })),
      );
      const environmentUpdates = environmentChanges.pipe(
        Stream.map((change): typeof RunnerStateEvent.Type =>
          change.type === "removed"
            ? { type: "environment.removed", revision: ++revision, sessionId: change.sessionId }
            : {
                type: "environment.updated",
                revision: ++revision,
                environment: change.environment,
              },
        ),
      );
      return Stream.concat(
        snapshot,
        Stream.mergeAll([observed, environmentUpdates], { concurrency: "unbounded" }).pipe(
          Stream.onStart(
            Effect.logInfo("snapshot.sent").pipe(
              Effect.annotateLogs({
                component: "openorb-runner",
                environmentCount: environmentSnapshots.length,
              }),
            ),
          ),
        ),
      );
    }),
  );
}

function readCapacity(getCapacity: () => Promise<RunnerCapacity>) {
  return Effect.callback<RunnerCapacity, RunnerWatchError>((resume) => {
    getCapacity().then(
      (capacity) => resume(Effect.succeed(capacity)),
      () => resume(capacityReadFailure()),
    );
  });
}

function capacityReadFailure(): Effect.Effect<never, RunnerWatchError> {
  return new RunnerWatchError({ message: "Runner capacity could not be read." });
}
