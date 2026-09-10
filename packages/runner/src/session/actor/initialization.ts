import type { RunId, SessionIssue, SessionModelRuntime } from "@openorb/protocol/runner-api";
import { Deferred, Effect, type Scope } from "effect";

import type { AgentEnvironment } from "../../environment/agent-environment.ts";
import { SessionActorError } from "./actor-error.ts";
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
import type { RunnerSessionMetadata } from "../store.ts";
import { makeSessionIssue } from "./issues.ts";

interface SessionInitializationOptions {
  readonly input: SessionActorInput;
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
    issues: readonly SessionIssue[],
  ) => SessionDecision;
}

export function makeSessionInitialization(options: SessionInitializationOptions) {
  const {
    input,
    runtime,
    provisioner,
    reporter,
    send,
    startIdleLoop,
    requestRun,
  } = options;
  const { none, persist, fail } = options.decisions;

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
        {
          type: "wake.interrupted",
          wakeId: phase.wakeId,
          issue: lostEnvironmentIssue(
            "Agent-session restoration was interrupted. No prompt was dispatched.",
          ),
        },
        (failed) => publishFailureAndContinue(failed, command),
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
        {
          type: "run.interrupted",
          runId: phase.runId,
          issue: lostEnvironmentIssue(
            "The Agent Run was interrupted. Prompt or push work may have completed, so OpenOrb will not replay it automatically.",
          ),
        },
        (failed) => publishFailureAndContinue(failed, command),
      ));
    }
    if (phase._tag === "Restoring") {
      return Effect.succeed(persist(
        {
          type: "restoration.interrupted",
          restorationId: phase.restorationId,
          issue: environmentRestartIssue(
            "Environment restart was interrupted. No pending prompt was replayed.",
          ),
        },
        (failed) => publishFailureAndContinue(failed, command),
      ));
    }
    if (phase._tag === "Stopping") {
      return Effect.succeed(persist(
        {
          type: "stop.failed",
          stopId: phase.stopId,
          environmentUsable: false,
          issue: interruptedStopIssue(),
        },
        (failed) => publishFailureAndContinue(failed, command),
      ));
    }
    if (phase._tag === "Provisioning") {
      return Effect.succeed(persist(
        {
          type: "provisioning.interrupted",
          issue: makeSessionIssue({
            category: "operation-uncertain",
            severity: "failure",
            message:
              "Provisioning was interrupted before the initial prompt was accepted. Retry provisioning explicitly.",
            recovery: "retry-provisioning",
          }),
        },
        (failed) => publishFailureAndContinue(failed, command),
      ));
    }
    return Effect.gen(function* () {
      if (input.mode === "reconcile") {
        if (input.trigger === "actor-crash" && phase._tag === "Ready") {
          return persist(
            {
              type: "actor.crashed",
              issue: actorCrashIssue(),
            },
            (failed) => publishFailureAndContinue(failed, command),
          );
        }
        return none(() => Deferred.succeed(command.reply, undefined).pipe(Effect.asVoid));
      }
      return yield* restore(state, command.reply);
    });
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
    return provisioner.restore(sessionMetadata(state), undefined, input.correlationId).pipe(
      Effect.map(({ environment, issues }) =>
        none(() =>
          runtime.setEnvironment(environment).pipe(
            Effect.andThen(runtime.updateStatus(true)),
            Effect.andThen(startIdleLoop()),
            Effect.andThen(Effect.forEach(
              issues,
              (issue) => send({ kind: "internal", _tag: "RecordIssue", issue }),
              { discard: true },
            )),
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
        makeSessionIssue({
          category: "operation-uncertain",
          severity: "failure",
          message:
            "Provisioning completed outside the active operation. The initial prompt was not accepted; retry provisioning explicitly.",
          recovery: "retry-provisioning",
        }),
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
        issues: command.issues,
      },
      command.issues,
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
        command.issue,
      )
      : none();
  }

  function continueInitialization(
    command: Extract<InternalCommand, { readonly _tag: "Initialize" }>,
  ): Effect.Effect<void> {
    return send(command).pipe(Effect.asVoid);
  }

  function publishFailureAndContinue(
    state: SessionState,
    command: Extract<InternalCommand, { readonly _tag: "Initialize" }>,
  ): Effect.Effect<void, never> {
    return reporter.emitState(sessionMetadata(state), "failed", input.correlationId).pipe(
      Effect.orDie,
      Effect.andThen(continueInitialization(command)),
    );
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
    issue: SessionIssue,
  ): SessionDecision {
    return persist(
      { type: "provisioning.failed", issue },
      (failedState) => reportFailure(failedState, correlationId, logBudget, error),
    );
  }

  function failRestore(
    correlationId: string,
    logBudget: ProvisioningLogBudget,
    error: SessionActorError,
    initializationReply: Deferred.Deferred<void, SessionActorError>,
  ): SessionDecision {
    const issue = lostEnvironmentIssue(
      "The runner could not restore the session environment. No prompt was dispatched.",
    );
    return persist(
      { type: "restore.failed", issue },
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
      Effect.andThen(
        reporter.emitState(sessionMetadata(state), "failed", correlationId).pipe(Effect.orDie),
      ),
      Effect.andThen(
        reporter.emitLog(
          correlationId,
          "stderr",
          `Provisioning failed: ${redactedErrorMessage(error, logBudget.secrets)}\n`,
        ).pipe(Effect.orDie),
      ),
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

function lostEnvironmentIssue(message: string): SessionIssue {
  return makeSessionIssue({
    category: "operation-uncertain",
    severity: "failure",
    message:
      `${message} Restart the persistent environment explicitly; the root disk and Pi conversation remain preserved.`,
    recovery: "restart-environment",
  });
}

function environmentRestartIssue(message: string): SessionIssue {
  return makeSessionIssue({
    category: "vm-start",
    severity: "failure",
    message,
    recovery: "restart-environment",
  });
}

function interruptedStopIssue(): SessionIssue {
  return makeSessionIssue({
    category: "vm-stop",
    severity: "failure",
    message:
      "VM shutdown was interrupted, so guest sync and process exit could not be confirmed. The persistent disk was preserved; restart the environment explicitly.",
    recovery: "restart-environment",
  });
}

function actorCrashIssue(): SessionIssue {
  return makeSessionIssue({
    category: "actor-crash",
    severity: "failure",
    message:
      "The session actor crashed. Its scoped environment was closed and no command was replayed. Restart the persistent environment explicitly; the root disk and Pi conversation remain preserved.",
    recovery: "restart-environment",
  });
}
