import {
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
  UpdateSessionGitFilePayload,
} from "@openorb/protocol/runner-api";
import { MAX_RPC_SESSION_EVENT_TEXT_BYTES } from "@openorb/protocol/runner-api";
import { join } from "node:path";

import type { AgentEnvironment } from "../environment/agent-environment.ts";
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
import { type RunnerSessionMetadata, RunnerSessionStore } from "./store.ts";

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

const rejectGitFileUpdate = (message: string): GitFileUpdateAcceptance => ({
  ok: false,
  message,
});

interface SessionWorkerInputBase {
  metadata: RunnerSessionMetadata;
  githubToken?: string | undefined;
  correlationId: string;
}

export type SessionWorkerInput =
  | (SessionWorkerInputBase & { readonly restore: true })
  | (SessionWorkerInputBase & { readonly restore?: false; modelRuntime: SessionModelRuntime });

export interface SessionWorker {
  readonly sessionId: SessionId;
  readonly activeRunId: string | undefined;
  readonly active: boolean;
  readonly wake: (modelRuntime: SessionModelRuntime) => Effect.Effect<WakeAcceptance>;
  readonly prompt: (payload: PromptSessionPayload) => Effect.Effect<PromptAcceptance>;
  readonly abort: (payload: AbortSessionPayload) => Effect.Effect<AbortAcceptance>;
  readonly updateGitFile: (
    payload: UpdateSessionGitFilePayload,
  ) => Effect.Effect<GitFileUpdateAcceptance>;
  readonly shutdown: Effect.Effect<void>;
}

export interface SessionWorkerFactory {
  readonly spawn: (
    input: SessionWorkerInput,
  ) => Effect.Effect<SessionWorker>;
}

export const SessionWorkerFactory: Context.Service<SessionWorkerFactory, SessionWorkerFactory> =
  Context.Service("@openorb/runner/SessionWorkerFactory");

type WorkerState =
  | { readonly _tag: "Provisioning"; readonly environment?: AgentEnvironment }
  | {
    readonly _tag: "Ready";
    readonly environment: AgentEnvironment;
    readonly agentSession?: AgentHarnessSession;
  }
  | {
    readonly _tag: "Running";
    readonly environment: AgentEnvironment;
    readonly agentSession: AgentHarnessSession;
    readonly runId: RunId;
    readonly run: ActiveAgentRun;
  }
  | {
    readonly _tag: "Aborting";
    readonly environment: AgentEnvironment;
    readonly agentSession: AgentHarnessSession;
    readonly runId: RunId;
    readonly run: ActiveAgentRun;
  }
  | { readonly _tag: "Failed"; readonly environment?: AgentEnvironment };

type WorkerCommand =
  | {
    readonly _tag: "Wake";
    readonly modelRuntime: SessionModelRuntime;
    readonly reply: Deferred.Deferred<WakeAcceptance>;
  }
  | {
    readonly _tag: "Prompt";
    readonly payload: PromptSessionPayload;
    readonly reply: Deferred.Deferred<PromptAcceptance>;
  }
  | {
    readonly _tag: "Abort";
    readonly payload: AbortSessionPayload;
    readonly reply: Deferred.Deferred<AbortAcceptance>;
  };

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
export function makeSessionWorkerFactory(): Effect.Effect<
  SessionWorkerFactory,
  never,
  RunnerSessionStore | SessionEvents | AgentEnvironmentProvider | AgentHarness | Scope.Scope
> {
  return Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const events = yield* SessionEvents;
    const environmentProvider = yield* AgentEnvironmentProvider;
    const harness = yield* AgentHarness;
    const scope = yield* Scope.Scope;
    return SessionWorkerFactory.of({
      spawn: Effect.fn("SessionWorkerFactory.spawn")((input: SessionWorkerInput) =>
        makeSessionWorker(input, store, events, environmentProvider, harness).pipe(
          Effect.provideService(Scope.Scope, scope),
        )
      ),
    });
  });
}

export const sessionWorkerFactoryLayer: Layer.Layer<
  SessionWorkerFactory,
  never,
  RunnerSessionStore | SessionEvents | AgentEnvironmentProvider | AgentHarness
> = Layer.effect(SessionWorkerFactory, makeSessionWorkerFactory());

function makeSessionWorker(
  input: SessionWorkerInput,
  store: RunnerSessionStore,
  events: SessionEvents,
  environmentProvider: AgentEnvironmentProvider,
  harness: AgentHarness,
): Effect.Effect<SessionWorker, never, Scope.Scope> {
  return Effect.gen(function* () {
    const sessionId = input.metadata.id;
    const commands = yield* Queue.unbounded<WorkerCommand>();
    const state = MutableRef.make<WorkerState>({ _tag: "Provisioning" });
    const environmentReady = yield* Deferred.make<AgentEnvironment, SessionWorkerError>();
    const gitOperations = yield* Semaphore.make(1);
    const gitSnapshots = makeGitSnapshotSynchronizer({
      sessionId,
      store,
      generate: generateSessionGitSnapshot,
      publishUpdated: (correlationId) =>
        events.publishLive(sessionId, correlationId, { type: "git.snapshot.updated" }),
    });
    const snapshotCoordinatorReady = yield* Deferred.make<GitSnapshotCoordinator<unknown>>();

    const transition = (next: WorkerState): Effect.Effect<void> =>
      Effect.sync(() => MutableRef.set(state, next));
    const refreshGitSnapshot = Effect.suspend(() => {
      const current = MutableRef.get(state);
      if (
        current._tag !== "Ready" && current._tag !== "Running" && current._tag !== "Aborting"
      ) return Effect.void;
      const correlationId = current._tag === "Ready" ? crypto.randomUUID() : current.runId;
      return gitOperations.withPermit(
        store.readMetadata(sessionId).pipe(
          Effect.flatMap((metadata) =>
            gitSnapshots.refresh(current.environment, metadata, correlationId)
          ),
          Effect.asVoid,
        ),
      );
    });

    function runActor(options: SessionWorkerInput): Effect.Effect<never, never, Scope.Scope> {
      return Effect.gen(function* () {
        const snapshotCoordinator = yield* makeGitSnapshotCoordinator(refreshGitSnapshot);
        yield* Deferred.succeed(snapshotCoordinatorReady, snapshotCoordinator);
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
        return yield* Queue.take(commands).pipe(
          Effect.flatMap(handle),
          Effect.forever,
        );
      });
    }

    function restore(
      options: SessionWorkerInput,
    ): Effect.Effect<void, SessionWorkerError, Scope.Scope> {
      return Effect.gen(function* () {
        const metadata = options.metadata;
        const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
          Effect.mapError(workerError),
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
        }).pipe(Effect.mapError(workerError));
        yield* Deferred.succeed(environmentReady, environment);
        if (metadata.checkoutState === "available") {
          yield* environment.runShell(
            "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
            { cwd: ".", onOutput: () => Effect.void },
          )
            .pipe(
              Effect.mapError(workerError),
              Effect.asVoid,
            );
        }
        yield* transition({ _tag: "Ready", environment });
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

    function handle(command: WorkerCommand): Effect.Effect<void, never, Scope.Scope> {
      switch (command._tag) {
        case "Wake":
          return handleWake(command.modelRuntime, command.reply);
        case "Prompt":
          return handlePrompt(command.payload, command.reply);
        case "Abort":
          return handleAbort(command.payload, command.reply);
      }
    }

    function handleWake(
      modelRuntime: SessionModelRuntime,
      reply: Deferred.Deferred<WakeAcceptance>,
    ): Effect.Effect<void, never, Scope.Scope> {
      const current = MutableRef.get(state);
      if (input.metadata.definition.model !== modelRuntime.model) {
        return Deferred.succeed(reply, {
          ok: false,
          message: "The session model cannot change during restoration.",
        }).pipe(Effect.asVoid);
      }
      if (current._tag === "Running" || current._tag === "Aborting") {
        return Deferred.succeed(reply, { ok: true }).pipe(Effect.asVoid);
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
      return openAgentSession(current.environment, modelRuntime).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Deferred.succeed(reply, {
              ok: false,
              message: "The agent session could not be restored.",
            }),
          onSuccess: (agentSession) =>
            transition({ _tag: "Ready", environment: current.environment, agentSession }).pipe(
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
              Deferred.succeed(reply, {
                ok: true,
                runId: current.runId,
                mode: "follow-up",
              }),
          }),
          Effect.asVoid,
        );
      }
      if (current._tag === "Aborting") {
        return Deferred.succeed(reply, { ok: false, message: "The session is aborting." }).pipe(
          Effect.asVoid,
        );
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
        Effect.forkChild,
        Effect.andThen(Deferred.await(reply)),
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

    const updateGitFile = Effect.fn("SessionWorker.updateGitFile")(function* (
      payload: UpdateSessionGitFilePayload,
    ) {
      const environment = yield* Deferred.await(environmentReady).pipe(
        Effect.catch(() => Effect.void),
      );
      if (environment === undefined) {
        return rejectGitFileUpdate(
          "Files cannot be staged or unstaged until the session environment is available.",
        );
      }

      return yield* gitOperations.withPermit(
        store.readMetadata(sessionId).pipe(
          Effect.flatMap((metadata) =>
            updateSessionGitFile(environment, metadata, payload).pipe(
              Effect.map((result) => ({ metadata, result })),
            )
          ),
          Effect.flatMap(
            ({ metadata, result }): Effect.Effect<GitFileUpdateAcceptance, unknown> => {
              const correlationId = crypto.randomUUID();
              return gitSnapshots.refresh(environment, metadata, correlationId).pipe(
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
        ),
      );
    });

    function provision(
      initialMetadata: RunnerSessionMetadata,
      githubToken: string | undefined,
      modelRuntime: SessionModelRuntime,
      correlationId: string,
    ): Effect.Effect<void, SessionWorkerError, Scope.Scope> {
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
        metadata = yield* store.updateProvisioning(sessionId, {
          state: "provisioning",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        }).pipe(Effect.mapError(workerError));
        yield* emitState(metadata, "starting-vm", correlationId);
        const workspacePath = yield* store.getSessionWorkspacePath(sessionId).pipe(
          Effect.mapError(workerError),
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
        }).pipe(Effect.mapError(workerError));
        yield* transition({ _tag: "Provisioning", environment });
        yield* Deferred.succeed(environmentReady, environment);

        if (metadata.checkoutState === "pending") {
          yield* Effect.tryPromise({
            try: () => clearWorkspace(workspacePath),
            catch: (cause) => new SessionWorkerError("Could not clear the workspace.", cause),
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
            metadata = yield* store.updateProvisioning(sessionId, {
              state: "provisioning",
              checkoutState: "unavailable",
            }).pipe(Effect.mapError(workerError));
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
              return yield* new SessionWorkerError(
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
              return yield* new SessionWorkerError(
                "Git could not create the session branch.",
                undefined,
              );
            }
            metadata = yield* store.updateProvisioning(sessionId, {
              state: "provisioning",
              checkoutState: "available",
              baseCommit: revision.stdout.trim(),
            }).pipe(Effect.mapError(workerError));
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

        const agentSession = yield* openAgentSession(environment, modelRuntime);
        // SAFETY: Provisioning correlation identifiers are generated UUIDs.
        yield* runAgentPrompt(
          metadata,
          environment,
          agentSession,
          correlationId as RunId,
          metadata.definition.initialPrompt,
        );
        yield* transition({ _tag: "Ready", environment, agentSession });
        metadata = yield* store.updateProvisioning(sessionId, {
          state: "ready",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        }).pipe(Effect.mapError(workerError));
        yield* emitState(metadata, "ready", correlationId);
      });
      return operation.pipe(
        Effect.catch((error) => failProvision(metadata, correlationId, logBudget, error)),
      );
    }

    function failProvision(
      metadata: RunnerSessionMetadata,
      correlationId: string,
      logBudget: ProvisioningLogBudget,
      error: SessionWorkerError,
    ): Effect.Effect<never, SessionWorkerError> {
      const current = MutableRef.get(state);
      return Deferred.fail(environmentReady, error).pipe(
        Effect.andThen(transition({
          _tag: "Failed",
          ...(current._tag === "Provisioning" && current.environment
            ? { environment: current.environment }
            : {}),
        })),
        Effect.andThen(store.readMetadata(sessionId)),
        Effect.orElseSucceed(() => metadata),
        Effect.flatMap((current) =>
          store.updateProvisioning(sessionId, {
            state: "error",
            checkoutState: current.checkoutState,
            ...(current.baseCommit === undefined ? {} : { baseCommit: current.baseCommit }),
          }).pipe(Effect.orElseSucceed(() => current))
        ),
        Effect.tap((failed) =>
          Effect.all([
            emitLog(
              correlationId,
              "stderr",
              `Provisioning failed: ${redactedErrorMessage(error, logBudget.secrets)}\n`,
            ).pipe(Effect.ignore),
            emitState(failed, "failed", correlationId).pipe(Effect.ignore),
          ], { concurrency: "unbounded", discard: true })
        ),
        Effect.andThen(Effect.fail(error)),
      );
    }

    function continuePrompt(
      payload: PromptSessionPayload,
      runId: RunId,
      environment: AgentEnvironment,
      agentSession: AgentHarnessSession | undefined,
      reply: Deferred.Deferred<PromptAcceptance>,
    ): Effect.Effect<void, SessionWorkerError, Scope.Scope> {
      return Effect.gen(function* () {
        const metadata = yield* store.readMetadata(sessionId).pipe(
          Effect.mapError(workerError),
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
        const accepted = yield* Deferred.make<boolean>();
        const promptFiber = yield* runAgentPrompt(
          metadata,
          environment,
          activeAgentSession,
          runId,
          payload.prompt,
          accepted,
        ).pipe(Effect.forkChild);
        const acceptedByHarness = yield* Effect.race(
          Deferred.await(accepted),
          Fiber.await(promptFiber).pipe(Effect.as(false)),
        );
        if (!acceptedByHarness) {
          yield* Fiber.await(promptFiber);
          const restored = yield* restoreReady(
            metadata,
            environment,
            activeAgentSession,
            runId,
          ).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          yield* Deferred.succeed(reply, {
            ok: false,
            message: restored
              ? "The agent harness did not accept the prompt."
              : "The session could not recover after rejecting the prompt.",
          });
          return;
        }
        yield* Deferred.succeed(reply, { ok: true, runId, mode: "started" });
        yield* Fiber.join(promptFiber).pipe(
          Effect.matchEffect({
            onFailure: (promptError) =>
              restoreReady(metadata, environment, activeAgentSession, runId).pipe(
                Effect.andThen(Effect.fail(promptError)),
              ),
            onSuccess: () => restoreReady(metadata, environment, activeAgentSession, runId),
          }),
        );
      });
    }

    function runAgentPrompt(
      metadata: RunnerSessionMetadata,
      environment: AgentEnvironment,
      agentSession: AgentHarnessSession,
      runId: RunId,
      prompt: string,
      acceptance?: Deferred.Deferred<boolean>,
    ): Effect.Effect<void, SessionWorkerError> {
      return Effect.scoped(
        Effect.gen(function* () {
          const run = yield* agentSession.start(prompt).pipe(Effect.mapError(workerError));
          yield* store.updateProvisioning(sessionId, {
            state: "running",
            checkoutState: metadata.checkoutState,
            ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
          }).pipe(
            Effect.mapError(workerError),
            Effect.flatMap((running) => emitState(running, "running", runId)),
            Effect.catch((error) =>
              run.abort.pipe(
                Effect.ignore,
                Effect.andThen(Effect.fail(error)),
              )
            ),
          );
          yield* transition({ _tag: "Running", environment, agentSession, runId, run });
          if (acceptance) yield* Deferred.succeed(acceptance, true);
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
            Effect.mapError(workerError),
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
        }).pipe(
          Effect.ensuring(
            acceptance ? Deferred.succeed(acceptance, false) : Effect.void,
          ),
        ),
      );
    }

    function openAgentSession(
      environment: AgentEnvironment,
      modelRuntime: SessionModelRuntime,
    ): Effect.Effect<AgentHarnessSession, SessionWorkerError, Scope.Scope> {
      return Effect.gen(function* () {
        const paths = yield* store.getSessionPiPaths(sessionId).pipe(
          Effect.mapError(workerError),
        );
        return yield* harness.open({
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
        }).pipe(Effect.mapError(workerError));
      });
    }

    function restoreReady(
      metadata: RunnerSessionMetadata,
      environment: AgentEnvironment,
      agentSession: AgentHarnessSession,
      runId: RunId,
    ): Effect.Effect<void, SessionWorkerError> {
      return transition({ _tag: "Ready", environment, agentSession }).pipe(
        Effect.andThen(store.updateProvisioning(sessionId, {
          state: "ready",
          checkoutState: metadata.checkoutState,
          ...(metadata.baseCommit === undefined ? {} : { baseCommit: metadata.baseCommit }),
        })),
        Effect.mapError(workerError),
        Effect.tap((ready) => emitState(ready, "ready", runId)),
        Effect.asVoid,
      );
    }

    function runCommand(
      environment: AgentEnvironment,
      command: string[],
      correlationId: string,
      logBudget: ProvisioningLogBudget,
      captureStdout = false,
    ): Effect.Effect<CommandOutput, SessionWorkerError> {
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
        }).pipe(Effect.mapError(workerError));
        return { exitCode: result.exitCode, stdout };
      });
    }

    function emitBoundedOutput(
      correlationId: string,
      stream: "stdout" | "stderr",
      rawText: string,
      budget: ProvisioningLogBudget,
    ): Effect.Effect<void, SessionWorkerError> {
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
    ): Effect.Effect<void, SessionWorkerError> {
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
    ): Effect.Effect<void, SessionWorkerError> {
      return publish(events.publishLive(
        sessionId,
        correlationId,
        { type: "provisioning.log", stream, text },
      ));
    }

    function publish(
      publication: Effect.Effect<void, unknown>,
    ): Effect.Effect<void, SessionWorkerError> {
      return publication.pipe(
        Effect.mapError((cause) =>
          new SessionWorkerError("Session event publication failed.", cause)
        ),
      );
    }

    const wake = Effect.fn("SessionWorker.wake")(function* (
      modelRuntime: SessionModelRuntime,
    ) {
      const reply = yield* Deferred.make<WakeAcceptance>();
      yield* Queue.offer(commands, { _tag: "Wake", modelRuntime, reply });
      return yield* Deferred.await(reply);
    });
    const prompt = Effect.fn("SessionWorker.prompt")(function* (
      payload: PromptSessionPayload,
    ) {
      const reply = yield* Deferred.make<PromptAcceptance>();
      yield* Queue.offer(commands, { _tag: "Prompt", payload, reply });
      return yield* Deferred.await(reply);
    });
    const abort = Effect.fn("SessionWorker.abort")(function* (
      payload: AbortSessionPayload,
    ) {
      const reply = yield* Deferred.make<AbortAcceptance>();
      yield* Queue.offer(commands, { _tag: "Abort", payload, reply });
      return yield* Deferred.await(reply);
    });
    const actor = yield* Effect.scoped(
      Effect.suspend(() => runActor(input)).pipe(
        Effect.ensuring(Queue.shutdown(commands)),
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
        return current._tag !== "Failed" || current.environment !== undefined;
      },
      wake,
      prompt,
      abort,
      updateGitFile,
      shutdown: Fiber.interrupt(actor).pipe(Effect.asVoid),
    } satisfies SessionWorker;
  });
}

export class SessionWorkerError extends Data.TaggedError("SessionWorkerError")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  constructor(message: string, cause: unknown) {
    super({ message, cause });
  }
}

function workerError(cause: unknown): SessionWorkerError {
  return cause instanceof SessionWorkerError
    ? cause
    : new SessionWorkerError("The session worker operation failed.", cause);
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
