import type { RunId } from "@openorb/protocol/runner-api";
import { Deferred, Effect, type Scope } from "effect";

import type { SessionAgentRuntime } from "./agent-runtime.ts";
import type {
  ActorCommand,
  InternalCommand,
  ResumeContinuation,
  SessionCommand,
} from "./commands.ts";
import type { SessionDecision, SessionDecisions } from "./decision.ts";
import type { SessionProvisioner } from "./provisioner.ts";
import type { SessionReporter } from "./reporter.ts";
import type { SessionRunBehavior } from "./run.ts";
import type { SessionRuntime } from "./runtime.ts";
import { sessionMetadata, type SessionState } from "./state.ts";

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
    if (state.phase._tag === "Stopped") {
      return Effect.succeed(beginResume(
        state,
        { _tag: "Wake", payload: command.payload, reply: command.reply },
        crypto.randomUUID(),
      ));
    }
    if (state.phase._tag !== "Ready") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: state.phase._tag === "Waking" || state.phase._tag === "Resuming"
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
              onFailure: () =>
                send({
                  kind: "internal",
                  _tag: "WakeOpenFailed",
                  wakeId,
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
      { type: "wake.failed", wakeId: command.wakeId },
      () =>
        Deferred.succeed(command.reply, {
          ok: false,
          message: "The agent session could not be restored.",
        }).pipe(Effect.asVoid),
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
    if (state.phase._tag === "Waking" || state.phase._tag === "Resuming") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session is already starting an operation.",
      }));
    }
    // SAFETY: Run identifiers are generated UUIDs.
    const runId = crypto.randomUUID() as RunId;
    if (state.phase._tag === "Stopped") {
      return Effect.succeed(beginResume(
        state,
        { _tag: "Prompt", payload: command.payload, runId, reply: command.reply },
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
    ));
  }

  function beginResume(
    state: SessionState,
    continuation: ResumeContinuation,
    correlationId: string,
  ): SessionDecision {
    const resumeId = crypto.randomUUID();
    return persist(
      {
        type: "resume.started",
        resumeId,
        continuation: continuation._tag === "Wake"
          ? { _tag: "Wake" }
          : { _tag: "Prompt", runId: continuation.runId },
      },
      (resuming) =>
        emitState(sessionMetadata(resuming), "resuming", correlationId).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.forkScoped(
              provisioner.resume(
                sessionMetadata(state),
                continuation.payload.githubToken,
                continuation.payload.modelRuntime,
                correlationId,
              ).pipe(
                Effect.flatMap((environment) =>
                  agentRuntime.open(environment, continuation.payload.modelRuntime).pipe(
                    Effect.map((agentSession) => ({ environment, agentSession })),
                  )
                ),
                Effect.matchEffect({
                  onFailure: () =>
                    send({
                      kind: "internal",
                      _tag: "ResumeFailed",
                      resumeId,
                      correlationId,
                      continuation,
                    }),
                  onSuccess: ({ environment, agentSession }) =>
                    send({
                      kind: "internal",
                      _tag: "ResumeCompleted",
                      resumeId,
                      environment,
                      agentSession,
                      correlationId,
                      continuation,
                    }),
                }),
                Effect.asVoid,
              ),
            ).pipe(Effect.asVoid),
          ),
        ),
    );
  }

  function resumeCompleted(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "ResumeCompleted" }>,
  ): SessionDecision {
    if (!matchesResume(state, command.resumeId, command.continuation)) {
      return none(() =>
        agentRuntime.close(command.agentSession).pipe(
          Effect.andThen(rejectContinuation(
            command.continuation,
            "The completed resume no longer matches the active operation.",
          )),
        )
      );
    }
    return persist(
      { type: "resume.completed", resumeId: command.resumeId },
      (next) =>
        runtime.setSession(command.environment, command.agentSession).pipe(
          Effect.andThen(runtime.updateStatus(true)),
          Effect.andThen(
            emitState(sessionMetadata(next), "ready", command.correlationId).pipe(
              Effect.ignore,
            ),
          ),
          Effect.andThen(
            command.continuation._tag === "Wake"
              ? Deferred.succeed(command.continuation.reply, { ok: true }).pipe(Effect.asVoid)
              : run.start(
                command.environment,
                command.continuation.payload.modelRuntime,
                command.continuation.runId,
                command.continuation.payload.prompt,
                { _tag: "Prompt", reply: command.continuation.reply },
                command.agentSession,
              ),
          ),
        ),
    );
  }

  function resumeFailed(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "ResumeFailed" }>,
  ): SessionDecision {
    if (!matchesResume(state, command.resumeId, command.continuation)) {
      return none(() =>
        rejectContinuation(
          command.continuation,
          "The failed resume no longer matches the active operation.",
        )
      );
    }
    return persist(
      { type: "resume.failed", resumeId: command.resumeId },
      (stopped) =>
        runtime.clearEnvironment.pipe(
          Effect.andThen(runtime.updateStatus(false)),
          Effect.andThen(
            emitState(sessionMetadata(stopped), "stopped", command.correlationId).pipe(
              Effect.ignore,
            ),
          ),
          Effect.andThen(rejectContinuation(
            command.continuation,
            command.continuation._tag === "Prompt"
              ? "The checkpoint could not be resumed. The prompt was not dispatched."
              : "The checkpoint could not be resumed.",
          )),
        ),
    );
  }

  function rejectContinuation(
    continuation: ResumeContinuation,
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
    resumeCompleted,
    resumeFailed,
  };
}

function matchesResume(
  state: SessionState,
  resumeId: string,
  continuation: ResumeContinuation,
): boolean {
  if (state.phase._tag !== "Resuming" || state.phase.resumeId !== resumeId) return false;
  if (state.phase.continuation._tag !== continuation._tag) return false;
  return state.phase.continuation._tag === "Wake" ||
    state.phase.continuation.runId ===
      (continuation as Extract<ResumeContinuation, { readonly _tag: "Prompt" }>).runId;
}
