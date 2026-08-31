import { Effect, Predicate, Schedule, Schema, Stream } from "effect";
import {
  type RunId,
  RunnerCapacity,
  RunnerSessionSnapshot,
  RunnerWatchError,
} from "@openorb/protocol/runner-api";

import { SessionEvents } from "../session/events.ts";
import { RunnerSessionStore } from "../session/store.ts";
import { SessionSupervisor } from "../session/supervisor.ts";

const WATCH_HANDOFF_BUFFER_CAPACITY = "unbounded";

export function watchRunner(getCapacity: () => Promise<RunnerCapacity>) {
  return Stream.unwrap(Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const supervisor = yield* SessionSupervisor;
    const events = yield* SessionEvents;
    let revision = 0;
    // Start consuming state notifications before any manifest I/O. The unbounded handoff queue
    // cannot silently slide/drop notifications while the initial snapshot is being assembled.
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
    const reportedCapacity = yield* readCapacity(getCapacity);
    const capacity = yield* Schema.decodeUnknownEffect(RunnerCapacity)(reportedCapacity).pipe(
      Effect.catch(() => new RunnerWatchError({ message: "Runner capacity was invalid." })),
    );
    const sessions = manifest.sessions.map((session) => {
      const activeRunId = supervisor.getActiveRunId(session.id);
      return {
        type: "snapshot.session" as const,
        session: withActiveRun(session, activeRunId),
      };
    });
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
      Stream.mapEffect((sessionId) =>
        store.getSessionSnapshot(sessionId).pipe(
          Effect.mapError(() =>
            new RunnerWatchError({ message: "Runner session state could not be read." })
          ),
          Effect.map((session) => {
            const activeRunId = supervisor.getActiveRunId(session.id);
            const current = withActiveRun(session, activeRunId);
            const encoded = JSON.stringify(current);
            if (lastSessionValues.get(current.id) === encoded) return null;
            lastSessionValues.set(current.id, encoded);
            return current;
          }),
        )
      ),
      Stream.filter(Predicate.isNotNull),
      Stream.map((session) => ({
        type: "session.updated" as const,
        revision: ++revision,
        session,
      })),
    );
    return Stream.concat(snapshot, Stream.merge(observed, sessionUpdates));
  }));
}

function withActiveRun(
  session: RunnerSessionSnapshot,
  activeRunId: string | undefined,
): RunnerSessionSnapshot {
  if (session.state !== "running" || activeRunId === undefined) return session;
  // SAFETY: Active Pi run identifiers are generated UUIDs and satisfy the RunId brand.
  const runId = activeRunId as RunId;
  return new RunnerSessionSnapshot({ ...session, activeRunId: runId });
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
