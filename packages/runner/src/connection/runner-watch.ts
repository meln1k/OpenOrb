import { Effect, Predicate, Schedule, Schema, Stream } from "effect";
import {
  RunnerCapacity,
  type RunnerStateEvent,
  RunnerWatchError,
} from "@openorb/protocol/runner-api";

import { SessionEvents } from "../session/events.ts";
import { RunnerSessionStore } from "../session/store.ts";
import { SessionSupervisor } from "../session/supervisor.ts";

const WATCH_HANDOFF_BUFFER_CAPACITY = 64;

export function watchRunner(getCapacity: () => Promise<RunnerCapacity>) {
  return Stream.unwrap(Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const supervisor = yield* SessionSupervisor;
    const events = yield* SessionEvents;
    let revision = 0;
    // Subscribe before manifest I/O. Both handoff and upstream buffers are bounded; overflow
    // fails the watch so the gateway reconnects for a new manifest rather than missing removals.
    const stateChanges = yield* events.watchStateChanges().pipe(
      Stream.toQueue({ capacity: WATCH_HANDOFF_BUFFER_CAPACITY }),
    );
    // toQueue runs the source in a child fiber; let it acquire its upstream subscription before
    // manifest loading can expose the handoff point to concurrent publishers.
    yield* Effect.yieldNow;
    const manifest = yield* store.loadSessionManifest().pipe(
      Effect.mapError(() =>
        new RunnerWatchError({ message: "Runner manifest could not be read." })
      ),
    );
    if (manifest.errors.length > 0) {
      yield* Effect.logWarning("snapshot.inspection-failed").pipe(
        Effect.annotateLogs({ component: "openorb-runner", errorCount: manifest.errors.length }),
      );
    }
    const reportedCapacity = yield* readCapacity(getCapacity);
    const capacity = yield* Schema.decodeUnknownEffect(RunnerCapacity)(reportedCapacity).pipe(
      Effect.catch(() => new RunnerWatchError({ message: "Runner capacity was invalid." })),
    );
    const sessions = manifest.sessions.map((session) => ({
      type: "snapshot.session" as const,
      session: supervisor.withLiveState(session),
    }));
    const snapshot = Stream.fromIterable([...sessions, {
      type: "snapshot.complete" as const,
      revision,
      sessionCount: sessions.length,
      observedAt: Date.now(),
      capacity,
    }]);
    const lastSessionValues = new Map(
      sessions.map(({ session }) => [session.id, JSON.stringify(session)]),
    );
    const observed = Stream.fromEffect(readCapacity(getCapacity)).pipe(
      Stream.repeat(Schedule.spaced("10 seconds")),
      Stream.mapEffect((capacity) =>
        Schema.decodeUnknownEffect(RunnerCapacity)(capacity).pipe(
          Effect.catch(() => new RunnerWatchError({ message: "Runner capacity was invalid." })),
        )
      ),
      Stream.map((capacity) => ({
        type: "runner.observed" as const,
        revision: ++revision,
        observedAt: Date.now(),
        capacity,
      })),
    );
    // The same queue first drains notifications buffered during the snapshot and then remains the
    // live source, so there is no second subscription boundary where an update can disappear.
    const sessionUpdates = Stream.fromQueue(stateChanges).pipe(
      Stream.mapEffect((change): Effect.Effect<
        typeof RunnerStateEvent.Type | null,
        RunnerWatchError
      > => {
        if (change.type === "removed") {
          lastSessionValues.delete(change.sessionId);
          return Effect.succeed({
            type: "session.removed" as const,
            revision: ++revision,
            sessionId: change.sessionId,
          });
        }
        return store.getSessionSnapshot(change.sessionId).pipe(
          Effect.mapError(() =>
            new RunnerWatchError({ message: "Runner session state could not be read." })
          ),
          Effect.map((session) => {
            const current = supervisor.withLiveState(session);
            const encoded = JSON.stringify(current);
            if (lastSessionValues.get(current.id) === encoded) return null;
            lastSessionValues.set(current.id, encoded);
            return {
              type: "session.updated" as const,
              revision: ++revision,
              session: current,
            };
          }),
        );
      }),
      Stream.filter(Predicate.isNotNull),
    );
    return Stream.concat(
      snapshot,
      Stream.merge(observed, sessionUpdates).pipe(
        Stream.onStart(
          Effect.logInfo("snapshot.sent").pipe(
            Effect.annotateLogs({ component: "openorb-runner", sessionCount: sessions.length }),
          ),
        ),
      ),
    );
  }));
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
