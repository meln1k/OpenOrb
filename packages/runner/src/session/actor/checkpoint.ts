import type { SessionIssue } from "@openorb/protocol/runner-api";
import { Clock, Deferred, Effect, type Scope } from "effect";

import type { AgentEnvironment } from "../../environment/agent-environment.ts";
import type { GitSnapshotSynchronizer } from "../git-snapshot-synchronizer.ts";
import { updateSessionGitFile } from "../git-snapshot.ts";
import type { RunnerSessionCheckpointCandidate, RunnerSessionStore } from "../store.ts";
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

interface CheckpointBehaviorOptions {
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

export function makeCheckpointBehavior(options: CheckpointBehaviorOptions) {
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

  function deletionAcceptance(state: SessionState): DeletionAcceptance {
    if (
      state.phase._tag !== "Ready" && state.phase._tag !== "Stopped" &&
      state.phase._tag !== "Failed"
    ) {
      return {
        ok: false,
        message: "Wait for active session work to finish before deleting the session.",
      };
    }
    if (gitOperationActive) {
      return {
        ok: false,
        message:
          "Wait for the active Git Snapshot operation to finish before deleting the session.",
      };
    }
    return { ok: true };
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
      const candidate = yield* store.allocateCheckpoint(sessionId).pipe(
        Effect.mapError(actorError),
      );
      const correlationId = crypto.randomUUID();
      return persist(
        { type: "checkpoint.started", file: candidate.file },
        (checkpointing) =>
          emitState(sessionMetadata(checkpointing), "checkpointing", correlationId).pipe(
            Effect.orDie,
            Effect.andThen(
              Effect.forkScoped(checkpointReadySession(
                current.environment!,
                current.agentSession,
                candidate,
                state.phase.checkpoint !== undefined,
                correlationId,
                command.reply,
              )).pipe(Effect.asVoid),
            ),
          ),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(none(() =>
          send({
            kind: "internal",
            _tag: "RecordIssue",
            issue: checkpointIssue(false, state.phase.checkpoint !== undefined, error),
          }).pipe(
            Effect.andThen(Deferred.succeed(command.reply, {
              ok: false,
              message: "The session checkpoint could not be started.",
            })),
            Effect.asVoid,
          )
        ))
      ),
    );
  }

  function checkpointReadySession(
    environment: AgentEnvironment,
    agentSession: OpenAgentSession | undefined,
    candidate: RunnerSessionCheckpointCandidate,
    hasPriorCheckpoint: boolean,
    correlationId: string,
    commandReply: Deferred.Deferred<StopAcceptance>,
  ): Effect.Effect<void, never> {
    let consumed = false;
    let agentSessionClosed = agentSession === undefined;
    return Effect.gen(function* () {
      yield* requestGitSnapshot.pipe(Effect.mapError(actorError));
      yield* environment.run(["/bin/sync"]).pipe(Effect.mapError(actorError), Effect.asVoid);
      if (agentSession !== undefined) {
        yield* agentRuntime.close(agentSession);
        agentSessionClosed = true;
      }
      const checkpoint = yield* environment.checkpoint(candidate.path).pipe(
        Effect.tapError((error) => Effect.sync(() => consumed = error.consumed)),
        Effect.mapError(actorError),
      );
      consumed = true;
      yield* send({
        kind: "internal",
        _tag: "CheckpointCompleted",
        candidate,
        checkpoint,
        correlationId,
        reply: commandReply,
      });
    }).pipe(
      Effect.catch((error) =>
        send({
          kind: "internal",
          _tag: "CheckpointFailed",
          candidate,
          consumed,
          agentSessionClosed,
          correlationId,
          issue: checkpointIssue(consumed, hasPriorCheckpoint, error),
          reply: commandReply,
        })
      ),
      Effect.asVoid,
    );
  }

  function complete(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "CheckpointCompleted" }>,
  ): Effect.Effect<SessionDecision> {
    if (state.phase._tag !== "Checkpointing" || state.phase.file !== command.candidate.file) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The completed checkpoint no longer matches the active operation.",
      }));
    }
    return store.validateCheckpoint(sessionId, command.candidate, command.checkpoint).pipe(
      Effect.map(() =>
        persist({
          type: "checkpoint.published",
          checkpoint: {
            file: command.candidate.file,
            guestAssetBuildId: command.checkpoint.guestAssetBuildId,
            ...(command.checkpoint.createdWithVmm === undefined
              ? {}
              : { createdWithVmm: command.checkpoint.createdWithVmm }),
            compatibleVmm: command.checkpoint.compatibleVmm,
          },
        }, (stopped) =>
          store.cleanupCheckpoints(sessionId, command.candidate.file).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Obsolete checkpoints for session ${sessionId} could not be removed: ${error.message}`,
              )
            ),
            Effect.andThen(runtime.clearEnvironment),
            Effect.andThen(runtime.updateStatus(false)),
            Effect.andThen(
              emitState(sessionMetadata(stopped), "stopped", command.correlationId).pipe(
                Effect.orDie,
              ),
            ),
            Effect.andThen(Deferred.succeed(command.reply, { ok: true })),
            Effect.asVoid,
          ))
      ),
      Effect.catch((error) =>
        Effect.succeed(failed(state, {
          kind: "internal",
          _tag: "CheckpointFailed",
          candidate: command.candidate,
          consumed: true,
          agentSessionClosed: true,
          correlationId: command.correlationId,
          issue: checkpointIssue(true, state.phase.checkpoint !== undefined, error),
          reply: command.reply,
        }))
      ),
    );
  }

  function failed(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "CheckpointFailed" }>,
  ): SessionDecision {
    if (state.phase._tag !== "Checkpointing" || state.phase.file !== command.candidate.file) {
      return reply(command.reply, {
        ok: false,
        message: "The failed checkpoint no longer matches the active operation.",
      });
    }
    return persist({
      type: "checkpoint.failed",
      file: command.candidate.file,
      consumed: command.consumed,
      issue: command.issue,
    }, (failedState) =>
      store.discardCheckpoint(sessionId, command.candidate.file).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Failed checkpoint ${command.candidate.file} could not be discarded: ${error.message}`,
          )
        ),
        Effect.andThen(
          command.consumed
            ? runtime.clearEnvironment
            : command.agentSessionClosed
            ? runtime.clearAgentSession
            : Effect.void,
        ),
        Effect.andThen(runtime.updateStatus(!command.consumed)),
        Effect.andThen(
          emitState(
            sessionMetadata(failedState),
            command.consumed ? "failed" : "ready",
            command.correlationId,
          ).pipe(Effect.orDie),
        ),
        Effect.andThen(Deferred.succeed(command.reply, {
          ok: false,
          message: command.consumed
            ? "The VM stopped, but its checkpoint could not be published. The session was not stopped successfully."
            : "The session checkpoint could not be created.",
        })),
        Effect.asVoid,
      ));
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
        state.phase._tag !== "Checkpointing")
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

  return { deletionAcceptance, stop, complete, failed, updateGitFile, refreshGitSnapshot };
}

function rejectGitFileUpdate(message: string): GitFileUpdateAcceptance {
  return { ok: false, message };
}

function checkpointIssue(
  consumed: boolean,
  hasPriorCheckpoint: boolean,
  error: unknown,
): SessionIssue {
  if (!consumed) {
    return makeSessionIssue({
      category: "checkpoint-create",
      severity: "warning",
      message: "The checkpoint could not be created. The current VM remains available; retry Stop.",
      diagnostics: redactedErrorMessage(error, []),
      recovery: "none",
    });
  }
  return makeSessionIssue({
    category: "checkpoint-publish",
    severity: "failure",
    message: hasPriorCheckpoint
      ? "The VM stopped, but its new checkpoint could not be published. Resume the prior checkpoint explicitly; newer guest root-disk changes may roll back, while the Project Checkout and Pi conversation remain preserved."
      : "The VM stopped, but its checkpoint could not be published. Start a clean VM explicitly; the Project Checkout and Pi conversation remain preserved.",
    diagnostics: redactedErrorMessage(error, []),
    recovery: hasPriorCheckpoint ? "resume-prior-checkpoint" : "start-clean-vm",
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
