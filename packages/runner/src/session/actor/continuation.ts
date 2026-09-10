import type { RunId, SessionIssue } from "@openorb/protocol/runner-api";
import { Deferred, Effect, type Scope } from "effect";

import type { SessionAgentRuntime } from "./agent-runtime.ts";
import type {
  ActorCommand,
  InternalCommand,
  RestorationContinuation,
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
      return Effect.succeed(beginRestoration(
        state,
        { _tag: "Wake", payload: command.payload, reply: command.reply },
        crypto.randomUUID(),
      ));
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
        { _tag: "Wake", payload: command.payload, reply: command.reply },
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
          _tag: "Prompt",
          payload: command.payload,
          runId,
          reply: command.reply,
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
    continuation: RestorationContinuation,
    correlationId: string,
  ): SessionDecision {
    const restorationId = crypto.randomUUID();
    return persist(
      {
        type: "restoration.started",
        restorationId,
        continuation: continuation._tag === "Wake"
          ? { _tag: "Wake" }
          : { _tag: "Prompt", runId: continuation.runId },
      },
      (restoring) =>
        emitState(
          sessionMetadata(restoring),
          "resuming",
          correlationId,
        ).pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.forkScoped(
              closeCurrentSession().pipe(
                Effect.andThen(provisioner.restore(
                  sessionMetadata(state),
                  continuation.payload.githubToken,
                  correlationId,
                )),
                Effect.flatMap(({ environment, issues, release }) =>
                  agentRuntime.open(environment, continuation.payload.modelRuntime).pipe(
                    Effect.map((agentSession) => ({
                      environment,
                      agentSession,
                      issues,
                      release,
                    })),
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
                      continuation,
                      issue: restorationIssue(error, continuation),
                    }),
                  onSuccess: ({ environment, agentSession, issues, release }) =>
                    send({
                      kind: "internal",
                      _tag: "RestorationCompleted",
                      restorationId,
                      environment,
                      agentSession,
                      release,
                      correlationId,
                      continuation,
                      issues,
                    }).pipe(
                      Effect.flatMap((sent) =>
                        sent
                          ? Effect.void
                          : agentRuntime.close(agentSession).pipe(Effect.andThen(release))
                      ),
                    ),
                }),
                Effect.asVoid,
              ),
            ).pipe(Effect.asVoid),
          ),
        ),
    );
  }

  function closeCurrentSession(): Effect.Effect<void, unknown> {
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
      );
  }

  function restorationCompleted(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "RestorationCompleted" }>,
  ): SessionDecision {
    const continuation = command.continuation;
    if (!matchesRestoration(state, command.restorationId, continuation)) {
      return none(() =>
        agentRuntime.close(command.agentSession).pipe(
          Effect.andThen(command.release),
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
    const continuation = command.continuation;
    if (!matchesRestoration(state, command.restorationId, continuation)) {
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
        runtime.updateStatus(false).pipe(
          Effect.andThen(
            emitState(sessionMetadata(failed), "failed", command.correlationId).pipe(
              Effect.orDie,
            ),
          ),
          Effect.andThen(rejectContinuation(
            continuation,
            continuation._tag === "Prompt"
              ? "The environment could not be restarted. The prompt was not dispatched."
              : "The environment could not be restarted.",
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

function restorationIssue(error: unknown, continuation: RestorationContinuation): SessionIssue {
  const secrets = [
    continuation.payload.modelRuntime.credential.value,
    ...(continuation.payload.githubToken === undefined ? [] : [continuation.payload.githubToken]),
  ];
  return makeSessionIssue({
    category: "vm-start",
    severity: "failure",
    message: continuation._tag === "Prompt"
      ? "The persistent environment could not be restarted. The prompt was not dispatched; retry explicitly."
      : "The persistent environment could not be restarted. Retry explicitly.",
    diagnostics: redactedErrorMessage(error, secrets),
    recovery: "restart-environment",
  });
}

function matchesRestoration(
  state: SessionState,
  restorationId: string,
  continuation: RestorationContinuation,
): boolean {
  if (state.phase._tag !== "Restoring" || state.phase.restorationId !== restorationId) {
    return false;
  }
  if (state.phase.continuation._tag !== continuation._tag) return false;
  return state.phase.continuation._tag === "Wake" ||
    state.phase.continuation.runId ===
      (continuation as Extract<RestorationContinuation, { readonly _tag: "Prompt" }>).runId;
}
