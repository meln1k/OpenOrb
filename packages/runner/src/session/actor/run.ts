import type { RunId, SessionModelRuntime } from "@openorb/protocol/runner-api";
import { DateTime, Deferred, Effect, Exit, type Scope } from "effect";

import type { AgentEnvironment } from "../../environment/agent-environment.ts";
import { actorError } from "./actor-error.ts";
import type { OpenAgentSession, SessionAgentRuntime } from "./agent-runtime.ts";
import type { ActorCommand, InternalCommand, RunCompletion, SessionCommand } from "./commands.ts";
import type { SessionDecision, SessionDecisions } from "./decision.ts";
import { redactedErrorMessage, type SessionReporter } from "./reporter.ts";
import type { SessionRuntime } from "./runtime.ts";
import { sessionMetadata, type SessionState } from "./state.ts";

interface SessionRunOptions {
  readonly runtime: SessionRuntime;
  readonly agentRuntime: SessionAgentRuntime;
  readonly reporter: SessionReporter;
  readonly decisions: SessionDecisions;
  readonly send: (command: SessionCommand) => Effect.Effect<boolean>;
}

export interface SessionRunBehavior {
  readonly request: (
    environment: AgentEnvironment,
    modelRuntime: SessionModelRuntime,
    runId: RunId,
    prompt: string,
    completion: RunCompletion,
  ) => SessionDecision;
  readonly start: (
    environment: AgentEnvironment,
    modelRuntime: SessionModelRuntime,
    runId: RunId,
    prompt: string,
    completion: RunCompletion,
    agentSession?: OpenAgentSession,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly started: (
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "RunStarted" }>,
  ) => Effect.Effect<SessionDecision>;
  readonly startFailed: (
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "RunStartFailed" }>,
  ) => Effect.Effect<SessionDecision>;
  readonly settled: (
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "RunSettled" }>,
  ) => Effect.Effect<SessionDecision>;
  readonly followUp: (
    state: SessionState,
    command: Extract<ActorCommand, { readonly _tag: "Prompt" }>,
  ) => Effect.Effect<SessionDecision>;
  readonly followUpAccepted: (
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "FollowUpAccepted" }>,
  ) => Effect.Effect<SessionDecision>;
  readonly followUpFailed: (
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "FollowUpFailed" }>,
  ) => Effect.Effect<SessionDecision>;
  readonly abort: (
    state: SessionState,
    command: Extract<ActorCommand, { readonly _tag: "Abort" }>,
  ) => Effect.Effect<SessionDecision>;
  readonly abortConfirmed: (
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "AbortConfirmed" }>,
  ) => Effect.Effect<SessionDecision>;
  readonly abortFailed: (
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "AbortFailed" }>,
  ) => Effect.Effect<SessionDecision>;
}

export function makeSessionRun(options: SessionRunOptions): SessionRunBehavior {
  const { runtime, agentRuntime, reporter, send } = options;
  const { none, persist, reply } = options.decisions;

  const request: SessionRunBehavior["request"] = (
    environment,
    modelRuntime,
    runId,
    prompt,
    completion,
  ) =>
    persist({
      type: "run.requested",
      runId,
      purpose: completion._tag === "Provisioning" ? "initial" : "prompt",
    }, () =>
      start(
        environment,
        modelRuntime,
        runId,
        prompt,
        completion,
        runtime.get().agentSession,
      ));

  const start: SessionRunBehavior["start"] = (
    environment,
    modelRuntime,
    runId,
    prompt,
    completion,
    existingAgentSession,
  ) =>
    Effect.forkScoped(startWorker(
      environment,
      modelRuntime,
      runId,
      prompt,
      completion,
      existingAgentSession,
    )).pipe(Effect.asVoid);

  function startWorker(
    environment: AgentEnvironment,
    modelRuntime: SessionModelRuntime,
    runId: RunId,
    prompt: string,
    completion: RunCompletion,
    existingAgentSession?: OpenAgentSession,
  ): Effect.Effect<void, never, Scope.Scope> {
    let openedAgentSession: OpenAgentSession | undefined;
    return Effect.gen(function* () {
      const agentSession = existingAgentSession ??
        (openedAgentSession = yield* agentRuntime.open(environment, modelRuntime));
      const run = yield* agentSession.session.start(prompt).pipe(Effect.mapError(actorError));
      const acceptedAt = DateTime.formatIso(yield* DateTime.now);
      yield* send({
        kind: "internal",
        _tag: "RunStarted",
        runId,
        run,
        agentSession,
        openedAgentSession: openedAgentSession !== undefined,
        acceptedAt,
        completion,
      });
    }).pipe(
      Effect.catch((error) =>
        send({
          kind: "internal",
          _tag: "RunStartFailed",
          runId,
          error: actorError(error),
          ...(openedAgentSession === undefined ? {} : { openedAgentSession }),
          completion,
        })
      ),
      Effect.asVoid,
    );
  }

  const started: SessionRunBehavior["started"] = (state, command) => {
    if (state.phase._tag !== "StartingRun" || state.phase.runId !== command.runId) {
      return Effect.succeed(none(() =>
        command.run.abort.pipe(
          Effect.ignore,
          Effect.andThen(
            command.openedAgentSession ? agentRuntime.close(command.agentSession) : Effect.void,
          ),
        )
      ));
    }
    return Effect.succeed(persist({
      type: "run.started",
      runId: command.runId,
      acceptedAt: command.acceptedAt,
    }, (running) => {
      const current = runtime.get();
      if (current.environment === undefined) {
        return command.run.abort.pipe(
          Effect.ignore,
          Effect.andThen(
            command.openedAgentSession ? agentRuntime.close(command.agentSession) : Effect.void,
          ),
        );
      }
      return runtime.setAgentSession(command.agentSession).pipe(
        Effect.andThen(runtime.activateRun(command.runId, command.run)),
        Effect.andThen(runtime.updateStatus(true, command.runId)),
        Effect.andThen(
          reporter.emitState(sessionMetadata(running), "running", command.runId).pipe(
            Effect.ignore,
          ),
        ),
        Effect.andThen(
          command.completion._tag === "Prompt"
            ? Deferred.succeed(command.completion.reply, {
              ok: true,
              runId: command.runId,
              mode: "started",
            }).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.andThen(Effect.forkScoped(consume(command)).pipe(Effect.asVoid)),
        Effect.andThen(Effect.addFinalizer(() => {
          const active = runtime.get().activeRun;
          return active?.runId === command.runId
            ? active.run.abort.pipe(Effect.ignore)
            : Effect.void;
        })),
      );
    }));
  };

  const consume = (
    command: Extract<InternalCommand, { readonly _tag: "RunStarted" }>,
  ): Effect.Effect<void, never> =>
    agentRuntime.consume(command.run, command.runId).pipe(
      Effect.exit,
      Effect.flatMap((outcome) =>
        send({
          kind: "internal",
          _tag: "RunSettled",
          runId: command.runId,
          ...(Exit.isFailure(outcome) ? { error: actorError(outcome.cause) } : {}),
          completion: command.completion,
        })
      ),
      Effect.asVoid,
    );

  const startFailed: SessionRunBehavior["startFailed"] = (state, command) => {
    if (state.phase._tag !== "StartingRun" || state.phase.runId !== command.runId) {
      return Effect.succeed(
        none(() =>
          command.openedAgentSession === undefined
            ? Effect.void
            : agentRuntime.close(command.openedAgentSession)
        ),
      );
    }
    const initial = state.phase.purpose === "initial";
    return Effect.succeed(
      persist(
        { type: "run.start-failed", runId: command.runId },
        (next) =>
          closeOpenedSession(command.openedAgentSession).pipe(
            Effect.andThen(runtime.updateStatus(runtime.get().environment !== undefined)),
            Effect.andThen(
              initial
                ? reportInitialFailure(next, command.completion, command.error)
                : command.completion._tag === "Prompt"
                ? Deferred.succeed(command.completion.reply, {
                  ok: false,
                  message: "The agent prompt could not be started. Try again.",
                }).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      ),
    );
  };

  const settled: SessionRunBehavior["settled"] = (state, command) => {
    if (state.phase._tag !== "Running" || state.phase.runId !== command.runId) {
      return Effect.succeed(none());
    }
    const initialFailure = command.error !== undefined && state.phase.purpose === "initial";
    return Effect.succeed(persist(
      command.error === undefined
        ? { type: "run.completed", runId: command.runId }
        : { type: "run.failed", runId: command.runId },
      (next) =>
        runtime.clearActiveRun.pipe(
          Effect.andThen(runtime.updateStatus(runtime.get().environment !== undefined)),
          Effect.andThen(
            initialFailure
              ? reportInitialFailure(next, command.completion, command.error!)
              : reporter.emitState(
                sessionMetadata(next),
                "ready",
                command.runId,
              ).pipe(Effect.ignore),
          ),
        ),
    ));
  };

  const followUp: SessionRunBehavior["followUp"] = (state, command) => {
    if (state.phase._tag !== "Running") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "That agent run is unavailable.",
      }));
    }
    if (state.phase.followUp._tag === "Delivering") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "A follow-up is already being delivered.",
      }));
    }
    if (state.phase.abort._tag !== "Idle") {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The session is aborting.",
      }));
    }
    const activeRun = runtime.get().activeRun;
    if (activeRun === undefined || activeRun.runId !== state.phase.runId) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "That agent run is unavailable.",
      }));
    }
    const followUpId = crypto.randomUUID();
    return Effect.succeed(persist({
      type: "follow-up.requested",
      runId: activeRun.runId,
      followUpId,
    }, () =>
      Effect.forkScoped(
        activeRun.run.followUp(command.payload.prompt).pipe(
          Effect.matchEffect({
            onFailure: () =>
              send({
                kind: "internal",
                _tag: "FollowUpFailed",
                runId: activeRun.runId,
                followUpId,
                reply: command.reply,
              }),
            onSuccess: () =>
              DateTime.now.pipe(
                Effect.map(DateTime.formatIso),
                Effect.flatMap((acceptedAt) =>
                  send({
                    kind: "internal",
                    _tag: "FollowUpAccepted",
                    runId: activeRun.runId,
                    followUpId,
                    acceptedAt,
                    reply: command.reply,
                  })
                ),
              ),
          }),
          Effect.asVoid,
        ),
      ).pipe(Effect.asVoid)));
  };

  const followUpAccepted: SessionRunBehavior["followUpAccepted"] = (state, command) => {
    if (!matchesFollowUp(state, command)) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The follow-up no longer matches the active run.",
      }));
    }
    return Effect.succeed(persist({
      type: "follow-up.accepted",
      runId: command.runId,
      followUpId: command.followUpId,
      acceptedAt: command.acceptedAt,
    }, () =>
      Deferred.succeed(command.reply, {
        ok: true,
        runId: command.runId,
        mode: "follow-up",
      }).pipe(Effect.asVoid)));
  };

  const followUpFailed: SessionRunBehavior["followUpFailed"] = (state, command) => {
    if (!matchesFollowUp(state, command)) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The follow-up no longer matches the active run.",
      }));
    }
    return Effect.succeed(persist({
      type: "follow-up.failed",
      runId: command.runId,
      followUpId: command.followUpId,
    }, () =>
      Deferred.succeed(command.reply, {
        ok: false,
        message:
          "Pi could not confirm the follow-up; delivery may be uncertain and will not be retried automatically.",
      }).pipe(Effect.asVoid)));
  };

  const abort: SessionRunBehavior["abort"] = (state, command) => {
    const activeRun = runtime.get().activeRun;
    if (
      state.phase._tag !== "Running" || state.phase.runId !== command.payload.runId ||
      state.phase.abort._tag !== "Idle" || activeRun?.runId !== command.payload.runId
    ) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "That agent run is no longer active.",
      }));
    }
    return Effect.succeed(persist({
      type: "abort.requested",
      runId: activeRun.runId,
    }, () =>
      Effect.forkScoped(activeRun.run.abort.pipe(
        Effect.matchEffect({
          onFailure: () =>
            send({
              kind: "internal",
              _tag: "AbortFailed",
              runId: activeRun.runId,
              reply: command.reply,
            }),
          onSuccess: () =>
            send({
              kind: "internal",
              _tag: "AbortConfirmed",
              runId: activeRun.runId,
              reply: command.reply,
            }),
        }),
        Effect.asVoid,
      )).pipe(Effect.asVoid)));
  };

  const abortConfirmed: SessionRunBehavior["abortConfirmed"] = (state, command) => {
    if (!matchesRequestedAbort(state, command.runId)) {
      return Effect.succeed(reply(command.reply, { ok: true }));
    }
    return Effect.succeed(persist(
      { type: "abort.confirmed", runId: command.runId },
      () => Deferred.succeed(command.reply, { ok: true }).pipe(Effect.asVoid),
    ));
  };

  const abortFailed: SessionRunBehavior["abortFailed"] = (state, command) => {
    if (!matchesRequestedAbort(state, command.runId)) {
      return Effect.succeed(reply(command.reply, {
        ok: false,
        message: "The agent run could not be aborted.",
      }));
    }
    return Effect.succeed(persist(
      { type: "abort.failed", runId: command.runId },
      () =>
        Deferred.succeed(command.reply, {
          ok: false,
          message: "The agent run could not be aborted.",
        }).pipe(Effect.asVoid),
    ));
  };

  function closeOpenedSession(
    openedAgentSession: OpenAgentSession | undefined,
  ): Effect.Effect<void> {
    return openedAgentSession === undefined ? Effect.void : agentRuntime.close(openedAgentSession);
  }

  function reportInitialFailure(
    state: SessionState,
    completion: RunCompletion,
    error: unknown,
  ): Effect.Effect<void, never> {
    if (completion._tag !== "Provisioning") return Effect.void;
    return Effect.all([
      reporter.emitLog(
        completion.correlationId,
        "stderr",
        `Provisioning failed: ${redactedErrorMessage(error, completion.logBudget.secrets)}\n`,
      ).pipe(Effect.ignore),
      reporter.emitState(
        sessionMetadata(state),
        "failed",
        completion.correlationId,
      ).pipe(Effect.ignore),
    ], { concurrency: "unbounded", discard: true });
  }

  return {
    request,
    start,
    started,
    startFailed,
    settled,
    followUp,
    followUpAccepted,
    followUpFailed,
    abort,
    abortConfirmed,
    abortFailed,
  };
}

function matchesFollowUp(
  state: SessionState,
  command: { readonly runId: RunId; readonly followUpId: string },
): boolean {
  return state.phase._tag === "Running" && state.phase.runId === command.runId &&
    state.phase.followUp._tag === "Delivering" &&
    state.phase.followUp.followUpId === command.followUpId;
}

function matchesRequestedAbort(state: SessionState, runId: RunId): boolean {
  return state.phase._tag === "Running" && state.phase.runId === runId &&
    state.phase.abort._tag === "Requested";
}
