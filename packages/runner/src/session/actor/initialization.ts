import type { RunId, SessionModelRuntime } from "@openorb/protocol/runner-api";
import { Deferred, Effect, type Scope } from "effect";

import type { AgentEnvironment } from "../../environment/agent-environment.ts";
import { actorError, SessionActorError } from "./actor-error.ts";
import type {
  InternalCommand,
  ProvisioningLogBudget,
  ProvisioningUpdate,
  RunCompletion,
  SessionActorInput,
  SessionCommand,
} from "./commands.ts";
import type { PersistentSessionState, SessionDecision, SessionDecisions } from "./decision.ts";
import type { SessionProvisioner } from "./provisioner.ts";
import {
  makeProvisioningLogBudget,
  redactedErrorMessage,
  type SessionReporter,
} from "./reporter.ts";
import type { SessionRuntime } from "./runtime.ts";
import { sessionMetadata, type SessionState } from "./state.ts";
import type { RunnerSessionMetadata, RunnerSessionStore } from "../store.ts";

interface SessionInitializationOptions {
  readonly input: SessionActorInput;
  readonly store: RunnerSessionStore;
  readonly runtime: SessionRuntime;
  readonly provisioner: SessionProvisioner;
  readonly reporter: SessionReporter;
  readonly decisions: SessionDecisions;
  readonly send: (command: SessionCommand) => Effect.Effect<boolean>;
  readonly startIdleLoop: () => Effect.Effect<void, never, Scope.Scope>;
  readonly requestRun: (
    environment: AgentEnvironment,
    modelRuntime: SessionModelRuntime,
    runId: RunId,
    prompt: string,
    completion: RunCompletion,
  ) => SessionDecision;
}

export function makeSessionInitialization(options: SessionInitializationOptions) {
  const {
    input,
    store,
    runtime,
    provisioner,
    reporter,
    send,
    startIdleLoop,
    requestRun,
  } = options;
  const { none, persist, fail } = options.decisions;
  const sessionId = input.metadata.id;

  function initialize(
    state: PersistentSessionState,
    command: Extract<InternalCommand, { readonly _tag: "Initialize" }>,
  ): Effect.Effect<SessionDecision, never, Scope.Scope> {
    if (state === undefined) {
      if (input.mode !== "create") {
        return Effect.succeed(fail(
          command.reply,
          new SessionActorError("The session event journal is empty.", undefined),
        ));
      }
      return Effect.succeed(persist({
        type: "session.provisioning-started",
        id: input.metadata.id,
        definition: input.metadata.definition,
        runnerId: input.metadata.runnerId,
        createdAt: input.metadata.createdAt,
      }, (provisioning) => beginProvisioning(provisioning, input, command.reply)));
    }
    if (input.mode === "create") {
      return Effect.succeed(fail(
        command.reply,
        new SessionActorError("The session already exists.", undefined),
      ));
    }
    if (input.mode === "retry") {
      return state.phase._tag !== "Failed"
        ? Effect.succeed(fail(
          command.reply,
          new SessionActorError("Only a failed session can be retried.", undefined),
        ))
        : Effect.succeed(persist(
          { type: "provisioning.retried" },
          (provisioning) => beginProvisioning(provisioning, input, command.reply),
        ));
    }
    return reconcile(state, command);
  }

  function beginProvisioning(
    state: SessionState,
    provisioningInput: Extract<SessionActorInput, { readonly mode: "create" | "retry" }>,
    initializationReply: Deferred.Deferred<void, SessionActorError>,
  ): Effect.Effect<void, never, Scope.Scope> {
    return Effect.gen(function* () {
      yield* runtime.updateStatus(true);
      yield* startIdleLoop();
      yield* Effect.forkScoped(provision(
        sessionMetadata(state),
        provisioningInput.githubToken,
        provisioningInput.modelRuntime,
        provisioningInput.correlationId,
      ));
      yield* Deferred.succeed(initializationReply, undefined);
    });
  }

  function reconcile(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "Initialize" }>,
  ): Effect.Effect<SessionDecision, never, Scope.Scope> {
    const phase = state.phase;
    if (phase._tag === "Waking") {
      return Effect.succeed(persist(
        { type: "wake.interrupted", wakeId: phase.wakeId },
        () => continueInitialization(command),
      ));
    }
    if (phase._tag === "Running" && phase.followUp._tag === "Delivering") {
      return Effect.succeed(persist({
        type: "follow-up.interrupted",
        runId: phase.runId,
        followUpId: phase.followUp.followUpId,
      }, () => continueInitialization(command)));
    }
    if (phase._tag === "StartingRun" || phase._tag === "Running") {
      return Effect.succeed(persist(
        { type: "run.interrupted", runId: phase.runId },
        () => continueInitialization(command),
      ));
    }
    if (phase._tag === "Resuming") {
      return Effect.succeed(persist(
        { type: "resume.interrupted", resumeId: phase.resumeId },
        () => continueInitialization(command),
      ));
    }
    if (phase._tag === "Checkpointing") {
      return Effect.succeed(persist({
        type: "checkpoint.interrupted",
        file: phase.file,
      }, () =>
        store.discardCheckpoint(sessionId, phase.file).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Interrupted checkpoint ${phase.file} could not be discarded: ${error.message}`,
            )
          ),
          Effect.andThen(continueInitialization(command)),
        )));
    }
    if (phase._tag === "Provisioning") {
      return Effect.succeed(persist(
        { type: "provisioning.interrupted" },
        () => continueInitialization(command),
      ));
    }

    const checkpoint = phase.checkpoint;
    const inspectCheckpoint = checkpoint === undefined
      ? Effect.succeed(true)
      : store.checkpointExists(sessionId, checkpoint.file).pipe(Effect.mapError(actorError));
    return Effect.gen(function* () {
      const checkpointExists = yield* inspectCheckpoint;
      if (!checkpointExists && checkpoint !== undefined) {
        return persist(
          { type: "checkpoint.invalidated", file: checkpoint.file },
          () => continueInitialization(command),
        );
      }
      yield* store.cleanupCheckpoints(sessionId, checkpoint?.file).pipe(
        Effect.mapError(actorError),
      );
      if (input.mode === "reconcile") {
        return none(() => Deferred.succeed(command.reply, undefined).pipe(Effect.asVoid));
      }
      return yield* restore(state, command.reply);
    }).pipe(
      Effect.catch((error) => Effect.succeed(fail(command.reply, actorError(error)))),
    );
  }

  function restore(
    state: SessionState,
    initializationReply: Deferred.Deferred<void, SessionActorError>,
  ): Effect.Effect<SessionDecision, never, Scope.Scope> {
    if (state.phase._tag === "Stopped" || state.phase._tag === "Failed") {
      return Effect.succeed(none(() =>
        runtime.updateStatus(false).pipe(
          Effect.andThen(startIdleLoop()),
          Effect.andThen(Deferred.succeed(initializationReply, undefined)),
          Effect.asVoid,
        )
      ));
    }
    if (state.phase._tag !== "Ready") {
      return Effect.succeed(fail(
        initializationReply,
        new SessionActorError("The recovered session phase cannot be restored.", undefined),
      ));
    }
    return provisioner.restore(sessionMetadata(state)).pipe(
      Effect.map((environment) =>
        none(() =>
          runtime.setEnvironment(environment).pipe(
            Effect.andThen(runtime.updateStatus(true)),
            Effect.andThen(startIdleLoop()),
            Effect.andThen(Deferred.succeed(initializationReply, undefined)),
            Effect.asVoid,
          )
        )
      ),
      Effect.catch((error) =>
        Effect.succeed(failRestore(
          input.correlationId,
          makeProvisioningLogBudget([]),
          error,
          initializationReply,
        ))
      ),
    );
  }

  function provisioningUpdated(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "ProvisioningUpdated" }>,
  ): SessionDecision {
    if (state.phase._tag !== "Provisioning") {
      return fail(
        command.reply,
        new SessionActorError(
          "The provisioning update no longer matches the active operation.",
          undefined,
        ),
      );
    }
    return persist(
      {
        type: "checkout.updated",
        checkoutState: command.input.checkoutState,
        ...(command.input.baseCommit === undefined ? {} : { baseCommit: command.input.baseCommit }),
      },
      (next) => Deferred.succeed(command.reply, sessionMetadata(next)).pipe(Effect.asVoid),
    );
  }

  function environmentStarted(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "ProvisioningEnvironmentStarted" }>,
  ): SessionDecision {
    if (state.phase._tag !== "Provisioning") {
      return fail(
        command.reply,
        new SessionActorError(
          "The started environment no longer matches session provisioning.",
          undefined,
        ),
      );
    }
    return none(() =>
      runtime.setEnvironment(command.environment).pipe(
        Effect.andThen(runtime.updateStatus(true)),
        Effect.andThen(Deferred.succeed(command.reply, undefined)),
        Effect.asVoid,
      )
    );
  }

  function prepared(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "ProvisioningPrepared" }>,
  ): Effect.Effect<SessionDecision, never, Scope.Scope> {
    const current = runtime.get();
    if (state.phase._tag !== "Provisioning" || current.environment !== command.environment) {
      return Effect.succeed(failProvision(
        command.correlationId,
        command.logBudget,
        new SessionActorError(
          "The prepared environment no longer matches session provisioning.",
          undefined,
        ),
      ));
    }
    // SAFETY: Provisioning correlation identifiers are generated UUIDs.
    const runId = command.correlationId as RunId;
    return Effect.succeed(requestRun(
      command.environment,
      command.modelRuntime,
      runId,
      state.data.definition.initialPrompt,
      {
        _tag: "Provisioning",
        correlationId: command.correlationId,
        logBudget: command.logBudget,
      },
    ));
  }

  function provisioningFailed(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "ProvisioningFailed" }>,
  ): SessionDecision {
    return state.phase._tag === "Provisioning"
      ? failProvision(
        command.correlationId,
        command.logBudget,
        command.error,
      )
      : none();
  }

  function continueInitialization(
    command: Extract<InternalCommand, { readonly _tag: "Initialize" }>,
  ): Effect.Effect<void> {
    return send(command).pipe(Effect.asVoid);
  }

  function persistProvisioningUpdate(
    update: ProvisioningUpdate,
  ): Effect.Effect<RunnerSessionMetadata, SessionActorError> {
    return Effect.gen(function* () {
      const reply = yield* Deferred.make<RunnerSessionMetadata, SessionActorError>();
      yield* send({ kind: "internal", _tag: "ProvisioningUpdated", input: update, reply });
      return yield* Deferred.await(reply);
    });
  }

  function registerProvisioningEnvironment(
    environment: AgentEnvironment,
  ): Effect.Effect<void, SessionActorError> {
    return Effect.gen(function* () {
      const reply = yield* Deferred.make<void, SessionActorError>();
      yield* send({
        kind: "internal",
        _tag: "ProvisioningEnvironmentStarted",
        environment,
        reply,
      });
      return yield* Deferred.await(reply);
    });
  }

  function provision(
    metadata: RunnerSessionMetadata,
    githubToken: string | undefined,
    modelRuntime: SessionModelRuntime,
    correlationId: string,
  ) {
    return provisioner.provision(metadata, githubToken, modelRuntime, correlationId, {
      update: persistProvisioningUpdate,
      environmentStarted: registerProvisioningEnvironment,
      prepared: (result) => send({ kind: "internal", _tag: "ProvisioningPrepared", ...result }),
      failed: (result) => send({ kind: "internal", _tag: "ProvisioningFailed", ...result }),
    });
  }

  function failProvision(
    correlationId: string,
    logBudget: ProvisioningLogBudget,
    error: SessionActorError,
  ): SessionDecision {
    return persist(
      { type: "provisioning.failed" },
      (failedState) => reportFailure(failedState, correlationId, logBudget, error),
    );
  }

  function failRestore(
    correlationId: string,
    logBudget: ProvisioningLogBudget,
    error: SessionActorError,
    initializationReply: Deferred.Deferred<void, SessionActorError>,
  ): SessionDecision {
    return persist(
      { type: "restore.failed" },
      (failedState) =>
        reportFailure(failedState, correlationId, logBudget, error).pipe(
          Effect.andThen(Deferred.succeed(initializationReply, undefined)),
          Effect.asVoid,
        ),
    );
  }

  function reportFailure(
    state: SessionState,
    correlationId: string,
    logBudget: ProvisioningLogBudget,
    error: SessionActorError,
  ): Effect.Effect<void, never> {
    const environmentAvailable = runtime.get().environment !== undefined;
    return runtime.clearActiveRun.pipe(
      Effect.andThen(runtime.updateStatus(environmentAvailable)),
      Effect.andThen(Effect.all([
        reporter.emitLog(
          correlationId,
          "stderr",
          `Provisioning failed: ${redactedErrorMessage(error, logBudget.secrets)}\n`,
        ).pipe(Effect.ignore),
        reporter.emitState(sessionMetadata(state), "failed", correlationId).pipe(Effect.ignore),
      ], { concurrency: "unbounded", discard: true })),
    );
  }

  return {
    initialize,
    provisioningUpdated,
    environmentStarted,
    prepared,
    provisioningFailed,
  };
}
