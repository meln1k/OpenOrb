import { Clock, Deferred, Effect, Exit, Fiber, Scope, Semaphore, Stream } from "effect";
import type {
  AgentState,
  SessionEnvironmentSecret,
  SessionModelRuntime,
  SessionProvisioningStage,
} from "@openorb/protocol/runner-api";
import {
  type AgentEnvironment,
  AgentEnvironmentError,
  AgentEnvironmentProvider,
} from "../../environment/agent-environment.ts";
import { AgentHarness, type AgentHarnessSession } from "../../harness/agent-harness.ts";
import { SessionEvents } from "../events.ts";
import { Journal } from "../persistent-actor/journal.ts";
import { RunnerSessionStore } from "../store.ts";
import { generateSessionGitSnapshotBundle, updateSessionGitFile } from "../git-snapshot.ts";
import { makeGitSnapshotSynchronizer } from "../git-snapshot-synchronizer.ts";
import { actorError, SessionActorError } from "./actor-error.ts";
import { conversationActivity } from "./activity.ts";
import type { SessionActorInput } from "./commands.ts";
import { withDeadline } from "./deadline.ts";
import { makeEnvironmentLifecycle } from "./environment.ts";
import type { SessionEvent } from "./events.ts";
import type { SessionActor } from "./index.ts";
import { makeSessionIssue } from "./issues.ts";
import { makeSessionProvisioner } from "./provisioner.ts";
import { makeSessionReporter } from "./reporter.ts";
import {
  applySessionEvent,
  publicSessionState,
  replaySessionState,
  sessionEventCodec,
} from "./state.ts";

export type SessionActorDependencies =
  | AgentEnvironmentProvider
  | AgentHarness
  | Journal
  | RunnerSessionStore
  | Scope.Scope
  | SessionEvents;

export const makeSessionActor = Effect.fn("makeSessionActor")(function* (
  input: SessionActorInput,
): Effect.fn.Return<SessionActor, SessionActorError, SessionActorDependencies> {
  const store = yield* RunnerSessionStore;
  const journal = yield* Journal;
  const harness = yield* AgentHarness;
  const events = yield* SessionEvents;
  const provider = yield* AgentEnvironmentProvider;
  const id = input.metadata.id;
  const reporter = yield* makeSessionReporter(id);
  const owner = yield* Scope.make();
  const terminated = yield* Deferred.make<Exit.Exit<void>>();
  const admission = yield* Semaphore.make(1);
  const persistence = yield* Semaphore.make(1);
  const gitLock = yield* Semaphore.make(1);
  const recovered = yield* replaySessionState(id).pipe(
    Effect.mapError(actorError),
  );
  let state = recovered.state;
  let sequence = recovered.sequence;
  if (
    (input.mode === "create") !== (state === undefined) ||
    (state && (state.metadata.id !== id || state.metadata.runnerId !== input.metadata.runnerId))
  ) {
    return yield* new SessionActorError(
      "The recovered session does not match this actor.",
      undefined,
    );
  }
  let session: AgentHarnessSession | undefined;
  let conversationScope: Scope.Closeable | undefined;
  let conversationClosing: Fiber.Fiber<void> | undefined;
  let opening: Fiber.Fiber<void> | undefined;
  let closed = false;
  let deleted = false;
  let stopping = false;
  let agentState: AgentState = "paused";
  let idleSince = yield* Clock.currentTimeMillis;
  let githubToken: string | undefined;
  let environmentSecrets: readonly SessionEnvironmentSecret[] | undefined;
  let modelRuntime: SessionModelRuntime | undefined;

  const metadata = () => {
    const current = state!.metadata;
    return {
      ...current,
      agentState,
      state: publicSessionState(agentState, current.environmentState),
    };
  };
  const provisioner = yield* makeSessionProvisioner(id, {
    ...reporter,
    emitState: (_metadata, stage) => reporter.emitState(metadata(), stage),
  });
  const emit = () =>
    Effect.suspend(() => {
      const current = metadata();
      const stages = {
        starting: "starting-vm",
        running: agentState === "running" ? "running" : "ready",
        stopping: "stopping",
        stopped: "stopped",
        error: "failed",
      } satisfies Record<typeof current.environmentState, SessionProvisioningStage>;
      return reporter.emitState(current, stages[current.environmentState]);
    });
  const persist = (event: SessionEvent) =>
    persistence.withPermit(
      Effect.gen(function* () {
        const appended = yield* journal.append(id, sequence, event, sessionEventCodec).pipe(
          Effect.mapError(actorError),
        );
        sequence = appended.sequence;
        state = applySessionEvent(state, event);
      }).pipe(Effect.uninterruptible),
    ).pipe(Effect.andThen(emit()));
  const issue = (message: string, failure = false) =>
    persist({
      type: "issue.recorded",
      issue: makeSessionIssue({
        category: failure ? "vm-start" : "vm-stop",
        severity: failure ? "failure" : "warning",
        message,
        recovery: failure ? "restart-environment" : "none",
      }),
    });
  if (!state) {
    yield* persist({
      type: "session.provisioning-started",
      id,
      definition: input.metadata.definition,
      runnerId: input.metadata.runnerId,
      createdAt: input.metadata.createdAt,
    });
  }

  const snapshots = makeGitSnapshotSynchronizer({
    sessionId: id,
    store,
    generate: generateSessionGitSnapshotBundle,
    publishUpdated: () => reporter.publish({ type: "git.snapshot.updated" }),
  });
  const snapshot = (environment: AgentEnvironment) =>
    gitLock.withPermit(
      snapshots.refresh(environment, metadata()).pipe(
        Effect.andThen(snapshots.publishPending()),
      ),
    ).pipe(Effect.asVoid);

  const environment = yield* makeEnvironmentLifecycle({
    boot: (acquired) =>
      Effect.gen(function* () {
        if (state!.metadata.checkoutState !== "pending") {
          const restored = yield* provisioner.restore(
            metadata(),
            githubToken,
            environmentSecrets,
            acquired,
          );
          for (const value of restored.issues) {
            yield* persist({ type: "issue.recorded", issue: value });
          }
          return restored.environment;
        }
        if (!modelRuntime) {
          return yield* new SessionActorError("Model configuration is unavailable.", undefined);
        }
        const ready = yield* Deferred.make<AgentEnvironment, SessionActorError>();
        yield* provisioner.provision(
          metadata(),
          githubToken,
          environmentSecrets,
          modelRuntime,
          {
            initializeDisk: (path) =>
              Effect.gen(function* () {
                if (state!.diskInitialized) return;
                // Only explicit provisioning can initialize a disk. Restore never creates a replacement.
                if (input.mode !== "create" && input.mode !== "retry") {
                  return yield* new SessionActorError(
                    "The persistent disk was not initialized; retry provisioning explicitly.",
                    undefined,
                  );
                }
                yield* provider.initializeRootDisk(path).pipe(Effect.mapError(actorError));
                yield* persist({ type: "disk.initialized" });
              }),
            environmentStarted: acquired,
            update: (update) =>
              persist({ type: "checkout.updated", ...update }).pipe(Effect.map(metadata)),
            prepared: (result) =>
              Effect.gen(function* () {
                for (const value of result.issues) {
                  yield* persist({ type: "issue.recorded", issue: value }).pipe(Effect.ignore);
                }
                yield* Deferred.succeed(ready, result.environment);
              }),
            failed: (result) =>
              persist({ type: "issue.recorded", issue: result.issue }).pipe(
                Effect.ignore,
                Effect.andThen(Deferred.fail(ready, result.error)),
              ),
          },
        );
        return yield* Deferred.await(ready);
      }).pipe(Effect.mapError(() =>
        new AgentEnvironmentError("The guest environment could not be prepared.", undefined)
      )),
    changed: (next, forced) =>
      persist(
        next === "stopped" && !forced
          ? { type: "stop.completed" }
          : { type: "environment.changed", state: next },
      ).pipe(
        Effect.mapError(() =>
          new AgentEnvironmentError("Environment state could not be saved.", undefined)
        ),
      ),
    snapshot,
    syncDisk: store.syncSessionRootDisk(id),
    warning: (message) => issue(message).pipe(Effect.ignore),
  }).pipe(Effect.provideService(Scope.Scope, owner));

  let snapshotScheduled = false;
  let observedEntries = 0;
  const requestSnapshot = Effect.suspend(() => {
    if (snapshotScheduled || environment.state !== "running" || stopping) return Effect.void;
    snapshotScheduled = true;
    return snapshot(environment.proxy).pipe(
      Effect.timeout(5_000),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => {
        snapshotScheduled = false;
      })),
      Effect.forkIn(owner),
      Effect.asVoid,
    );
  });
  const refreshActivity = () =>
    Effect.gen(function* () {
      if (!session || stopping) return;
      if (observedEntries !== session.view.entries.length) {
        observedEntries = session.view.entries.length;
        yield* requestSnapshot;
      }
      const next: AgentState = conversationActivity(session.view).busy ? "running" : "idle";
      if (next === "running") idleSince = yield* Clock.currentTimeMillis;
      if (next !== agentState) {
        agentState = next;
        if (next === "idle") {
          idleSince = yield* Clock.currentTimeMillis;
          yield* requestSnapshot;
        }
        yield* emit();
      }
    });
  const open = (runtime: SessionModelRuntime) =>
    Effect.gen(function* () {
      if (session) {
        yield* session.updateModelRuntime(runtime).pipe(Effect.mapError(actorError));
        return session;
      }
      const scope = yield* Scope.make();
      conversationScope = scope;
      const directory = yield* store.getSessionHarnessDirectory(id).pipe(
        Effect.mapError(actorError),
      );
      const opened = yield* events.openConversation(
        id,
        harness.open({
          sessionId: id,
          environment: environment.proxy,
          get environmentState() {
            return environment.state;
          },
          environmentStates: environment.states,
          git: {
            repositoryUrl: metadata().definition.repositoryUrl,
            branchName: metadata().definition.branchName,
          },
          modelRuntime: runtime,
          state: { directory },
          controlEnvironment: (action) =>
            Effect.suspend(() =>
              stopping || closed || deleted
                ? Effect.fail(new AgentEnvironmentError("The session is stopping.", undefined))
                : environment.control(action)
            ),
        }).pipe(Effect.interruptible),
      ).pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(actorError));
      session = opened;
      yield* opened.views.pipe(
        Stream.runForEach(() => refreshActivity()),
        Effect.catch(() =>
          Effect.sync(() => {
            agentState = "error";
          }).pipe(Effect.andThen(emit()), Effect.ignore)
        ),
        Effect.forkIn(scope),
      );
      return opened;
    }).pipe(Effect.onError(() =>
      conversationScope
        ? withDeadline(Scope.close(conversationScope, Exit.void), 10_000).pipe(Effect.ignore)
        : Effect.void
    ));
  const prepare = (
    runtime: SessionModelRuntime,
    token?: string,
    secrets?: readonly SessionEnvironmentSecret[],
  ) =>
    Effect.gen(function* () {
      if (closed || deleted || stopping || conversationClosing) {
        return yield* new SessionActorError("The session is unavailable.", undefined);
      }
      modelRuntime = runtime;
      githubToken = token;
      environmentSecrets = secrets;
      if (!session) {
        yield* environment.begin.pipe(Effect.mapError(actorError));
      }
      return yield* open(runtime);
    });
  const closeConversation = Effect.gen(function* () {
    if (opening) yield* Fiber.interrupt(opening);
    if (conversationScope) {
      conversationClosing ??= yield* Scope.close(conversationScope, Exit.void).pipe(
        Effect.forkDetach,
      );
      yield* Fiber.join(conversationClosing);
    }
    session = undefined;
    conversationScope = undefined;
    conversationClosing = undefined;
    agentState = "paused";
  });
  const stop = (idle = false) =>
    Effect.gen(function* () {
      // Startup is not an admission barrier for Stop. Interrupt the opener before taking admission.
      if (!idle) {
        stopping = true;
        if (opening) {
          yield* withDeadline(Fiber.interrupt(opening), 10_000).pipe(Effect.mapError(actorError));
        }
      }
      yield* admission.withPermit(Effect.gen(function* () {
        if (
          idle && (!session || conversationActivity(session.view).busy ||
            (yield* Clock.currentTimeMillis) - idleSince < input.idleTimeoutMs)
        ) return;
        stopping = true;
        // Durable must enter recoverable close before tool cancellation can settle its work.
        yield* withDeadline(closeConversation, 10_000).pipe(
          Effect.onError(() => environment.cancelGuests),
          Effect.mapError(actorError),
        );
        yield* environment.stop.pipe(Effect.mapError(actorError));
        yield* emit();
      }));
    }).pipe(Effect.ensuring(Effect.sync(() => {
      stopping = false;
    })));
  const accept = <A, E>(operation: Effect.Effect<A, E>) =>
    withDeadline(operation, 30_000).pipe(
      Effect.catch(() =>
        Effect.succeed({
          ok: false as const,
          message: "The session operation failed; inspect its state before retrying.",
        })
      ),
    );
  const shutdown = Effect.gen(function* () {
    if (closed) return;
    closed = true;
    yield* withDeadline(stop(), 30_000).pipe(
      Effect.catch(() => withDeadline(environment.forceStop, 20_000).pipe(Effect.ignore)),
    );
    yield* withDeadline(Scope.close(owner, Exit.void), 10_000).pipe(Effect.ignore);
    yield* Deferred.succeed(terminated, Exit.void);
  });
  yield* Effect.addFinalizer(() => shutdown);

  if (input.mode === "create" || input.mode === "retry") {
    modelRuntime = input.modelRuntime;
    githubToken = input.githubToken;
    environmentSecrets = input.environmentSecrets;
    yield* environment.begin.pipe(Effect.mapError(actorError));
    opening = yield* admission.withPermit(
      open(input.modelRuntime).pipe(
        Effect.flatMap((opened) => opened.submit(metadata().definition.initialPrompt, id)),
        Effect.andThen(
          persist({
            type: "message.accepted",
            acceptedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          }),
        ),
        Effect.andThen(refreshActivity()),
        Effect.catch(() =>
          Effect.sync(() => {
            agentState = "error";
          }).pipe(Effect.andThen(emit()), Effect.ignore)
        ),
        Effect.asVoid,
      ),
    ).pipe(Effect.forkIn(owner));
  } else if (metadata().environmentState !== "stopped" && metadata().environmentState !== "error") {
    yield* issue(
      "The runner was interrupted. The persistent disk was preserved; explicitly wake the session to recover.",
      true,
    );
    yield* persist({ type: "environment.changed", state: "error" });
  }
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Math.min(15_000, input.idleTimeoutMs));
      yield* refreshActivity().pipe(Effect.ignore);
      if (environment.state !== "running") continue;
      if (
        session && !conversationActivity(session.view).busy &&
        (yield* Clock.currentTimeMillis) - idleSince >= input.idleTimeoutMs
      ) {
        yield* stop(true).pipe(Effect.ignore);
      } else yield* snapshot(environment.proxy).pipe(Effect.timeout(5_000), Effect.ignore);
    }
  }).pipe(Effect.forkIn(owner));

  return {
    sessionId: id,
    get active() {
      return environment.active;
    },
    get agentState() {
      return agentState;
    },
    get environmentState() {
      return metadata().environmentState;
    },
    wake: (payload) =>
      accept(admission.withPermit(Effect.gen(function* () {
        if (environment.state === "error") yield* environment.forceStop;
        const opened = yield* prepare(
          payload.modelRuntime,
          payload.githubToken,
          payload.environmentSecrets,
        );
        yield* environment.begin;
        yield* opened.resume;
        yield* refreshActivity();
        return { ok: true as const };
      }))),
    prompt: (payload) =>
      accept(admission.withPermit(Effect.gen(function* () {
        const opened = yield* prepare(
          payload.modelRuntime,
          payload.githubToken,
          payload.environmentSecrets,
        );
        if (payload.thinkingLevel) yield* opened.setThinkingLevel(payload.thinkingLevel);
        const submissionId = yield* opened.submit(payload.prompt, payload.clientRequestId);
        yield* persist({
          type: "message.accepted",
          acceptedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        });
        yield* refreshActivity();
        return { ok: true as const, submissionId };
      }))),
    setThinkingLevel: (payload) =>
      accept(admission.withPermit(Effect.gen(function* () {
        if (!session) return yield* new SessionActorError("Wake the session first.", undefined);
        const level = yield* session.setThinkingLevel(payload.level);
        return { ok: true as const, level };
      }))),
    abort: () =>
      accept(Effect.gen(function* () {
        if (!session || agentState !== "running") {
          return yield* new SessionActorError("The agent is not running.", undefined);
        }
        yield* session.abort;
        yield* refreshActivity();
        return { ok: true as const };
      })),
    stop: () => accept(stop().pipe(Effect.as({ ok: true as const }))),
    delete: () =>
      accept(
        stop().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              deleted = true;
            })
          ),
          Effect.as({ ok: true as const }),
        ),
      ),
    updateGitFile: (payload) =>
      accept(gitLock.withPermit(Effect.gen(function* () {
        if (environment.state !== "running") {
          return { ok: false as const, message: "The guest environment is not running." };
        }
        const result = yield* updateSessionGitFile(environment.proxy, metadata(), payload);
        if (!result.ok) {
          return result;
        }
        const mutationRevision = yield* store.advanceGitMutationRevision(id);
        yield* snapshots.refresh(environment.proxy, metadata());
        yield* snapshots.publishPending();
        return { ok: true as const, mutationRevision };
      }))),
    awaitTermination: Deferred.await(terminated),
    shutdown,
  } satisfies SessionActor;
});
