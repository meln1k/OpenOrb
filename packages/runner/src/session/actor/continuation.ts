import type { RunId, SessionIssue } from "@openorb/protocol/runner-api";
import { Deferred, Effect, type Scope } from "effect";

import type { SessionAgentRuntime } from "./agent-runtime.ts";
import type {
  ActorCommand,
  InternalCommand,
  RestorationContinuation,
  RestorationRequest,
  SessionCommand,
} from "./commands.ts";
import type { SessionDecision, SessionDecisions } from "./decision.ts";
import type { SessionProvisioner } from "./provisioner.ts";
import type { SessionReporter } from "./reporter.ts";
import type { SessionRunBehavior } from "./run.ts";
import type { SessionRuntime } from "./runtime.ts";
import { sessionMetadata, type SessionState } from "./state.ts";
import { currentRecovery, makeSessionIssue } from "./issues.ts";
import { redactedErrorMessage } from "./reporter.ts";

interface SessionContinuationOptions {
  readonly runtime: SessionRuntime;
  readonly agentRuntime: SessionAgentRuntime;
  readonly provisioner: SessionProvisioner;
  readonly emitState: SessionReporter["emitState"];
  readonly decisions: SessionDecisions;
  readonly run: SessionRunBehavior;
  readonly send: (command: SessionCommand) => Effect.Effect<boolean>;
}

export function makeSessionContinuation(options: SessionContinuationOptions) {
  const { runtime, agentRuntime, provisioner, emitState, run, send } = options;
  const { none, persist, reply } = options.decisions;

  function wake(
    state: SessionState,
    command: Extract<ActorCommand, { readonly _tag: "Wake" }>,
  ): Effect.Effect<SessionDecision, never, Scope.Scope> {
    if (state.data.definition.model !== command.payload.modelRuntime.model) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session model cannot change during restoration.",
      }));
    }
    if (state.phase._tag === "Running") {
      return Effect.succeed(reply(command.reply, { ok: true }));
    }
    if (state.phase._tag === "Failed") {
      const recovery = currentRecovery(state.data.issues);
      if (recovery === undefined || command.payload.recovery !== recovery) {
        return Effect.succeed(reply(command.reply, {
          ok: false,
          message: "Choose the recovery action currently offered for this failed session.",
        }));
      }
      return Effect.succeed(
        recovery === "resume-prior-checkpoint" && state.phase.checkpoint !== undefined
          ? beginRestoration(
            state,
            {
              _tag: "ResumeCheckpoint",
              continuation: { _tag: "Wake", payload: command.payload, reply: command.reply },
            },
            crypto.randomUUID(),
          )
          : beginRestoration(
            state,
            {
              _tag: "StartCleanVm",
              continuation: { _tag: "Wake", payload: command.payload, reply: command.reply },
            },
            crypto.randomUUID(),
          ),
      );
    }
    if (command.payload.recovery !== undefined) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "This session does not require environment recovery.",
      }));
    }
    if (state.phase._tag === "Stopped") {
      return Effect.succeed(beginRestoration(
        state,
        {
          _tag: "ResumeCheckpoint",
          continuation: { _tag: "Wake", payload: command.payload, reply: command.reply },
        },
        crypto.randomUUID(),
      ));
    }
    if (state.phase._tag !== "Ready") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: state.phase._tag === "Waking" || state.phase._tag === "Restoring"
          ? "The session environment is already being restored."
          : "The session environment could not be restored.",
      }));
    }
    const current = runtime.get();
    if (current.environment === undefined) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session environment could not be restored.",
      }));
    }
    if (current.agentSession !== undefined) {
      return Effect.succeed(reply(command.reply, { ok: true }));
    }
    const wakeId = crypto.randomUUID();
    return Effect.succeed(persist(
      { type: "wake.started", wakeId },
      () =>
        Effect.forkScoped(
          agentRuntime.open(
            current.environment!,
            command.payload.modelRuntime,
          ).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                send({
                  kind: "internal",
                  _tag: "WakeOpenFailed",
                  wakeId,
                  issue: modelRestoreIssue(
                    error,
                    command.payload.modelRuntime.credential.value,
                  ),
                  reply: command.reply,
                }),
              onSuccess: (agentSession) =>
                send({
                  kind: "internal",
                  _tag: "WakeOpened",
                  wakeId,
                  agentSession,
                  reply: command.reply,
                }),
            }),
            Effect.asVoid,
          ),
        ).pipe(Effect.asVoid),
    ));
  }

  function wakeOpened(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "WakeOpened" }>,
  ): SessionDecision {
    if (state.phase._tag !== "Waking" || state.phase.wakeId !== command.wakeId) {
      return none(() =>
        agentRuntime.close(command.agentSession).pipe(
          Effect.andThen(Deferred.succeed(command.reply, {
            ok: false,
            message: "The completed wake no longer matches the active operation.",
          })),
          Effect.asVoid,
        )
      );
    }
    return persist(
      { type: "wake.completed", wakeId: command.wakeId },
      () =>
        runtime.setAgentSession(command.agentSession).pipe(
          Effect.andThen(Deferred.succeed(command.reply, { ok: true })),
          Effect.asVoid,
        ),
    );
  }

  function wakeOpenFailed(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "WakeOpenFailed" }>,
  ): SessionDecision {
    if (state.phase._tag !== "Waking" || state.phase.wakeId !== command.wakeId) {
      return reply(command.reply, {
        ok: false,
        message: "The failed wake no longer matches the active operation.",
      });
    }
    return persist(
      { type: "wake.failed", wakeId: command.wakeId, issue: command.issue },
      (next) =>
        emitState(sessionMetadata(next), "ready", command.wakeId).pipe(
          Effect.orDie,
          Effect.andThen(Deferred.succeed(command.reply, {
            ok: false,
            message: "The agent session could not be restored.",
          })),
          Effect.asVoid,
        ),
    );
  }

  function prompt(
    state: SessionState,
    command: Extract<ActorCommand, { readonly _tag: "Prompt" }>,
  ): Effect.Effect<SessionDecision, never, Scope.Scope> {
    if (state.data.definition.model !== command.payload.modelRuntime.model) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session model cannot change during continuation.",
      }));
    }
    if (state.phase._tag === "Running") return run.followUp(state, command);
    if (state.phase._tag === "StartingRun") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session is already starting a run.",
      }));
    }
    if (state.phase._tag === "Waking" || state.phase._tag === "Restoring") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session is already starting an operation.",
      }));
    }
    // SAFETY: Run identifiers are generated UUIDs.
    const runId = crypto.randomUUID() as RunId;
    if (state.phase._tag === "Stopped") {
      return Effect.succeed(beginRestoration(
        state,
        {
          _tag: "ResumeCheckpoint",
          continuation: {
            _tag: "Prompt",
            payload: command.payload,
            runId,
            reply: command.reply,
          },
        },
        runId,
      ));
    }
    if (state.phase._tag !== "Ready") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session is not ready and idle.",
      }));
    }
    const environment = runtime.get().environment;
    if (environment === undefined) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session environment is unavailable.",
      }));
    }
    return Effect.succeed(run.request(
      environment,
      command.payload.modelRuntime,
      runId,
      command.payload.prompt,
      { _tag: "Prompt", reply: command.reply },
      [],
    ));
  }

  function beginRestoration(
    state: SessionState,
    request: RestorationRequest,
    correlationId: string,
  ): SessionDecision {
    const restorationId = crypto.randomUUID();
    const continuation = request.continuation;
    const recoveryMode = request._tag === "ResumeCheckpoint"
      ? "resume-prior-checkpoint" as const
      : "start-clean-vm" as const;
    return persist(
      {
        type: "restoration.started",
        restorationId,
        intent: request._tag === "ResumeCheckpoint"
          ? {
            _tag: "ResumeCheckpoint",
            continuation: continuation._tag === "Wake"
              ? { _tag: "Wake" }
              : { _tag: "Prompt", runId: continuation.runId },
          }
          : { _tag: "StartCleanVm" },
      },
      (restoring) =>
        emitState(
          sessionMetadata(restoring),
          request._tag === "ResumeCheckpoint" ? "resuming" : "starting-vm",
          correlationId,
        ).pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.forkScoped(
              provisioner.recover(
                sessionMetadata(state),
                recoveryMode,
                continuation.payload.githubToken,
                continuation.payload.modelRuntime,
                correlationId,
              ).pipe(
                Effect.flatMap(({ environment, issues, release }) =>
                  agentRuntime.open(environment, continuation.payload.modelRuntime).pipe(
                    Effect.map((agentSession) => ({ environment, agentSession, issues })),
                    Effect.onError(() => release),
                  )
                ),
                Effect.matchEffect({
                  onFailure: (error) =>
                    send({
                      kind: "internal",
                      _tag: "RestorationFailed",
                      restorationId,
                      correlationId,
                      request,
                      issue: restorationIssue(error, request),
                    }),
                  onSuccess: ({ environment, agentSession, issues }) =>
                    send({
                      kind: "internal",
                      _tag: "RestorationCompleted",
                      restorationId,
                      environment,
                      agentSession,
                      correlationId,
                      request,
                      issues,
                    }),
                }),
                Effect.asVoid,
              ),
            ).pipe(Effect.asVoid),
          ),
        ),
    );
  }

  function restorationCompleted(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "RestorationCompleted" }>,
  ): SessionDecision {
    const continuation = command.request.continuation;
    if (!matchesRestoration(state, command.restorationId, command.request)) {
      return none(() =>
        agentRuntime.close(command.agentSession).pipe(
          Effect.andThen(rejectContinuation(
            continuation,
            "The completed restoration no longer matches the active operation.",
          )),
        )
      );
    }
    return persist(
      {
        type: "restoration.completed",
        restorationId: command.restorationId,
        issues: command.issues,
      },
      (next) =>
        runtime.setSession(command.environment, command.agentSession).pipe(
          Effect.andThen(runtime.updateStatus(true)),
          Effect.andThen(
            emitState(sessionMetadata(next), "ready", command.correlationId).pipe(
              Effect.orDie,
            ),
          ),
          Effect.andThen(
            continuation._tag === "Wake"
              ? Deferred.succeed(continuation.reply, { ok: true }).pipe(Effect.asVoid)
              : run.start(
                command.environment,
                continuation.payload.modelRuntime,
                continuation.runId,
                continuation.payload.prompt,
                { _tag: "Prompt", reply: continuation.reply },
                command.agentSession,
              ),
          ),
        ),
    );
  }

  function restorationFailed(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "RestorationFailed" }>,
  ): SessionDecision {
    const continuation = command.request.continuation;
    if (!matchesRestoration(state, command.restorationId, command.request)) {
      return none(() =>
        rejectContinuation(
          continuation,
          "The failed restoration no longer matches the active operation.",
        )
      );
    }
    return persist(
      {
        type: "restoration.failed",
        restorationId: command.restorationId,
        issue: command.issue,
      },
      (failed) =>
        runtime.clearEnvironment.pipe(
          Effect.andThen(runtime.updateStatus(false)),
          Effect.andThen(
            emitState(sessionMetadata(failed), "failed", command.correlationId).pipe(
              Effect.orDie,
            ),
          ),
          Effect.andThen(rejectContinuation(
            continuation,
            command.request._tag === "StartCleanVm"
              ? command.issue.message
              : continuation._tag === "Prompt"
              ? "The checkpoint could not be resumed. The prompt was not dispatched."
              : "The checkpoint could not be resumed.",
          )),
        ),
    );
  }

  function rejectContinuation(
    continuation: RestorationContinuation,
    message: string,
  ): Effect.Effect<void> {
    return continuation._tag === "Wake"
      ? Deferred.succeed(continuation.reply, { ok: false, message }).pipe(Effect.asVoid)
      : Deferred.succeed(continuation.reply, { ok: false, message }).pipe(Effect.asVoid);
  }

  return {
    wake,
    wakeOpened,
    wakeOpenFailed,
    prompt,
    restorationCompleted,
    restorationFailed,
  };
}

function modelRestoreIssue(error: unknown, modelCredential: string): SessionIssue {
  return makeSessionIssue({
    category: "model",
    severity: "warning",
    message:
      "The Pi model session could not be restored. Reconfigure the model if needed and try again.",
    diagnostics: redactedErrorMessage(error, [modelCredential]),
    recovery: "none",
  });
}

function restorationIssue(error: unknown, request: RestorationRequest): SessionIssue {
  const continuation = request.continuation;
  const secrets = [
    continuation.payload.modelRuntime.credential.value,
    ...(continuation.payload.githubToken === undefined ? [] : [continuation.payload.githubToken]),
  ];
  if (request._tag === "StartCleanVm") return cleanRecoveryIssue(error, secrets);
  return makeSessionIssue({
    category: "checkpoint-resume",
    severity: "failure",
    message: continuation._tag === "Prompt"
      ? "The prior checkpoint could not be resumed. The prompt was not dispatched; retry checkpoint resume explicitly."
      : "The prior checkpoint could not be resumed. Retry checkpoint resume explicitly.",
    diagnostics: redactedErrorMessage(error, secrets),
    recovery: "resume-prior-checkpoint",
  });
}

function cleanRecoveryIssue(error: unknown, secrets: readonly string[]): SessionIssue {
  return makeSessionIssue({
    category: "vm-start",
    severity: "failure",
    message:
      "A clean Gondolin VM could not be started. The Project Workspace and Pi conversation remain preserved; retry clean VM recovery explicitly.",
    diagnostics: redactedErrorMessage(error, secrets),
    recovery: "start-clean-vm",
  });
}

function matchesRestoration(
  state: SessionState,
  restorationId: string,
  request: RestorationRequest,
): boolean {
  if (state.phase._tag !== "Restoring" || state.phase.restorationId !== restorationId) {
    return false;
  }
  if (state.phase.intent._tag !== request._tag) return false;
  if (state.phase.intent._tag === "StartCleanVm") return true;
  const continuation = request.continuation;
  if (state.phase.intent.continuation._tag !== continuation._tag) return false;
  return state.phase.intent.continuation._tag === "Wake" ||
    state.phase.intent.continuation.runId ===
      (continuation as Extract<RestorationContinuation, { readonly _tag: "Prompt" }>).runId;
}
