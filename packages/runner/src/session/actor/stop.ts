import type { SessionIssue } from "@openorb/protocol/runner-api";
import { Clock, Deferred, Effect, type Scope } from "effect";

import type { AgentEnvironment } from "../../environment/agent-environment.ts";
import type { GitSnapshotSynchronizer } from "../git-snapshot-synchronizer.ts";
import { updateSessionGitFile } from "../git-snapshot.ts";
import type { RunnerSessionStore } from "../store.ts";
import { actorError, SessionActorError } from "./actor-error.ts";
import type { OpenAgentSession, SessionAgentRuntime } from "./agent-runtime.ts";
import type {
  ActorCommand,
  DeletionAcceptance,
  GitFileUpdateAcceptance,
  InternalCommand,
  SessionCommand,
  StopAcceptance,
} from "./commands.ts";
import type { SessionDecision, SessionDecisions } from "./decision.ts";
import { redactedErrorMessage, type SessionReporter } from "./reporter.ts";
import type { SessionRuntime } from "./runtime.ts";
import { sessionMetadata, type SessionState } from "./state.ts";
import { makeSessionIssue } from "./issues.ts";

interface StopBehaviorOptions {
  readonly sessionId: SessionState["data"]["id"];
  readonly idleTimeoutMs: number;
  readonly store: RunnerSessionStore;
  readonly runtime: SessionRuntime;
  readonly agentRuntime: SessionAgentRuntime;
  readonly gitSnapshots: GitSnapshotSynchronizer;
  readonly requestGitSnapshot: Effect.Effect<void, unknown>;
  readonly send: (command: SessionCommand) => Effect.Effect<boolean>;
  readonly emitState: SessionReporter["emitState"];
  readonly decisions: SessionDecisions;
}

export function makeStopBehavior(options: StopBehaviorOptions) {
  const {
    sessionId,
    store,
    runtime,
    agentRuntime,
    gitSnapshots,
    requestGitSnapshot,
    send,
    emitState,
  } = options;
  const { none, persist, reply, fail } = options.decisions;
  let gitOperationActive = false;
  let stopLog:
    | { readonly trigger: "idle" | "explicit"; readonly startedAt: number }
    | undefined;

  const logStop = (
    event: "stop.started" | "stop.completed" | "stop.failed",
    state: SessionState,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* (event === "stop.failed" ? Effect.logError(event) : Effect.logInfo(event)).pipe(
        Effect.annotateLogs({
          component: "openorb-runner",
          sessionId,
          runnerId: state.data.runnerId,
          trigger: stopLog?.trigger ?? "unknown",
          ...(stopLog === undefined ? {} : { durationMs: now - stopLog.startedAt }),
        }),
      );
    });

  function prepareDeletion(state: SessionState): Effect.Effect<DeletionAcceptance> {
    if (
      state.phase._tag !== "Ready" && state.phase._tag !== "Stopped" &&
      state.phase._tag !== "Failed"
    ) {
      return Effect.succeed({
        ok: false,
        message: "Wait for active session work to finish before deleting the session.",
      });
    }
    if (gitOperationActive) {
      return Effect.succeed({
        ok: false,
        message:
          "Wait for the active Git Snapshot operation to finish before deleting the session.",
      });
    }
    const current = runtime.get();
    return (current.agentSession === undefined
      ? Effect.void
      : agentRuntime.close(current.agentSession).pipe(Effect.andThen(runtime.clearAgentSession)))
      .pipe(
        Effect.andThen(
          current.environment === undefined
            ? Effect.void
            : current.environment.stop.pipe(Effect.andThen(runtime.clearEnvironment)),
        ),
        Effect.andThen(runtime.updateStatus(false)),
        Effect.as<DeletionAcceptance>({ ok: true }),
        Effect.catch(() =>
          Effect.succeed({
            ok: false,
            message:
              "The session environment could not be confirmed stopped, so its storage was preserved.",
          })
        ),
      );
  }

  function stop(
    state: SessionState,
    command: Extract<ActorCommand, { readonly _tag: "Stop" }>,
  ): Effect.Effect<SessionDecision> {
    if (state.phase._tag === "Running" || state.phase._tag === "StartingRun") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "Abort the active Pi run before stopping the session.",
      }));
    }
    if (state.phase._tag !== "Ready") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session is not ready and idle.",
      }));
    }
    if (gitOperationActive) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "Wait for the active Git Snapshot operation before stopping the session.",
      }));
    }
    const current = runtime.get();
    if (current.environment === undefined) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session environment is unavailable.",
      }));
    }
    return Effect.gen(function* () {
      if (command.idle) {
        const now = yield* Clock.currentTimeMillis;
        const acceptedAt = state.data.lastAcceptedUserMessageAt === undefined
          ? undefined
          : Date.parse(state.data.lastAcceptedUserMessageAt);
        if (
          acceptedAt === undefined || !Number.isFinite(acceptedAt) ||
          now - acceptedAt < options.idleTimeoutMs
        ) {
          return reply(command.reply, {
            ok: false,
            message: "The session has not been idle long enough to stop.",
          });
        }
      }
      stopLog = {
        trigger: command.idle ? "idle" : "explicit",
        startedAt: yield* Clock.currentTimeMillis,
      };
      const stopId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();
      return persist(
        { type: "stop.started", stopId },
        (stopping) =>
          emitState(sessionMetadata(stopping), "stopping", correlationId).pipe(
            Effect.orDie,
            Effect.andThen(logStop("stop.started", stopping)),
            Effect.andThen(
              Effect.forkScoped(stopReadySession(
                current.environment!,
                current.agentSession,
                stopId,
                correlationId,
                command.reply,
              )).pipe(Effect.asVoid),
            ),
          ),
      );
    });
  }

  function stopReadySession(
    environment: AgentEnvironment,
    agentSession: OpenAgentSession | undefined,
    stopId: string,
    correlationId: string,
    commandReply: Deferred.Deferred<StopAcceptance>,
  ): Effect.Effect<void, never> {
    let environmentUsable = true;
    let agentSessionClosed = agentSession === undefined;
    return Effect.gen(function* () {
      yield* requestGitSnapshot.pipe(Effect.mapError(actorError));
      const sync = yield* environment.run(["/bin/sync"]).pipe(Effect.mapError(actorError));
      if (sync.exitCode !== 0) {
        return yield* new SessionActorError(
          `Guest sync exited with status ${sync.exitCode}.`,
          undefined,
        );
      }
      if (agentSession !== undefined) {
        yield* agentRuntime.close(agentSession);
        agentSessionClosed = true;
      }
      environmentUsable = false;
      yield* environment.stop.pipe(Effect.mapError(actorError));
      yield* store.syncSessionRootDisk(sessionId).pipe(Effect.mapError(actorError));
      yield* send({
        kind: "internal",
        _tag: "StopCompleted",
        stopId,
        correlationId,
        reply: commandReply,
      });
    }).pipe(
      Effect.catch((error) =>
        send({
          kind: "internal",
          _tag: "StopFailed",
          stopId,
          environmentUsable,
          agentSessionClosed,
          correlationId,
          issue: stopIssue(environmentUsable, error),
          reply: commandReply,
        })
      ),
      Effect.asVoid,
    );
  }

  function complete(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "StopCompleted" }>,
  ): Effect.Effect<SessionDecision> {
    if (state.phase._tag !== "Stopping" || state.phase.stopId !== command.stopId) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The completed stop no longer matches the active operation.",
      }));
    }
    return Effect.succeed(persist(
      { type: "stop.completed", stopId: command.stopId },
      (stopped) =>
        runtime.clearEnvironment.pipe(
          Effect.andThen(runtime.updateStatus(false)),
          Effect.andThen(
            emitState(sessionMetadata(stopped), "stopped", command.correlationId).pipe(
              Effect.orDie,
            ),
          ),
          Effect.andThen(logStop("stop.completed", stopped)),
          Effect.andThen(Deferred.succeed(command.reply, { ok: true })),
          Effect.asVoid,
        ),
    ));
  }

  function failed(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "StopFailed" }>,
  ): SessionDecision {
    if (state.phase._tag !== "Stopping" || state.phase.stopId !== command.stopId) {
      return reply(command.reply, {
        ok: false,
        message: "The failed stop no longer matches the active operation.",
      });
    }
    return persist(
      {
        type: "stop.failed",
        stopId: command.stopId,
        environmentUsable: command.environmentUsable,
        issue: command.issue,
      },
      (failedState) =>
        (command.agentSessionClosed ? runtime.clearAgentSession : Effect.void).pipe(
          Effect.andThen(runtime.updateStatus(command.environmentUsable)),
          Effect.andThen(
            emitState(
              sessionMetadata(failedState),
              command.environmentUsable ? "ready" : "failed",
              command.correlationId,
            ).pipe(Effect.orDie),
          ),
          Effect.andThen(logStop("stop.failed", failedState)),
          Effect.andThen(Deferred.succeed(command.reply, {
            ok: false,
            message: command.environmentUsable
              ? "The session could not be stopped; the VM remains available."
              : "VM shutdown could not be confirmed; restart the environment explicitly.",
          })),
          Effect.asVoid,
        ),
    );
  }

  function updateGitFile(
    state: SessionState,
    command: Extract<ActorCommand, { readonly _tag: "UpdateGitFile" }>,
  ): Effect.Effect<SessionDecision> {
    if (state.phase._tag !== "Ready" && state.phase._tag !== "Running") {
      return Effect.succeed(reply(
        command.reply,
        rejectGitFileUpdate(
          "Files cannot be staged or unstaged until the session environment is available.",
        ),
      ));
    }
    if (gitOperationActive) {
      return Effect.succeed(reply(
        command.reply,
        rejectGitFileUpdate("Wait for the active Git Snapshot operation to finish."),
      ));
    }
    const environment = runtime.get().environment;
    if (environment === undefined) {
      return Effect.succeed(reply(
        command.reply,
        rejectGitFileUpdate(
          "Files cannot be staged or unstaged until the session environment is available.",
        ),
      ));
    }
    const metadata = sessionMetadata(state);
    const operation = updateSessionGitFile(environment, metadata, command.payload).pipe(
      Effect.flatMap((result) =>
        gitSnapshots.refresh(environment, metadata, crypto.randomUUID()).pipe(
          Effect.as<GitFileUpdateAcceptance>(
            result.ok ? { ok: true } : rejectGitFileUpdate(result.message),
          ),
          Effect.catch((error) =>
            send({
              kind: "internal",
              _tag: "RecordIssue",
              issue: gitSnapshotIssue(error),
            }).pipe(
              Effect.as(rejectGitFileUpdate(
                "The Git index may have changed, but its refreshed Git Snapshot could not be saved.",
              )),
            )
          ),
        )
      ),
      Effect.flatMap((result) => Deferred.succeed(command.reply, result)),
      Effect.asVoid,
    );
    return Effect.succeed(none(() => startGitOperation(operation)));
  }

  function refreshGitSnapshot(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "RefreshGitSnapshot" }>,
  ): SessionDecision {
    const environment = runtime.get().environment;
    if (
      environment === undefined ||
      (state.phase._tag !== "Ready" && state.phase._tag !== "Running" &&
        state.phase._tag !== "Stopping")
    ) return reply(command.reply, undefined);
    if (gitOperationActive) {
      return fail(
        command.reply,
        new SessionActorError("A Git Snapshot operation is already active.", undefined),
      );
    }
    const correlationId = state.phase._tag === "Running" ? state.phase.runId : crypto.randomUUID();
    const metadata = sessionMetadata(state);
    return none(() =>
      startGitOperation(
        gitSnapshots.refresh(environment, metadata, correlationId).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              send({
                kind: "internal",
                _tag: "RecordIssue",
                issue: gitSnapshotIssue(error),
              }).pipe(
                Effect.andThen(Deferred.fail(command.reply, error)),
              ),
            onSuccess: () => Deferred.succeed(command.reply, undefined),
          }),
          Effect.asVoid,
        ),
      )
    );
  }

  function startGitOperation(
    operation: Effect.Effect<void, never>,
  ): Effect.Effect<void, never, Scope.Scope> {
    gitOperationActive = true;
    return Effect.forkScoped(operation.pipe(
      Effect.ensuring(Effect.sync(() => gitOperationActive = false)),
    )).pipe(Effect.asVoid);
  }

  return { prepareDeletion, stop, complete, failed, updateGitFile, refreshGitSnapshot };
}

function rejectGitFileUpdate(message: string): GitFileUpdateAcceptance {
  return { ok: false, message };
}

function stopIssue(environmentUsable: boolean, error: unknown): SessionIssue {
  if (environmentUsable) {
    return makeSessionIssue({
      category: "vm-stop",
      severity: "warning",
      message: "The session could not be stopped. The current VM remains available; retry Stop.",
      diagnostics: redactedErrorMessage(error, []),
      recovery: "none",
    });
  }
  return makeSessionIssue({
    category: "vm-stop",
    severity: "failure",
    message:
      "VM shutdown began, so the current environment cannot be reused. The persistent disk was preserved; restart the environment explicitly.",
    diagnostics: redactedErrorMessage(error, []),
    recovery: "restart-environment",
  });
}

function gitSnapshotIssue(error: unknown): SessionIssue {
  return makeSessionIssue({
    category: "report",
    severity: "warning",
    message:
      "The Git Snapshot could not be refreshed. The session remains available with its last saved snapshot.",
    diagnostics: redactedErrorMessage(error, []),
    recovery: "none",
  });
}
