import { Deferred, Effect, MutableRef, type Scope } from "effect";
import type { SessionProvisioningStage } from "@openorb/protocol/runner-api";

import { makeGitSnapshotCoordinator } from "../git-snapshot-coordinator.ts";
import { makeGitSnapshotSynchronizer } from "../git-snapshot-synchronizer.ts";
import { generateSessionGitSnapshot } from "../git-snapshot.ts";
import type {
  CommandHandler,
  PersistentActorContext,
} from "../persistent-actor/persistent-actor.ts";
import { RunnerSessionStore } from "../store.ts";
import { SessionActorError } from "./actor-error.ts";
import { makeSessionAgentRuntime } from "./agent-runtime.ts";
import { makeCheckpointBehavior } from "./checkpoint.ts";
import type {
  ActorCommand,
  InternalCommand,
  SessionActorInput,
  SessionCommand,
  StopAcceptance,
} from "./commands.ts";
import { makeSessionContinuation } from "./continuation.ts";
import {
  makeSessionDecisions,
  type PersistentSessionState,
  type SessionDecision,
} from "./decision.ts";
import type { SessionEvent } from "./events.ts";
import { makeSessionInitialization } from "./initialization.ts";
import { makeSessionProvisioner } from "./provisioner.ts";
import { makeSessionReporter, redactedErrorMessage } from "./reporter.ts";
import { makeSessionRun } from "./run.ts";
import { makeSessionRuntime, type SessionActorStatus } from "./runtime.ts";
import { sessionMetadata, type SessionState } from "./state.ts";
import { makeSessionIssue } from "./issues.ts";

export function makeSessionBehavior(
  input: SessionActorInput,
  context: PersistentActorContext<SessionCommand>,
  status: MutableRef.MutableRef<SessionActorStatus>,
) {
  return Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const sessionId = input.metadata.id;
    const reporter = yield* makeSessionReporter(sessionId);
    const { emitState, publish } = reporter;
    const provisioner = yield* makeSessionProvisioner(sessionId, reporter);
    const runtime = makeSessionRuntime(status);
    const decisions = makeSessionDecisions();
    const idleLoopStarted = MutableRef.make(false);
    const deletionRequested = MutableRef.make(false);
    const send = context.send;
    const recordGitSnapshotIssue = (error: unknown) =>
      send({
        kind: "internal",
        _tag: "RecordIssue",
        issue: makeSessionIssue({
          category: "report",
          severity: "warning",
          message:
            "The Git Snapshot could not be refreshed. The session remains available with its last saved snapshot.",
          diagnostics: redactedErrorMessage(error, []),
          recovery: "none",
        }),
      }).pipe(Effect.asVoid);
    const gitSnapshots = makeGitSnapshotSynchronizer({
      sessionId,
      store,
      generate: (environment, metadata) =>
        generateSessionGitSnapshot(environment, metadata).pipe(
          Effect.tapError(recordGitSnapshotIssue),
        ),
      publishUpdated: (correlationId) => publish(correlationId, { type: "git.snapshot.updated" }),
    });
    const requestGitSnapshot = Effect.gen(function* () {
      const reply = yield* Deferred.make<void, unknown>();
      if (!(yield* send({ kind: "internal", _tag: "RefreshGitSnapshot", reply }))) {
        return yield* new SessionActorError("The session actor is unavailable.", undefined);
      }
      return yield* Deferred.await(reply);
    });
    const snapshotCoordinator = yield* makeGitSnapshotCoordinator(requestGitSnapshot);
    const agentRuntime = yield* makeSessionAgentRuntime(
      sessionId,
      input.metadata.definition,
      reporter,
      snapshotCoordinator,
    );
    const run = makeSessionRun({ runtime, agentRuntime, reporter, decisions, send });
    const continuation = makeSessionContinuation({
      runtime,
      agentRuntime,
      provisioner,
      emitState,
      decisions,
      run,
      send,
    });
    const checkpoint = makeCheckpointBehavior({
      sessionId,
      idleTimeoutMs: input.idleTimeoutMs,
      store,
      runtime,
      agentRuntime,
      gitSnapshots,
      requestGitSnapshot,
      send,
      emitState,
      decisions,
    });
    const initialization = makeSessionInitialization({
      input,
      store,
      runtime,
      provisioner,
      reporter,
      decisions,
      send,
      startIdleLoop,
      requestRun: run.request,
    });

    function startIdleLoop(): Effect.Effect<void, never, Scope.Scope> {
      if (MutableRef.get(idleLoopStarted)) return Effect.void;
      MutableRef.set(idleLoopStarted, true);
      return Effect.forkScoped(idleStopLoop).pipe(Effect.asVoid);
    }

    function handleCommand(
      state: SessionState,
      command: ActorCommand,
    ): Effect.Effect<SessionDecision, never, Scope.Scope> {
      if (command._tag === "Delete") {
        if (MutableRef.get(deletionRequested)) {
          return Effect.succeed(decisions.reply(command.reply, { ok: true }));
        }
        const acceptance = checkpoint.deletionAcceptance(state);
        return Effect.succeed(
          acceptance.ok
            ? decisions.none(() => {
              MutableRef.set(deletionRequested, true);
              return Deferred.succeed(command.reply, acceptance).pipe(Effect.asVoid);
            })
            : decisions.reply(command.reply, acceptance),
        );
      }
      if (MutableRef.get(deletionRequested)) return Effect.succeed(rejectDuringDeletion(command));
      switch (command._tag) {
        case "Wake":
          return continuation.wake(state, command);
        case "Prompt":
          return continuation.prompt(state, command);
        case "Abort":
          return run.abort(state, command);
        case "Stop":
          return checkpoint.stop(state, command);
        case "UpdateGitFile":
          return checkpoint.updateGitFile(state, command);
      }
    }

    function rejectDuringDeletion(command: ActorCommand): SessionDecision {
      const rejected = {
        ok: false as const,
        message: "The session is being deleted.",
      };
      switch (command._tag) {
        case "Wake":
          return decisions.reply(command.reply, rejected);
        case "Prompt":
          return decisions.reply(command.reply, rejected);
        case "Abort":
          return decisions.reply(command.reply, rejected);
        case "Stop":
          return decisions.reply(command.reply, rejected);
        case "UpdateGitFile":
          return decisions.reply(command.reply, rejected);
        case "Delete":
          return decisions.none();
      }
    }

    function handleInternal(
      state: SessionState,
      command: Exclude<InternalCommand, { readonly _tag: "Initialize" }>,
    ): Effect.Effect<SessionDecision, never, Scope.Scope> {
      switch (command._tag) {
        case "ProvisioningUpdated":
          return Effect.succeed(initialization.provisioningUpdated(state, command));
        case "ProvisioningEnvironmentStarted":
          return Effect.succeed(initialization.environmentStarted(state, command));
        case "ProvisioningPrepared":
          return initialization.prepared(state, command);
        case "ProvisioningFailed":
          return Effect.succeed(initialization.provisioningFailed(state, command));
        case "WakeOpened":
          return Effect.succeed(continuation.wakeOpened(state, command));
        case "WakeOpenFailed":
          return Effect.succeed(continuation.wakeOpenFailed(state, command));
        case "RunStarted":
          return run.started(state, command);
        case "RunStartFailed":
          return run.startFailed(state, command);
        case "FollowUpAccepted":
          return run.followUpAccepted(state, command);
        case "FollowUpFailed":
          return run.followUpFailed(state, command);
        case "RunSettled":
          return run.settled(state, command);
        case "AbortConfirmed":
          return run.abortConfirmed(state, command);
        case "AbortFailed":
          return run.abortFailed(state, command);
        case "CheckpointCompleted":
          return checkpoint.complete(state, command);
        case "CheckpointFailed":
          return Effect.succeed(checkpoint.failed(state, command));
        case "RestorationCompleted":
          return Effect.succeed(continuation.restorationCompleted(state, command));
        case "RestorationFailed":
          return Effect.succeed(continuation.restorationFailed(state, command));
        case "RefreshGitSnapshot":
          return Effect.succeed(checkpoint.refreshGitSnapshot(state, command));
        case "RecordIssue":
          return Effect.succeed(decisions.persist(
            { type: "issue.recorded", issue: command.issue },
            (next) =>
              emitState(sessionMetadata(next), stageForState(next), crypto.randomUUID()).pipe(
                Effect.orDie,
              ),
          ));
      }
    }

    const idleStopLoop = Effect.gen(function* () {
      const interval = Math.max(1, Math.min(60_000, input.idleTimeoutMs));
      while (true) {
        yield* Effect.sleep(interval);
        const reply = yield* Deferred.make<StopAcceptance>();
        yield* send({
          kind: "command",
          _tag: "Stop",
          payload: { sessionId },
          idle: true,
          reply,
        });
        yield* Deferred.await(reply);
      }
    });

    const commandHandler = (
      state: PersistentSessionState,
      command: SessionCommand,
    ): Effect.Effect<SessionDecision, never, Scope.Scope> => {
      if (command.kind === "internal" && command._tag === "Initialize") {
        return initialization.initialize(state, command);
      }
      if (state === undefined) return Effect.succeed(decisions.none());
      return command.kind === "command"
        ? handleCommand(state, command)
        : handleInternal(state, command);
    };

    return commandHandler satisfies CommandHandler<
      PersistentSessionState,
      SessionCommand,
      SessionEvent
    >;
  });
}

function stageForState(state: SessionState): SessionProvisioningStage {
  switch (state.phase._tag) {
    case "Provisioning":
      return "starting-vm";
    case "StartingRun":
      return state.phase.purpose === "initial" ? "starting-vm" : "ready";
    case "Running":
      return "running";
    case "Ready":
    case "Waking":
      return "ready";
    case "Restoring":
      return state.phase.intent._tag === "ResumeCheckpoint" ? "resuming" : "starting-vm";
    case "Checkpointing":
      return "checkpointing";
    case "Stopped":
      return "stopped";
    case "Failed":
      return "failed";
  }
}
