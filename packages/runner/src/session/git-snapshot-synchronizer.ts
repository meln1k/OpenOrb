import type { SessionGitSnapshot, SessionId } from "@openorb/protocol/runner-api";
import { Effect } from "effect";

import type { AgentEnvironment } from "../environment/agent-environment.ts";
import {
  type generateSessionGitSnapshot,
  sameGitSnapshotContents,
  staleGitSnapshot,
} from "./git-snapshot.ts";
import type { RunnerSessionGitSnapshotState, RunnerSessionMetadata } from "./store.ts";

interface GitSnapshotSynchronizerOptions {
  readonly sessionId: SessionId;
  readonly store: {
    readonly readGitSnapshotState: (
      sessionId: SessionId,
    ) => Effect.Effect<RunnerSessionGitSnapshotState, unknown>;
    readonly writeGitSnapshotState: (
      sessionId: SessionId,
      state: RunnerSessionGitSnapshotState,
    ) => Effect.Effect<void, unknown>;
  };
  readonly generate: typeof generateSessionGitSnapshot;
  readonly publishUpdated: (correlationId: string) => Effect.Effect<void, unknown>;
}

export interface GitSnapshotSynchronizer {
  readonly refresh: (
    environment: AgentEnvironment,
    metadata: RunnerSessionMetadata,
    correlationId: string,
  ) => Effect.Effect<SessionGitSnapshot, unknown>;
}

export function makeGitSnapshotSynchronizer(
  options: GitSnapshotSynchronizerOptions,
): GitSnapshotSynchronizer {
  return {
    refresh: Effect.fn("GitSnapshotSynchronizer.refresh")(function* (
      environment: AgentEnvironment,
      metadata: RunnerSessionMetadata,
      correlationId: string,
    ) {
      const current = yield* options.store.readGitSnapshotState(options.sessionId).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (state) => state,
        }),
      );
      const generated = yield* options.generate(environment, metadata).pipe(
        Effect.catch(() => Effect.succeed(staleGitSnapshot(current?.snapshot))),
      );
      let state = current;
      if (!state || !sameGitSnapshotContents(state.snapshot, generated)) {
        state = { snapshot: generated, notificationPending: true };
        yield* options.store.writeGitSnapshotState(options.sessionId, state);
      }
      if (state.notificationPending) {
        yield* options.publishUpdated(correlationId);
        state = { ...state, notificationPending: false };
        yield* options.store.writeGitSnapshotState(options.sessionId, state);
      }
      return state.snapshot;
    }),
  };
}
