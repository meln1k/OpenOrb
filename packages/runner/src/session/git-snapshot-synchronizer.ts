import { SessionGitSnapshot, type SessionId } from "@openorb/protocol/runner-api";
import { Effect, Predicate } from "effect";

import type { AgentEnvironment } from "../environment/agent-environment.ts";
import {
  type GeneratedSessionGitSnapshot,
  type generateSessionGitSnapshotBundle,
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
      patches?: {
        readonly snapshotId: string;
        readonly staged: string;
        readonly unstaged: string;
      },
    ) => Effect.Effect<void, unknown>;
  };
  readonly generate: (
    ...args: Parameters<typeof generateSessionGitSnapshotBundle>
  ) => Effect.Effect<SessionGitSnapshot | GeneratedSessionGitSnapshot, unknown>;
  readonly publishUpdated: (correlationId: string) => Effect.Effect<void, unknown>;
}

export interface GitSnapshotSynchronizer {
  readonly refresh: (
    environment: AgentEnvironment,
    metadata: RunnerSessionMetadata,
  ) => Effect.Effect<SessionGitSnapshot, unknown>;
  readonly publishPending: (correlationId: string) => Effect.Effect<void, unknown>;
}

export function makeGitSnapshotSynchronizer(
  options: GitSnapshotSynchronizerOptions,
): GitSnapshotSynchronizer {
  return {
    refresh: Effect.fn("GitSnapshotSynchronizer.refresh")(function* (
      environment: AgentEnvironment,
      metadata: RunnerSessionMetadata,
    ) {
      const current = yield* options.store.readGitSnapshotState(options.sessionId).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (state) => state,
        }),
      );
      const generation = yield* options.generate(environment, metadata).pipe(
        Effect.match({
          onFailure: () => ({
            succeeded: false as const,
            result: { snapshot: staleGitSnapshot(current?.snapshot) },
          }),
          onSuccess: (result) => ({ succeeded: true as const, result }),
        }),
      );
      const generated: GeneratedSessionGitSnapshot = Predicate.hasProperty(
          generation.result,
          "snapshot",
        )
        ? generation.result
        : { snapshot: generation.result };
      const mutationRevision = current?.mutationRevision ?? generated.snapshot.mutationRevision;
      const snapshot = generation.succeeded
        ? new SessionGitSnapshot({ ...generated.snapshot, mutationRevision })
        : generated.snapshot;
      let state = current;
      if (!state || !sameGitSnapshotContents(state.snapshot, snapshot)) {
        state = { snapshot, mutationRevision, notificationPending: true };
        yield* options.store.writeGitSnapshotState(
          options.sessionId,
          state,
          generated.patches,
        );
      }
      return state.snapshot;
    }),
    publishPending: Effect.fn("GitSnapshotSynchronizer.publishPending")(function* (
      correlationId: string,
    ) {
      let state = yield* options.store.readGitSnapshotState(options.sessionId);
      if (state.notificationPending) {
        yield* options.publishUpdated(correlationId);
        state = { ...state, notificationPending: false };
        yield* options.store.writeGitSnapshotState(options.sessionId, state);
      }
    }),
  };
}
