import type { RunId, SessionId, SessionModelRuntime } from "@openorb/protocol/runner-api";
import { Cause, Effect, Exit, Scope, Stream } from "effect";

import type { AgentEnvironment } from "../../environment/agent-environment.ts";
import {
  type ActiveAgentRun,
  AgentHarness,
  type AgentHarnessSession,
} from "../../harness/agent-harness.ts";
import { actorError, type SessionActorError } from "./actor-error.ts";
import type { RunnerSessionDefinition } from "../definition.ts";
import type { GitSnapshotCoordinator } from "../git-snapshot-coordinator.ts";
import type { SessionReporter } from "./reporter.ts";
import { RunnerSessionStore } from "../store.ts";

export interface OpenAgentSession {
  readonly session: AgentHarnessSession;
  readonly scope: Scope.Closeable;
}

export interface SessionAgentRuntime {
  readonly open: (
    environment: AgentEnvironment,
    modelRuntime: SessionModelRuntime,
  ) => Effect.Effect<OpenAgentSession, SessionActorError, Scope.Scope>;
  readonly consume: (
    run: ActiveAgentRun,
    runId: RunId,
  ) => Effect.Effect<void, SessionActorError>;
  readonly close: (session: OpenAgentSession) => Effect.Effect<void>;
}

export const makeSessionAgentRuntime = Effect.fn("makeSessionAgentRuntime")(function* (
  sessionId: SessionId,
  definition: RunnerSessionDefinition,
  reporter: SessionReporter,
  snapshotCoordinator: GitSnapshotCoordinator<unknown>,
) {
  const store = yield* RunnerSessionStore;
  const harness = yield* AgentHarness;

  const open: SessionAgentRuntime["open"] = (environment, modelRuntime) =>
    Effect.gen(function* () {
      const paths = yield* store.getSessionPiPaths(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const sessionScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
      const session = yield* harness.open({
        sessionId,
        environment,
        git: {
          repositoryUrl: definition.repositoryUrl,
          branchName: definition.branchName,
        },
        modelRuntime,
        state: {
          sessionFile: paths.sessionFile,
          agentDirectory: paths.agentDirectory,
        },
      }).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.mapError(actorError),
        Effect.onError(() => Scope.close(sessionScope, Exit.void)),
      );
      return { session, scope: sessionScope };
    });

  const consume: SessionAgentRuntime["consume"] = (run, runId) =>
    run.events.pipe(
      Stream.runForEach((event) => {
        const publication = reporter.publish(runId, event);
        const snapshotBoundary = event.type === "turn.completed" ||
          (event.type === "message.completed" && event.role === "toolResult");
        return snapshotBoundary
          ? publication.pipe(Effect.andThen(snapshotCoordinator.trigger))
          : publication;
      }),
      Effect.mapError(actorError),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : snapshotCoordinator.flush.pipe(
            Effect.tap((outcome) =>
              Exit.isFailure(outcome)
                ? Effect.logWarning(
                  "The run-end Git Snapshot refresh failed; the session will retain its last saved snapshot.",
                )
                : Effect.void
            ),
            Effect.asVoid,
            Effect.interruptible,
          )
      ),
    );

  return {
    open,
    consume,
    close: (session) => Scope.close(session.scope, Exit.void),
  } satisfies SessionAgentRuntime;
});
