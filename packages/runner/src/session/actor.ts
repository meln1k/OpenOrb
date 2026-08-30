import {
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  MutableRef,
  Queue,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { orbSizeResources } from "@openorb/protocol";
import type {
  AbortSessionPayload,
  PromptSessionPayload,
  RunId,
  SessionId,
  SessionModelRuntime,
  SessionProvisioningStage,
  StopSessionPayload,
  UpdateSessionGitFilePayload,
  WakeSessionPayload,
} from "@openorb/protocol/runner-api";
import { MAX_RPC_SESSION_EVENT_TEXT_BYTES } from "@openorb/protocol/runner-api";
import { join } from "node:path";

import type {
  AgentEnvironment,
  AgentEnvironmentCheckpoint,
} from "../environment/agent-environment.ts";
import { AgentEnvironmentProvider } from "../environment/agent-environment.ts";
import {
  type ActiveAgentRun,
  AgentHarness,
  type AgentHarnessSession,
} from "../harness/agent-harness.ts";
import { SessionEvents } from "./events.ts";
import {
  type GitSnapshotCoordinator,
  makeGitSnapshotCoordinator,
} from "./git-snapshot-coordinator.ts";
import { makeGitSnapshotSynchronizer } from "./git-snapshot-synchronizer.ts";
import { generateSessionGitSnapshot, updateSessionGitFile } from "./git-snapshot.ts";
import {
  type RunnerSessionCheckpointCandidate,
  type RunnerSessionMetadata,
  RunnerSessionStore,
  type UpdateRunnerSessionProvisioningInput,
} from "./store.ts";

const MAX_CAPTURED_COMMAND_BYTES = 4 * 1024;
const MAX_PROVISIONING_LOG_BYTES = 256 * 1024;
const OUTPUT_TRUNCATED_MESSAGE = "\n[Provisioning output was truncated.]\n";

export type PromptAcceptance =
  | { readonly ok: true; readonly runId: RunId; readonly mode: "started" | "follow-up" }
  | { readonly ok: false; readonly message: string };

export type AbortAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type GitFileUpdateAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type WakeAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type StopAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const rejectGitFileUpdate = (message: string): GitFileUpdateAcceptance => ({
  ok: false,
  message,
});

interface SessionActorInputBase {
  metadata: RunnerSessionMetadata;
  githubToken?: string | undefined;
  correlationId: string;
  idleTimeoutMs: number;
}

export type SessionActorInput =
  | (SessionActorInputBase & { readonly restore: true })
  | (SessionActorInputBase & { readonly restore?: false; modelRuntime: SessionModelRuntime });

export interface SessionActor {
  readonly sessionId: SessionId;
  readonly activeRunId: string | undefined;
  readonly active: boolean;
  readonly wake: (payload: WakeSessionPayload) => Effect.Effect<WakeAcceptance>;
  readonly prompt: (payload: PromptSessionPayload) => Effect.Effect<PromptAcceptance>;
  readonly abort: (payload: AbortSessionPayload) => Effect.Effect<AbortAcceptance>;
  readonly stop: (payload: StopSessionPayload) => Effect.Effect<StopAcceptance>;
  readonly updateGitFile: (
    payload: UpdateSessionGitFilePayload,
  ) => Effect.Effect<GitFileUpdateAcceptance>;
  readonly shutdown: Effect.Effect<void>;
}

export interface SessionActorFactory {
  readonly spawn: (
    input: SessionActorInput,
  ) => Effect.Effect<SessionActor>;
}

export const SessionActorFactory: Context.Service<SessionActorFactory, SessionActorFactory> =
  Context.Service("@openorb/runner/SessionActorFactory");

type ActorState =
  | { readonly _tag: "Provisioning"; readonly environment?: AgentEnvironment }
  | {
    readonly _tag: "Ready";
    readonly environment: AgentEnvironment;
    readonly agentSession?: OpenAgentSession;
  }
  | {
    readonly _tag: "Running";
    readonly environment: AgentEnvironment;
    readonly agentSession: OpenAgentSession;
    readonly runId: RunId;
    readonly startedBy: number;
    readonly run: ActiveAgentRun;
  }
  | {
    readonly _tag: "Aborting";
    readonly environment: AgentEnvironment;
    readonly agentSession: OpenAgentSession;
    readonly runId: RunId;
    readonly startedBy: number;
    readonly run: ActiveAgentRun;
  }
  | {
    readonly _tag: "Checkpointing";
    readonly environment: AgentEnvironment;
    readonly candidate: RunnerSessionCheckpointCandidate;
    readonly agentSession?: OpenAgentSession;
  }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Resuming"; readonly startedBy: number }
  | { readonly _tag: "Failed"; readonly environment?: AgentEnvironment };

interface OpenAgentSession {
  readonly session: AgentHarnessSession;
  readonly scope: Scope.Closeable;
}

type ActorCommand =
  | {
    readonly kind: "command";
    readonly _tag: "Wake";
    readonly payload: WakeSessionPayload;
    readonly reply: Deferred.Deferred<WakeAcceptance>;
  }
  | {
    readonly kind: "command";
    readonly _tag: "Prompt";
    readonly payload: PromptSessionPayload;
    readonly reply: Deferred.Deferred<PromptAcceptance>;
  }
  | {
    readonly kind: "command";
    readonly _tag: "Abort";
    readonly payload: AbortSessionPayload;
    readonly reply: Deferred.Deferred<AbortAcceptance>;
  }
  | {
    readonly kind: "command";
    readonly _tag: "Stop";
    readonly payload: StopSessionPayload;
    readonly idle: boolean;
    readonly reply: Deferred.Deferred<StopAcceptance>;
  };

type ResumeContinuation =
  | {
    readonly _tag: "Wake";
    readonly payload: WakeSessionPayload;
    readonly reply: Deferred.Deferred<WakeAcceptance>;
  }
  | {
    readonly _tag: "Prompt";
    readonly payload: PromptSessionPayload;
    readonly runId: RunId;
    readonly reply: Deferred.Deferred<PromptAcceptance>;
  };

type ActorEvent =
  | {
    readonly kind: "event";
    readonly _tag: "ProvisioningUpdated";
    readonly input: UpdateRunnerSessionProvisioningInput;
    readonly reply: Deferred.Deferred<RunnerSessionMetadata, SessionActorError>;
  }
  | {
    readonly kind: "event";
    readonly _tag: "ProvisioningEnvironmentStarted";
    readonly environment: AgentEnvironment;
    readonly reply: Deferred.Deferred<void, SessionActorError>;
  }
  | {
    readonly kind: "event";
    readonly _tag: "ProvisioningPrepared";
    readonly environment: AgentEnvironment;
    readonly metadata: RunnerSessionMetadata;
    readonly modelRuntime: SessionModelRuntime;
    readonly correlationId: string;
    readonly logBudget: ProvisioningLogBudget;
  }
  | {
    readonly kind: "event";
    readonly _tag: "ProvisioningFailed";
    readonly metadata: RunnerSessionMetadata;
    readonly correlationId: string;
    readonly logBudget: ProvisioningLogBudget;
    readonly error: SessionActorError;
  }
  | {
    readonly kind: "event";
    readonly _tag: "RunSettled";
    readonly runId: RunId;
    readonly startedBy: number;
    readonly provisioningFailure?: {
      readonly metadata: RunnerSessionMetadata;
      readonly correlationId: string;
      readonly logBudget: ProvisioningLogBudget;
      readonly error: SessionActorError;
    };
    readonly reply?: Deferred.Deferred<void>;
  }
  | {
    readonly kind: "event";
    readonly _tag: "CheckpointCompleted";
    readonly candidate: RunnerSessionCheckpointCandidate;
    readonly checkpoint: AgentEnvironmentCheckpoint;
    readonly correlationId: string;
    readonly reply: Deferred.Deferred<StopAcceptance>;
  }
  | {
    readonly kind: "event";
    readonly _tag: "CheckpointFailed";
    readonly candidate: RunnerSessionCheckpointCandidate;
    readonly consumed: boolean;
    readonly correlationId: string;
    readonly reply: Deferred.Deferred<StopAcceptance>;
  }
  | {
    readonly kind: "event";
    readonly _tag: "ResumeCompleted";
    readonly startedBy: number;
    readonly environment: AgentEnvironment;
    readonly correlationId: string;
    readonly continuation: ResumeContinuation;
  }
  | {
    readonly kind: "event";
    readonly _tag: "ResumeFailed";
    readonly startedBy: number;
    readonly correlationId: string;
    readonly continuation: ResumeContinuation;
  };

type ActorMessage = ActorCommand | ActorEvent;

interface ProvisioningLogBudget {
  remainingBytes: number;
  truncated: boolean;
  secrets: string[];
}

interface CommandOutput {
  exitCode: number;
  stdout: string;
}

interface Utf8Slice {
  head: string;
  tail: string;
  bytes: number;
}

/** Creates closure-backed local actors; each actor is owned by the supervisor's scope. */
export function makeSessionActorFactory(): Effect.Effect<
  SessionActorFactory,
  never,
  RunnerSessionStore | SessionEvents | AgentEnvironmentProvider | AgentHarness | Scope.Scope
> {
  return Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const events = yield* SessionEvents;
    const environmentProvider = yield* AgentEnvironmentProvider;
    const harness = yield* AgentHarness;
    const scope = yield* Scope.Scope;
    return SessionActorFactory.of({
      spawn: Effect.fn("SessionActorFactory.spawn")((input: SessionActorInput) =>
        makeSessionActor(input, store, events, environmentProvider, harness).pipe(
          Effect.provideService(Scope.Scope, scope),
        )
      ),
    });
  });
}

export const sessionActorFactoryLayer: Layer.Layer<
  SessionActorFactory,
  never,
  RunnerSessionStore | SessionEvents | AgentEnvironmentProvider | AgentHarness
> = Layer.effect(SessionActorFactory, makeSessionActorFactory());

function makeSessionActor(
  input: SessionActorInput,
  store: RunnerSessionStore,
  events: SessionEvents,
  environmentProvider: AgentEnvironmentProvider,
  harness: AgentHarness,
): Effect.Effect<SessionActor, never, Scope.Scope> {
  return Effect.gen(function* () {
    const sessionId = input.metadata.id;
    const mailbox = yield* Queue.unbounded<ActorMessage>();
    const state = MutableRef.make<ActorState>({ _tag: "Provisioning" });
    const backgroundScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(backgroundScope, Exit.void));
    const initialized = yield* Deferred.make<void>();
    const gitOperations = yield* Semaphore.make(1);
    const gitOperationActive = MutableRef.make(false);
    const gitSnapshots = makeGitSnapshotSynchronizer({
      sessionId,
      store,
      generate: generateSessionGitSnapshot,
      publishUpdated: (correlationId) =>
        events.publishLive(sessionId, correlationId, { type: "git.snapshot.updated" }),
    });
    const snapshotCoordinatorReady = yield* Deferred.make<GitSnapshotCoordinator<unknown>>();

    const transition = (next: ActorState): Effect.Effect<void> =>
      Effect.sync(() => MutableRef.set(state, next));
    const withGitOperation = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      gitOperations.withPermit(
        Effect.acquireUseRelease(
          Effect.sync(() => MutableRef.set(gitOperationActive, true)),
          () => operation,
          () => Effect.sync(() => MutableRef.set(gitOperationActive, false)),
        ),
      );
    const refreshGitSnapshot = withGitOperation(Effect.suspend(() => {
      const current = MutableRef.get(state);
      if (
        current._tag !== "Ready" && current._tag !== "Running" && current._tag !== "Aborting"
      ) return Effect.void;
      const correlationId = current._tag === "Ready" ? crypto.randomUUID() : current.runId;
      return (
        store.readMetadata(sessionId).pipe(
          Effect.flatMap((metadata) =>
            gitSnapshots.refresh(current.environment, metadata, correlationId)
          ),
          Effect.asVoid,
        )
      );
    }));

    function runActor(options: SessionActorInput): Effect.Effect<never, never, Scope.Scope> {
      return Effect.gen(function* () {
        const snapshotCoordinator = yield* makeGitSnapshotCoordinator(refreshGitSnapshot);
        yield* Deferred.succeed(snapshotCoordinatorReady, snapshotCoordinator);
        yield* idleStopLoop.pipe(Effect.forkChild);
        const fiber = yield* (options.restore ? restore(options) : provision(
          options.metadata,
          options.githubToken,
          options.modelRuntime,
          options.correlationId,
        )).pipe(
          Effect.catch(() => Effect.void),
          Effect.forkChild,
        );
        if (options.restore) yield* Fiber.join(fiber);
        return yield* Queue.take(mailbox).pipe(
          Effect.flatMap(handleMessage),
          Effect.forever,
        );
      });
    }

    function restore(
      options: SessionActorInput,
    ): Effect.Effect<void, SessionActorError, Scope.Scope> {
      return Effect.gen(function* () {
        const metadata = options.metadata;
        if (metadata.state === "stopped") {
          yield* transition({ _tag: "Stopped" });
          yield* Deferred.succeed(initialized, undefined);
          return;
        }
        const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
          Effect.mapError(actorError),
        );
        const resources = orbSizeResources(metadata.definition.orbSize);
        const environment = yield* environmentProvider.make({
          workspacePath,
          sessionLabel: `openorb session ${sessionId}`,
          github: {
            repositoryUrl: metadata.definition.repositoryUrl,
            gitAuthor: metadata.definition.gitAuthor,
          },
          cpuCount: resources.cpuCount,
          memoryMiB: resources.memoryMiB,
        }).pipe(Effect.mapError(actorError));
        if (metadata.checkoutState === "available") {
          yield* environment.runShell(
            "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
            { cwd: ".", onOutput: () => Effect.void },
          )
            .pipe(
              Effect.mapError(actorError),
              Effect.asVoid,
            );
        }
        yield* transition({ _tag: "Ready", environment });
        yield* Deferred.succeed(initialized, undefined);
      }).pipe(
        Effect.catch((error) =>
          failProvision(options.metadata, options.correlationId, {
            remainingBytes: MAX_PROVISIONING_LOG_BYTES,
            truncated: false,
            secrets: [],
          }, error)
        ),
      );
    }

    function handleMessage(message: ActorMessage): Effect.Effect<void, never, Scope.Scope> {
      return message.kind === "command" ? handleCommand(message) : handleEvent(message);
    }

    function handleCommand(command: ActorCommand): Effect.Effect<void, never, Scope.Scope> {
      switch (command._tag) {
        case "Wake":
          return handleWake(command.payload, command.reply);
        case "Prompt":
          return handlePrompt(command.payload, command.reply);
        case "Abort":
          return handleAbort(command.payload, command.reply);
        case "Stop":
          return handleStop(command.payload, command.idle, command.reply);
      }
    }

    function handleEvent(event: ActorEvent): Effect.Effect<void, never, Scope.Scope> {
      switch (event._tag) {
        case "ProvisioningUpdated":
          return store.updateProvisioning(sessionId, event.input).pipe(
            Effect.mapError(actorError),
            Effect.matchEffect({
              onFailure: (error) => Deferred.fail(event.reply, error),
              onSuccess: (metadata) => Deferred.succeed(event.reply, metadata),
            }),
            Effect.asVoid,
          );
        case "ProvisioningEnvironmentStarted": {
          const current = MutableRef.get(state);
          if (current._tag !== "Provisioning") {
            return Deferred.fail(
              event.reply,
              new SessionActorError(
                "The started environment no longer matches session provisioning.",
                undefined,
              ),
            ).pipe(Effect.asVoid);
          }
          return transition({ _tag: "Provisioning", environment: event.environment }).pipe(
            Effect.andThen(Deferred.succeed(initialized, undefined)),
            Effect.andThen(Deferred.succeed(event.reply, undefined)),
            Effect.asVoid,
          );
        }
        case "ProvisioningPrepared":
          return startProvisionedPrompt(event);
        case "ProvisioningFailed":
          return failProvision(
            event.metadata,
            event.correlationId,
            event.logBudget,
            event.error,
          );
        case "RunSettled": {
          const current = MutableRef.get(state);
          if (
            (current._tag !== "Running" && current._tag !== "Aborting") ||
            current.runId !== event.runId || current.startedBy !== event.startedBy
          ) {
            return event.reply
              ? Deferred.succeed(event.reply, undefined).pipe(Effect.asVoid)
              : Effect.void;
          }
          return store.settleRun(sessionId, event.runId, event.startedBy).pipe(
            Effect.mapError(actorError),
            Effect.flatMap((ready) =>
              event.provisioningFailure
                ? failProvision(
                  event.provisioningFailure.metadata,
                  event.provisioningFailure.correlationId,
                  event.provisioningFailure.logBudget,
                  event.provisioningFailure.error,
                )
                : transition({
                  _tag: "Ready",
                  environment: current.environment,
                  agentSession: current.agentSession,
                }).pipe(
                  Effect.andThen(
                    emitState(ready, "ready", event.runId).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning(
                          `Could not publish the ready state for session ${sessionId}: ${error.message}`,
                        )
                      ),
                    ),
                  ),
                )
            ),
            Effect.catch((error) =>
              Effect.logError(
                `Could not settle session ${sessionId} run ${event.runId}: ${error.message}`,
              )
            ),
            Effect.ensuring(event.reply ? Deferred.succeed(event.reply, undefined) : Effect.void),
            Effect.asVoid,
          );
        }
        case "CheckpointCompleted":
          return completeCheckpoint(event);
        case "CheckpointFailed":
          return failCheckpoint(event);
        case "ResumeCompleted":
          return completeResume(event);
        case "ResumeFailed":
          return failResume(event);
      }
    }

    function startProvisionedPrompt(
      event: Extract<ActorEvent, { readonly _tag: "ProvisioningPrepared" }>,
    ): Effect.Effect<void, never, Scope.Scope> {
      const current = MutableRef.get(state);
      if (current._tag !== "Provisioning" || current.environment !== event.environment) {
        return failProvision(
          event.metadata,
          event.correlationId,
          event.logBudget,
          new SessionActorError(
            "The prepared environment no longer matches session provisioning.",
            undefined,
          ),
        );
      }
      // SAFETY: Provisioning correlation identifiers are generated UUIDs.
      const runId = event.correlationId as RunId;
      return openAgentSession(event.environment, event.modelRuntime).pipe(
        Effect.flatMap((agentSession) =>
          startAgentPrompt(
            event.environment,
            agentSession,
            runId,
            event.metadata.definition.initialPrompt,
          )
        ),
        Effect.flatMap(({ run, startedBy }) =>
          consumeAgentRun(run, runId).pipe(
            Effect.exit,
            Effect.flatMap((outcome) =>
              Queue.offer(mailbox, {
                kind: "event",
                _tag: "RunSettled",
                runId,
                startedBy,
                ...(Exit.isFailure(outcome)
                  ? {
                    provisioningFailure: {
                      metadata: event.metadata,
                      correlationId: event.correlationId,
                      logBudget: event.logBudget,
                      error: actorError(outcome.cause),
                    },
                  }
                  : {}),
              })
            ),
            (effect) => Effect.forkIn(effect, backgroundScope),
          )
        ),
        Effect.catch((error) =>
          failProvision(
            event.metadata,
            event.correlationId,
            event.logBudget,
            actorError(error),
          )
        ),
        Effect.asVoid,
      );
    }

    function completeResume(
      event: Extract<ActorEvent, { readonly _tag: "ResumeCompleted" }>,
    ): Effect.Effect<void, never, Scope.Scope> {
      const current = MutableRef.get(state);
      if (current._tag !== "Resuming" || current.startedBy !== event.startedBy) {
        return rejectResumeContinuation(
          event.continuation,
          "The completed resume no longer matches the active operation.",
        );
      }
      return store.completeResume(sessionId, event.startedBy).pipe(
        Effect.mapError(actorError),
        Effect.flatMap((ready) =>
          transition({ _tag: "Ready", environment: event.environment }).pipe(
            Effect.andThen(emitState(ready, "ready", event.correlationId).pipe(Effect.ignore)),
          )
        ),
        Effect.flatMap(() => {
          const continuation = event.continuation;
          return continuation._tag === "Wake"
            ? restoreAgentSession(
              event.environment,
              continuation.payload.modelRuntime,
              continuation.reply,
            )
            : continuePrompt(
              continuation.payload,
              continuation.runId,
              event.environment,
              undefined,
              continuation.reply,
            ).pipe(
              Effect.catch(() =>
                Deferred.succeed(continuation.reply, {
                  ok: false,
                  message: "The agent prompt could not be started after resuming the checkpoint.",
                }).pipe(Effect.asVoid)
              ),
            );
        }),
        Effect.catch(() =>
          rejectResumeContinuation(
            event.continuation,
            "The resumed session could not be made ready.",
          )
        ),
        Effect.asVoid,
      );
    }

    function failResume(
      event: Extract<ActorEvent, { readonly _tag: "ResumeFailed" }>,
    ): Effect.Effect<void, never> {
      const current = MutableRef.get(state);
      if (current._tag !== "Resuming" || current.startedBy !== event.startedBy) {
        return rejectResumeContinuation(
          event.continuation,
          "The failed resume no longer matches the active operation.",
        );
      }
      return store.failResume(sessionId, event.startedBy).pipe(
        Effect.flatMap((stopped) =>
          transition({ _tag: "Stopped" }).pipe(
            Effect.andThen(emitState(stopped, "stopped", event.correlationId).pipe(Effect.ignore)),
          )
        ),
        Effect.catch(() => transition({ _tag: "Stopped" })),
        Effect.andThen(rejectResumeContinuation(
          event.continuation,
          event.continuation._tag === "Prompt"
            ? "The checkpoint could not be resumed. The prompt was not dispatched."
            : "The checkpoint could not be resumed.",
        )),
        Effect.asVoid,
      );
    }

    function rejectResumeContinuation(
      continuation: ResumeContinuation,
      message: string,
    ): Effect.Effect<void> {
      return continuation._tag === "Wake"
        ? Deferred.succeed(continuation.reply, { ok: false, message }).pipe(Effect.asVoid)
        : Deferred.succeed(continuation.reply, { ok: false, message }).pipe(Effect.asVoid);
    }

    function completeCheckpoint(
      event: Extract<ActorEvent, { readonly _tag: "CheckpointCompleted" }>,
    ): Effect.Effect<void, never> {
      const current = MutableRef.get(state);
      if (
        current._tag !== "Checkpointing" ||
        current.candidate.startedBy !== event.candidate.startedBy
      ) {
        return Deferred.succeed(event.reply, {
          ok: false,
          message: "The completed checkpoint no longer matches the active operation.",
        }).pipe(Effect.asVoid);
      }
      return store.publishCheckpoint(sessionId, event.candidate, event.checkpoint).pipe(
        Effect.mapError(actorError),
        Effect.flatMap((stopped) =>
          transition({ _tag: "Stopped" }).pipe(
            Effect.andThen(emitState(stopped, "stopped", event.correlationId).pipe(Effect.ignore)),
            Effect.andThen(Deferred.succeed(event.reply, { ok: true })),
          )
        ),
        Effect.catch(() =>
          failCheckpoint({
            kind: "event",
            _tag: "CheckpointFailed",
            candidate: event.candidate,
            consumed: true,
            correlationId: event.correlationId,
            reply: event.reply,
          })
        ),
        Effect.asVoid,
      );
    }

    function failCheckpoint(
      event: Extract<ActorEvent, { readonly _tag: "CheckpointFailed" }>,
    ): Effect.Effect<void, never> {
      const current = MutableRef.get(state);
      if (
        current._tag !== "Checkpointing" ||
        current.candidate.startedBy !== event.candidate.startedBy
      ) {
        return Deferred.succeed(event.reply, {
          ok: false,
          message: "The failed checkpoint no longer matches the active operation.",
        }).pipe(Effect.asVoid);
      }
      return store.failCheckpoint(sessionId, event.candidate, event.consumed).pipe(
        Effect.catch(() => store.readMetadata(sessionId)),
        Effect.flatMap((metadata) =>
          event.consumed
            ? transition({ _tag: "Failed" }).pipe(
              Effect.andThen(
                emitState(metadata, "failed", event.correlationId).pipe(Effect.ignore),
              ),
            )
            : transition({ _tag: "Ready", environment: current.environment })
        ),
        Effect.andThen(Deferred.succeed(event.reply, {
          ok: false,
          message: event.consumed
            ? "The VM stopped, but its checkpoint could not be published. The session was not stopped successfully."
            : "The session checkpoint could not be created.",
        })),
        Effect.catch(() =>
          transition(
            event.consumed ? { _tag: "Failed" } : {
              _tag: "Ready",
              environment: current.environment,
            },
          ).pipe(
            Effect.andThen(Deferred.succeed(event.reply, {
              ok: false,
              message: "The failed checkpoint could not be reconciled.",
            })),
          )
        ),
        Effect.asVoid,
      );
    }

    function handleWake(
      payload: WakeSessionPayload,
      reply: Deferred.Deferred<WakeAcceptance>,
    ): Effect.Effect<void, never, Scope.Scope> {
      const current = MutableRef.get(state);
      if (input.metadata.definition.model !== payload.modelRuntime.model) {
        return Deferred.succeed(reply, {
          ok: false,
          message: "The session model cannot change during restoration.",
        }).pipe(Effect.asVoid);
      }
      if (current._tag === "Running" || current._tag === "Aborting") {
        return Deferred.succeed(reply, { ok: true }).pipe(Effect.asVoid);
      }
      if (current._tag === "Stopped") {
        return beginResume({ _tag: "Wake", payload, reply }, crypto.randomUUID());
      }
      if (current._tag !== "Ready") {
        return Deferred.succeed(reply, {
          ok: false,
          message: "The session environment could not be restored.",
        }).pipe(Effect.asVoid);
      }
      if (current.agentSession !== undefined) {
        return Deferred.succeed(reply, { ok: true }).pipe(Effect.asVoid);
      }
      return restoreAgentSession(current.environment, payload.modelRuntime, reply);
    }

    function restoreAgentSession(
      environment: AgentEnvironment,
      modelRuntime: SessionModelRuntime,
      reply: Deferred.Deferred<WakeAcceptance>,
    ): Effect.Effect<void, never, Scope.Scope> {
      return openAgentSession(environment, modelRuntime).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Deferred.succeed(reply, {
              ok: false,
              message: "The agent session could not be restored.",
            }),
          onSuccess: (agentSession) =>
            transition({ _tag: "Ready", environment, agentSession }).pipe(
              Effect.andThen(Deferred.succeed(reply, { ok: true })),
            ),
        }),
        Effect.asVoid,
      );
    }

    function handlePrompt(
      payload: PromptSessionPayload,
      reply: Deferred.Deferred<PromptAcceptance>,
    ): Effect.Effect<void, never, Scope.Scope> {
      const current = MutableRef.get(state);
      if (current._tag === "Running") {
        return current.run.followUp(payload.prompt).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Deferred.succeed(reply, {
                ok: false,
                message:
                  "Pi could not confirm the follow-up; delivery may be uncertain and will not be retried automatically.",
              }),
            onSuccess: () =>
              store.acceptFollowUp(sessionId, current.runId).pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Deferred.succeed(reply, {
                      ok: false,
                      message:
                        "Pi accepted the follow-up, but its idle timestamp could not be saved; delivery is uncertain.",
                    }),
                  onSuccess: () =>
                    Deferred.succeed(reply, {
                      ok: true,
                      runId: current.runId,
                      mode: "follow-up",
                    }),
                }),
              ),
          }),
          Effect.asVoid,
        );
      }
      if (current._tag === "Aborting") {
        return Deferred.succeed(reply, { ok: false, message: "The session is aborting." }).pipe(
          Effect.asVoid,
        );
      }
      if (current._tag === "Stopped") {
        if (input.metadata.definition.model !== payload.modelRuntime.model) {
          return Deferred.succeed(reply, {
            ok: false,
            message: "The session model cannot change during continuation.",
          }).pipe(Effect.asVoid);
        }
        // SAFETY: Run identifiers are generated UUIDs.
        const runId = crypto.randomUUID() as RunId;
        return beginResume({ _tag: "Prompt", payload, runId, reply }, runId);
      }
      if (current._tag !== "Ready") {
        return Deferred.succeed(reply, {
          ok: false,
          message: "The session is not ready and idle.",
        }).pipe(Effect.asVoid);
      }
      // SAFETY: Run identifiers are generated UUIDs.
      const runId = crypto.randomUUID() as RunId;
      return continuePrompt(payload, runId, current.environment, current.agentSession, reply).pipe(
        Effect.catch(() =>
          Deferred.succeed(reply, {
            ok: false,
            message: "The agent prompt could not be started. Try again.",
          }).pipe(Effect.asVoid)
        ),
        Effect.asVoid,
      );
    }

    function beginResume(
      continuation: ResumeContinuation,
      correlationId: string,
    ): Effect.Effect<void, never, Scope.Scope> {
      return Effect.gen(function* () {
        const started = yield* store.beginResume(sessionId).pipe(Effect.mapError(actorError));
        yield* transition({ _tag: "Resuming", startedBy: started.startedBy });
        yield* emitState(started.metadata, "resuming", correlationId).pipe(Effect.ignore);
        yield* resumeStoppedEnvironment(continuation.payload, correlationId).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Queue.offer(mailbox, {
                kind: "event",
                _tag: "ResumeFailed",
                startedBy: started.startedBy,
                correlationId,
                continuation,
              }),
            onSuccess: (environment) =>
              Queue.offer(mailbox, {
                kind: "event",
                _tag: "ResumeCompleted",
                startedBy: started.startedBy,
                environment,
                correlationId,
                continuation,
              }),
          }),
          (effect) => Effect.forkIn(effect, backgroundScope),
        );
      }).pipe(
        Effect.catch(() =>
          transition({ _tag: "Stopped" }).pipe(
            Effect.andThen(rejectResumeContinuation(
              continuation,
              continuation._tag === "Prompt"
                ? "The checkpoint could not be resumed. The prompt was not dispatched."
                : "The checkpoint could not be resumed.",
            )),
          )
        ),
        Effect.asVoid,
      );
    }

    function handleAbort(
      payload: AbortSessionPayload,
      reply: Deferred.Deferred<AbortAcceptance>,
    ): Effect.Effect<void> {
      const current = MutableRef.get(state);
      if (current._tag !== "Running" || current.runId !== payload.runId) {
        return Deferred.succeed(reply, {
          ok: false,
          message: "That agent run is no longer active.",
        }).pipe(Effect.asVoid);
      }
      MutableRef.set(state, { ...current, _tag: "Aborting" });
      return current.run.abort.pipe(
        Effect.matchEffect({
          onFailure: () => {
            MutableRef.set(state, current);
            return Deferred.succeed(reply, {
              ok: false,
              message: "The agent run could not be aborted.",
            });
          },
          onSuccess: () => Deferred.succeed(reply, { ok: true }),
        }),
        Effect.asVoid,
      );
    }

    function handleStop(
      _payload: StopSessionPayload,
      idle: boolean,
      reply: Deferred.Deferred<StopAcceptance>,
    ): Effect.Effect<void, never> {
      const current = MutableRef.get(state);
      if (current._tag !== "Ready") {
        return Deferred.succeed(reply, {
          ok: false,
          message: current._tag === "Running" || current._tag === "Aborting"
            ? "Abort the active Pi run before stopping the session."
            : "The session is not ready and idle.",
        }).pipe(Effect.asVoid);
      }
      if (MutableRef.get(gitOperationActive)) {
        return Deferred.succeed(reply, {
          ok: false,
          message: "Wait for the active Git Snapshot operation before stopping the session.",
        }).pipe(Effect.asVoid);
      }
      const correlationId = crypto.randomUUID();
      return Effect.gen(function* () {
        const metadata = yield* store.readMetadata(sessionId).pipe(Effect.mapError(actorError));
        if (idle) {
          const now = yield* Clock.currentTimeMillis;
          const acceptedAt = metadata.lastAcceptedUserMessageAt === undefined
            ? undefined
            : Date.parse(metadata.lastAcceptedUserMessageAt);
          if (
            acceptedAt === undefined || !Number.isFinite(acceptedAt) ||
            now - acceptedAt < input.idleTimeoutMs
          ) {
            yield* Deferred.succeed(reply, {
              ok: false,
              message: "The session has not been idle long enough to stop.",
            });
            return;
          }
        }
        const candidate = yield* store.beginCheckpoint(sessionId).pipe(
          Effect.mapError(actorError),
        );
        yield* transition({ ...current, _tag: "Checkpointing", candidate });
        yield* emitState(metadata, "checkpointing", correlationId).pipe(Effect.ignore);
        yield* checkpointReadySession(current, candidate, correlationId, reply).pipe(
          (effect) => Effect.forkIn(effect, backgroundScope),
        );
      }).pipe(
        Effect.catch(() =>
          transition(current).pipe(
            Effect.andThen(Deferred.succeed(reply, {
              ok: false,
              message: "The session checkpoint could not be started.",
            })),
          )
        ),
        Effect.asVoid,
      );
    }

    function checkpointReadySession(
      ready: Extract<ActorState, { _tag: "Ready" }>,
      candidate: RunnerSessionCheckpointCandidate,
      correlationId: string,
      reply: Deferred.Deferred<StopAcceptance>,
    ): Effect.Effect<void, never> {
      let consumed = false;
      return Effect.gen(function* () {
        yield* withGitOperation(
          store.readMetadata(sessionId).pipe(
            Effect.flatMap((latest) =>
              gitSnapshots.refresh(ready.environment, latest, correlationId)
            ),
            Effect.asVoid,
          ),
        ).pipe(Effect.mapError(actorError));
        yield* ready.environment.run(["/bin/sync"]).pipe(
          Effect.mapError(actorError),
          Effect.asVoid,
        );
        if (ready.agentSession) yield* closeAgentSession(ready.agentSession);
        const checkpoint = yield* ready.environment.checkpoint(candidate.path).pipe(
          Effect.tapError((error) => Effect.sync(() => consumed = error.consumed)),
          Effect.mapError(actorError),
        );
        consumed = true;
        yield* Queue.offer(mailbox, {
          kind: "event",
          _tag: "CheckpointCompleted",
          candidate,
          checkpoint,
          correlationId,
          reply,
        });
      }).pipe(
        Effect.catch(() =>
          Queue.offer(mailbox, {
            kind: "event",
            _tag: "CheckpointFailed",
            candidate,
            consumed,
            correlationId,
            reply,
          })
        ),
        Effect.asVoid,
      );
    }

    const updateGitFile = Effect.fn("SessionActor.updateGitFile")(function* (
      payload: UpdateSessionGitFilePayload,
    ) {
      yield* Deferred.await(initialized);
      const current = MutableRef.get(state);
      if (
        current._tag !== "Ready" && current._tag !== "Running" && current._tag !== "Aborting"
      ) {
        return rejectGitFileUpdate(
          "Files cannot be staged or unstaged until the session environment is available.",
        );
      }

      return yield* withGitOperation(
        Effect.suspend(() => {
          const active = MutableRef.get(state);
          if (
            active._tag !== "Ready" && active._tag !== "Running" && active._tag !== "Aborting"
          ) {
            return Effect.succeed(rejectGitFileUpdate(
              "Files cannot be changed while the session is stopping or stopped.",
            ));
          }
          return store.readMetadata(sessionId).pipe(
            Effect.flatMap((metadata) =>
              updateSessionGitFile(active.environment, metadata, payload).pipe(
                Effect.map((result) => ({ metadata, result })),
              )
            ),
            Effect.flatMap(
              ({ metadata, result }): Effect.Effect<GitFileUpdateAcceptance, unknown> => {
                const correlationId = crypto.randomUUID();
                return gitSnapshots.refresh(active.environment, metadata, correlationId).pipe(
                  Effect.as<GitFileUpdateAcceptance>(
                    result.ok ? { ok: true } : rejectGitFileUpdate(result.message),
                  ),
                  Effect.catch(() =>
                    Effect.succeed(rejectGitFileUpdate(
                      "The Git index may have changed, but its refreshed Git Snapshot could not be saved.",
                    ))
                  ),
                );
              },
            ),
            Effect.catch(() =>
              Effect.succeed(rejectGitFileUpdate("The Git index could not be updated."))
            ),
          );
        }),
      );
    });

    function persistProvisioningUpdate(
      input: UpdateRunnerSessionProvisioningInput,
    ): Effect.Effect<RunnerSessionMetadata, SessionActorError> {
      return Effect.gen(function* () {
        const reply = yield* Deferred.make<RunnerSessionMetadata, SessionActorError>();
        yield* Queue.offer(mailbox, {
          kind: "event",
          _tag: "ProvisioningUpdated",
          input,
          reply,
        });
        return yield* Deferred.await(reply);
      });
    }

    function registerProvisioningEnvironment(
      environment: AgentEnvironment,
    ): Effect.Effect<void, SessionActorError> {
      return Effect.gen(function* () {
        const reply = yield* Deferred.make<void, SessionActorError>();
        yield* Queue.offer(mailbox, {
          kind: "event",
          _tag: "ProvisioningEnvironmentStarted",
          environment,
          reply,
        });
        return yield* Deferred.await(reply);
      });
    }

    function provision(
      initialMetadata: RunnerSessionMetadata,
      githubToken: string | undefined,
      modelRuntime: SessionModelRuntime,
      correlationId: string,
    ): Effect.Effect<void, never, Scope.Scope> {
      const sessionId = initialMetadata.id;
      const logBudget: ProvisioningLogBudget = {
        remainingBytes: MAX_PROVISIONING_LOG_BYTES,
        truncated: false,
        secrets: [githubToken, modelRuntime.credential.value].filter((value): value is string =>
          value !== undefined
        ),
      };
      let metadata = initialMetadata;
      const operation = Effect.gen(function* () {
        metadata = yield* persistProvisioningUpdate({
          state: "provisioning",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        });
        yield* emitState(metadata, "starting-vm", correlationId);
        const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
          Effect.mapError(actorError),
        );
        const resources = orbSizeResources(metadata.definition.orbSize);
        const environment = yield* environmentProvider.make({
          workspacePath,
          sessionLabel: `openorb session ${sessionId}`,
          github: {
            repositoryUrl: metadata.definition.repositoryUrl,
            gitAuthor: metadata.definition.gitAuthor,
            ...(githubToken === undefined ? {} : { token: githubToken }),
          },
          cpuCount: resources.cpuCount,
          memoryMiB: resources.memoryMiB,
        }).pipe(Effect.mapError(actorError));
        yield* registerProvisioningEnvironment(environment);

        if (metadata.checkoutState === "pending") {
          yield* Effect.tryPromise({
            try: () => clearWorkspace(workspacePath),
            catch: (cause) => new SessionActorError("Could not clear the workspace.", cause),
          });
          yield* emitState(metadata, "cloning", correlationId);
          const clone = yield* runCommand(
            environment,
            [
              "/usr/bin/git",
              "clone",
              "--no-recurse-submodules",
              "--branch",
              metadata.definition.ref,
              "--single-branch",
              metadata.definition.repositoryUrl,
              ".",
            ],
            correlationId,
            logBudget,
          );
          if (clone.exitCode !== 0) {
            metadata = yield* persistProvisioningUpdate({
              state: "provisioning",
              checkoutState: "unavailable",
            });
            yield* emitLog(
              correlationId,
              "stderr",
              "Repository clone failed. The checkout is unavailable; the stored prompt remains ready for Pi.\n",
            );
          } else {
            const revision = yield* runCommand(
              environment,
              ["/usr/bin/git", "rev-parse", "HEAD"],
              correlationId,
              logBudget,
              true,
            );
            if (revision.exitCode !== 0) {
              return yield* new SessionActorError(
                "Git could not report the cloned base commit.",
                undefined,
              );
            }
            yield* emitState(metadata, "creating-branch", correlationId);
            const branch = yield* runCommand(
              environment,
              ["/usr/bin/git", "switch", "-c", metadata.definition.branchName],
              correlationId,
              logBudget,
            );
            if (branch.exitCode !== 0) {
              return yield* new SessionActorError(
                "Git could not create the session branch.",
                undefined,
              );
            }
            metadata = yield* persistProvisioningUpdate({
              state: "provisioning",
              checkoutState: "available",
              baseCommit: revision.stdout.trim(),
            });
          }
        }

        if (metadata.checkoutState === "available") {
          yield* emitState(metadata, "setup", correlationId);
          const setup = yield* runCommand(
            environment,
            [
              "/bin/sh",
              "-lc",
              "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
            ],
            correlationId,
            logBudget,
          );
          if (setup.exitCode !== 0) {
            yield* emitLog(
              correlationId,
              "stderr",
              `.agents/setup exited with status ${setup.exitCode}; continuing to Pi so it can repair the project.\n`,
            );
          }
        }

        yield* Queue.offer(mailbox, {
          kind: "event",
          _tag: "ProvisioningPrepared",
          environment,
          metadata,
          modelRuntime,
          correlationId,
          logBudget,
        });
      });
      return operation.pipe(
        Effect.catch((error) =>
          Queue.offer(mailbox, {
            kind: "event",
            _tag: "ProvisioningFailed",
            metadata,
            correlationId,
            logBudget,
            error: actorError(error),
          })
        ),
        Effect.asVoid,
      );
    }

    function failProvision(
      metadata: RunnerSessionMetadata,
      correlationId: string,
      logBudget: ProvisioningLogBudget,
      error: SessionActorError,
    ): Effect.Effect<void, never> {
      const actorState = MutableRef.get(state);
      return store.readMetadata(sessionId).pipe(
        Effect.orElseSucceed(() => metadata),
        Effect.flatMap((current) =>
          store.updateProvisioning(sessionId, {
            state: "error",
            checkoutState: current.checkoutState,
            ...(current.baseCommit === undefined ? {} : { baseCommit: current.baseCommit }),
          }).pipe(Effect.orElseSucceed(() => current))
        ),
        Effect.flatMap((failed) =>
          transition({
            _tag: "Failed",
            ...(actorState._tag === "Provisioning" && actorState.environment
              ? { environment: actorState.environment }
              : {}),
          }).pipe(
            Effect.andThen(Deferred.succeed(initialized, undefined)),
            Effect.andThen(Effect.all([
              emitLog(
                correlationId,
                "stderr",
                `Provisioning failed: ${redactedErrorMessage(error, logBudget.secrets)}\n`,
              ).pipe(Effect.ignore),
              emitState(failed, "failed", correlationId).pipe(Effect.ignore),
            ], { concurrency: "unbounded", discard: true })),
          )
        ),
        Effect.asVoid,
      );
    }

    function resumeStoppedEnvironment(
      payload: Pick<PromptSessionPayload, "modelRuntime" | "githubToken">,
      correlationId: string,
    ): Effect.Effect<AgentEnvironment, SessionActorError, Scope.Scope> {
      let resumedScope: Scope.Closeable | undefined;
      const operation = Effect.gen(function* () {
        const metadata = yield* store.readMetadata(sessionId).pipe(Effect.mapError(actorError));
        if (metadata.state !== "stopped") {
          return yield* new SessionActorError(
            "The session no longer has a stopped checkpoint.",
            undefined,
          );
        }
        if (metadata.definition.model !== payload.modelRuntime.model) {
          return yield* new SessionActorError(
            "The session model cannot change during continuation.",
            undefined,
          );
        }
        const checkpoint = yield* store.readCurrentCheckpoint(sessionId).pipe(
          Effect.mapError(actorError),
        );
        const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
          Effect.mapError(actorError),
        );
        const resources = orbSizeResources(metadata.definition.orbSize);
        resumedScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(resumedScope!, Exit.void));
        const environment = yield* environmentProvider.make({
          workspacePath,
          sessionLabel: `openorb session ${sessionId}`,
          github: {
            repositoryUrl: metadata.definition.repositoryUrl,
            gitAuthor: metadata.definition.gitAuthor,
            ...(payload.githubToken === undefined ? {} : { token: payload.githubToken }),
          },
          cpuCount: resources.cpuCount,
          memoryMiB: resources.memoryMiB,
          resumeCheckpoint: checkpoint,
        }).pipe(
          Effect.provideService(Scope.Scope, resumedScope),
          Effect.mapError(actorError),
        );
        if (metadata.checkoutState === "available") {
          const logBudget: ProvisioningLogBudget = {
            remainingBytes: MAX_PROVISIONING_LOG_BYTES,
            truncated: false,
            secrets: [payload.githubToken, payload.modelRuntime.credential.value].filter(
              (value): value is string => value !== undefined,
            ),
          };
          const resume = yield* runCommand(
            environment,
            [
              "/bin/sh",
              "-lc",
              "if [ -x .agents/resume ]; then exec ./.agents/resume; fi",
            ],
            correlationId,
            logBudget,
          );
          if (resume.exitCode !== 0) {
            yield* emitLog(
              correlationId,
              "stderr",
              `.agents/resume exited with status ${resume.exitCode}; continuing to Pi so it can repair the project.\n`,
            ).pipe(Effect.ignore);
          }
        }
        return environment;
      });
      return operation.pipe(
        Effect.onError(() => resumedScope ? Scope.close(resumedScope, Exit.void) : Effect.void),
        Effect.tapError((error) =>
          emitLog(
            correlationId,
            "stderr",
            `Checkpoint resume failed: ${
              redactedErrorMessage(
                error,
                [payload.githubToken, payload.modelRuntime.credential.value].filter(
                  (value): value is string => value !== undefined,
                ),
              )
            }\n`,
          ).pipe(Effect.ignore)
        ),
      );
    }

    function continuePrompt(
      payload: PromptSessionPayload,
      runId: RunId,
      environment: AgentEnvironment,
      agentSession: OpenAgentSession | undefined,
      reply: Deferred.Deferred<PromptAcceptance>,
    ): Effect.Effect<void, SessionActorError, Scope.Scope> {
      return Effect.gen(function* () {
        const metadata = yield* store.readMetadata(sessionId).pipe(
          Effect.mapError(actorError),
        );
        if (metadata.definition.model !== payload.modelRuntime.model) {
          yield* Deferred.succeed(reply, {
            ok: false,
            message: "The session model cannot change during continuation.",
          });
          return;
        }
        const activeAgentSession = agentSession ??
          (yield* openAgentSession(environment, payload.modelRuntime));
        if (agentSession === undefined) {
          yield* transition({ _tag: "Ready", environment, agentSession: activeAgentSession });
        }
        const { run, startedBy } = yield* startAgentPrompt(
          environment,
          activeAgentSession,
          runId,
          payload.prompt,
        );
        yield* Deferred.succeed(reply, { ok: true, runId, mode: "started" });
        yield* consumeAgentRun(run, runId).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Session ${sessionId} run ${runId} failed: ${error.message}`)
          ),
          Effect.ensuring(Queue.offer(mailbox, {
            kind: "event",
            _tag: "RunSettled",
            runId,
            startedBy,
          })),
          (effect) => Effect.forkIn(effect, backgroundScope),
        );
      });
    }

    function startAgentPrompt(
      environment: AgentEnvironment,
      agentSession: OpenAgentSession,
      runId: RunId,
      prompt: string,
    ): Effect.Effect<
      { readonly run: ActiveAgentRun; readonly startedBy: number },
      SessionActorError
    > {
      return Effect.gen(function* () {
        const run = yield* agentSession.session.start(prompt).pipe(Effect.mapError(actorError));
        const started = yield* store.startRun(sessionId, runId).pipe(
          Effect.mapError(actorError),
          Effect.tapError(() => run.abort.pipe(Effect.ignore)),
        );
        yield* emitState(started.metadata, "running", runId).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not publish the running state for session ${sessionId}: ${error.message}`,
            )
          ),
        );
        yield* transition({
          _tag: "Running",
          environment,
          agentSession,
          runId,
          startedBy: started.startedBy,
          run,
        });
        return { run, startedBy: started.startedBy };
      });
    }

    function consumeAgentRun(
      run: ActiveAgentRun,
      runId: RunId,
    ): Effect.Effect<void, SessionActorError> {
      return Effect.gen(function* () {
        const snapshotCoordinator = yield* Deferred.await(snapshotCoordinatorReady);
        yield* run.events.pipe(
          Stream.runForEach((event) => {
            const publication = publish(events.publishLive(sessionId, runId, event));
            const snapshotBoundary = event.type === "turn.completed" ||
              (event.type === "message.completed" && event.role === "toolResult");
            return snapshotBoundary
              ? publication.pipe(Effect.andThen(snapshotCoordinator.trigger))
              : publication;
          }),
          Effect.mapError(actorError),
          Effect.ensuring(
            snapshotCoordinator.flush.pipe(
              Effect.tap((outcome) =>
                Exit.isFailure(outcome)
                  ? Effect.logWarning(
                    "The run-end Git Snapshot refresh failed; the session will retain its last saved snapshot.",
                  )
                  : Effect.void
              ),
              Effect.asVoid,
            ),
          ),
        );
      });
    }

    function openAgentSession(
      environment: AgentEnvironment,
      modelRuntime: SessionModelRuntime,
    ): Effect.Effect<OpenAgentSession, SessionActorError, Scope.Scope> {
      return Effect.gen(function* () {
        const paths = yield* store.getSessionPiPaths(sessionId).pipe(
          Effect.mapError(actorError),
        );
        const sessionScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
        const session = yield* harness.open({
          sessionId,
          environment,
          git: {
            repositoryUrl: input.metadata.definition.repositoryUrl,
            branchName: input.metadata.definition.branchName,
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
    }

    function closeAgentSession(session: OpenAgentSession): Effect.Effect<void> {
      return Scope.close(session.scope, Exit.void);
    }

    function runCommand(
      environment: AgentEnvironment,
      command: string[],
      correlationId: string,
      logBudget: ProvisioningLogBudget,
      captureStdout = false,
    ): Effect.Effect<CommandOutput, SessionActorError> {
      let stdout = "";
      return Effect.gen(function* () {
        const result = yield* environment.run(command, {
          onOutput: (output) =>
            Effect.gen(function* () {
              if (captureStdout && output.stream === "stdout") {
                stdout = appendBounded(stdout, output.text, MAX_CAPTURED_COMMAND_BYTES);
              }
              yield* emitBoundedOutput(
                correlationId,
                output.stream,
                output.text,
                logBudget,
              );
            }),
        }).pipe(Effect.mapError(actorError));
        return { exitCode: result.exitCode, stdout };
      });
    }

    function emitBoundedOutput(
      correlationId: string,
      stream: "stdout" | "stderr",
      rawText: string,
      budget: ProvisioningLogBudget,
    ): Effect.Effect<void, SessionActorError> {
      return Effect.gen(function* () {
        let text = sanitizeOutput(rawText);
        for (const secret of budget.secrets) text = text.replaceAll(secret, "[REDACTED]");
        while (text.length > 0 && budget.remainingBytes > 0) {
          const limit = Math.min(budget.remainingBytes, MAX_RPC_SESSION_EVENT_TEXT_BYTES);
          const { head, tail, bytes } = takeUtf8(text, limit);
          if (head.length === 0) break;
          yield* emitLog(correlationId, stream, head);
          budget.remainingBytes -= bytes;
          text = tail;
        }
        if (text.length > 0 && !budget.truncated) {
          budget.truncated = true;
          yield* emitLog(correlationId, "stderr", OUTPUT_TRUNCATED_MESSAGE);
        }
      });
    }

    function emitState(
      metadata: RunnerSessionMetadata,
      stage: SessionProvisioningStage,
      correlationId: string,
    ): Effect.Effect<void, SessionActorError> {
      return publish(events.publishLive(
        sessionId,
        correlationId,
        { type: "session.state", stage, checkoutState: metadata.checkoutState },
      ));
    }

    function emitLog(
      correlationId: string,
      stream: "stdout" | "stderr",
      text: string,
    ): Effect.Effect<void, SessionActorError> {
      return publish(events.publishLive(
        sessionId,
        correlationId,
        { type: "provisioning.log", stream, text },
      ));
    }

    function publish(
      publication: Effect.Effect<void, unknown>,
    ): Effect.Effect<void, SessionActorError> {
      return publication.pipe(
        Effect.mapError((cause) =>
          new SessionActorError("Session event publication failed.", cause)
        ),
      );
    }

    const wake = Effect.fn("SessionActor.wake")(function* (payload: WakeSessionPayload) {
      const reply = yield* Deferred.make<WakeAcceptance>();
      yield* Queue.offer(mailbox, { kind: "command", _tag: "Wake", payload, reply });
      return yield* Deferred.await(reply);
    });
    const prompt = Effect.fn("SessionActor.prompt")(function* (
      payload: PromptSessionPayload,
    ) {
      const reply = yield* Deferred.make<PromptAcceptance>();
      yield* Queue.offer(mailbox, { kind: "command", _tag: "Prompt", payload, reply });
      return yield* Deferred.await(reply);
    });
    const abort = Effect.fn("SessionActor.abort")(function* (
      payload: AbortSessionPayload,
    ) {
      const reply = yield* Deferred.make<AbortAcceptance>();
      yield* Queue.offer(mailbox, { kind: "command", _tag: "Abort", payload, reply });
      return yield* Deferred.await(reply);
    });
    const stop = Effect.fn("SessionActor.stop")(function* (
      payload: StopSessionPayload,
    ) {
      const reply = yield* Deferred.make<StopAcceptance>();
      yield* Queue.offer(mailbox, {
        kind: "command",
        _tag: "Stop",
        payload,
        idle: false,
        reply,
      });
      return yield* Deferred.await(reply);
    });
    const idleStopLoop = Effect.gen(function* () {
      const retryDelayMs = Math.max(1, Math.min(1_000, input.idleTimeoutMs));
      while (true) {
        const metadata = yield* store.readMetadata(sessionId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (
          metadata === undefined || metadata.lastAcceptedUserMessageAt === undefined ||
          metadata.state === "stopped" || metadata.state === "error"
        ) {
          yield* Effect.sleep(input.idleTimeoutMs);
          continue;
        }
        const acceptedAt = Date.parse(metadata.lastAcceptedUserMessageAt);
        const now = yield* Clock.currentTimeMillis;
        const delay = Number.isFinite(acceptedAt)
          ? Math.max(0, acceptedAt + input.idleTimeoutMs - now)
          : input.idleTimeoutMs;
        if (delay > 0) yield* Effect.sleep(delay);
        const reply = yield* Deferred.make<StopAcceptance>();
        yield* Queue.offer(mailbox, {
          kind: "command",
          _tag: "Stop",
          payload: { sessionId },
          idle: true,
          reply,
        });
        const result = yield* Deferred.await(reply);
        if (!result.ok) yield* Effect.sleep(retryDelayMs);
      }
    });
    const actor = yield* Effect.scoped(
      Effect.suspend(() => runActor(input)).pipe(
        Effect.ensuring(Queue.shutdown(mailbox)),
      ),
    ).pipe(Effect.forkScoped);

    return {
      sessionId,
      get activeRunId() {
        const current = MutableRef.get(state);
        return current._tag === "Running" || current._tag === "Aborting"
          ? current.runId
          : undefined;
      },
      get active() {
        const current = MutableRef.get(state);
        return current._tag !== "Stopped" &&
          (current._tag !== "Failed" || current.environment !== undefined);
      },
      wake,
      prompt,
      abort,
      stop,
      updateGitFile,
      shutdown: Fiber.interrupt(actor).pipe(
        Effect.andThen(Scope.close(backgroundScope, Exit.void)),
        Effect.asVoid,
      ),
    } satisfies SessionActor;
  });
}

export class SessionActorError extends Data.TaggedError("SessionActorError")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  constructor(message: string, cause: unknown) {
    super({ message, cause });
  }
}

function actorError(cause: unknown): SessionActorError {
  return cause instanceof SessionActorError
    ? cause
    : new SessionActorError("The session actor operation failed.", cause);
}

async function clearWorkspace(workspacePath: string): Promise<void> {
  for await (const entry of Deno.readDir(workspacePath)) {
    await Deno.remove(join(workspacePath, entry.name), { recursive: entry.isDirectory });
  }
}

function sanitizeOutput(value: string): string {
  let sanitized = "";
  for (const codePoint of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) sanitized += codePoint;
  }
  return sanitized;
}

function redactedErrorMessage(error: unknown, secrets: string[]): string {
  let redacted = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return sanitizeOutput(redacted).slice(0, 1000) || "unknown runner error";
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const remaining = maxBytes - byteLength(current);
  return remaining <= 0 ? current : current + takeUtf8(next, remaining).head;
}

function takeUtf8(value: string, maxBytes: number): Utf8Slice {
  if (maxBytes <= 0 || value.length === 0) return { head: "", tail: value, bytes: 0 };
  const encoder = new TextEncoder();
  let end = 0;
  let bytes = 0;
  for (const codePoint of value) {
    const size = encoder.encode(codePoint).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return { head: value.slice(0, end), tail: value.slice(end), bytes };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
