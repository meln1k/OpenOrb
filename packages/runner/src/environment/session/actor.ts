import {
  type ControlEnvironmentPayload,
  EnvironmentControlled,
  EnvironmentRejected,
  type EnvironmentState,
  type RunnerEnvironmentSnapshot,
  type SessionEnvironmentSecret,
  type SessionId,
} from "@openorb/protocol/runner-api";
import { orbSizeResources } from "@openorb/protocol";
import { Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect";

import { AgentEnvironmentError, AgentEnvironmentProvider } from "../agent-environment.ts";
import { makeEnvironmentLifecycle } from "../../session/actor/environment.ts";
import { dialEnvironmentLink } from "../link/dial.ts";
import { relayEnvironmentDaemon } from "../link/relay.ts";
import {
  type EnvironmentEvent,
  type EnvironmentRecord,
  environmentSnapshot,
  EnvironmentStore,
  type ReplayedEnvironment,
} from "./store.ts";

export interface EnvironmentLinkOptions {
  readonly gatewayUrl: string;
  readonly runnerToken: string;
}

/** One Session's Agent Environment on this runner: compute and links, no agent or project work. */
export interface EnvironmentActor {
  readonly sessionId: SessionId;
  /** Whether a VM instance exists; counts against runner capacity. */
  readonly active: boolean;
  readonly snapshot: () => RunnerEnvironmentSnapshot;
  readonly control: (
    payload: ControlEnvironmentPayload,
  ) => Effect.Effect<EnvironmentControlled, EnvironmentRejected>;
  /** Resolves once the gateway accepted the link; the relay then runs until either side ends. */
  readonly attach: (nonce: string) => Effect.Effect<void, EnvironmentRejected>;
  /** Stops compute so the storage can be removed. */
  readonly stopForDeletion: Effect.Effect<void, EnvironmentRejected>;
  readonly shutdown: Effect.Effect<void>;
}

export const makeEnvironmentActor = Effect.fn("makeEnvironmentActor")(function* (
  replayed: ReplayedEnvironment,
  link: EnvironmentLinkOptions,
  onChange: (snapshot: RunnerEnvironmentSnapshot) => Effect.Effect<void>,
) {
  const store = yield* EnvironmentStore;
  const provider = yield* AgentEnvironmentProvider;
  const owner = yield* Scope.make();
  const persistence = yield* Semaphore.make(1);
  const commands = yield* Semaphore.make(1);
  const sessionId = replayed.record.definition.sessionId;
  let record: EnvironmentRecord = replayed.record;
  let sequence = replayed.sequence;
  let githubToken: string | undefined;
  let environmentSecrets: readonly SessionEnvironmentSecret[] | undefined;
  const links = new Set<Fiber.Fiber<unknown, unknown>>();
  const rejected = (message: string) => new EnvironmentRejected({ sessionId, message });

  const persist = (event: EnvironmentEvent) =>
    persistence.withPermit(
      store.append(sessionId, sequence, event).pipe(
        Effect.map((next) => {
          sequence = next;
          record = event.type === "disk.initialized"
            ? { ...record, diskInitialized: true }
            : event.type === "environment.changed"
            ? { ...record, state: event.state }
            : event.type === "stop.completed"
            ? { ...record, state: "stopped" }
            : record;
        }),
        Effect.uninterruptible,
      ),
    ).pipe(Effect.andThen(Effect.suspend(() => onChange(environmentSnapshot(record)))));

  const lifecycle = yield* makeEnvironmentLifecycle({
    boot: (acquired) =>
      Effect.gen(function* () {
        const rootDiskPath = yield* store.rootDiskPath(sessionId);
        if (!record.diskInitialized) {
          yield* provider.initializeRootDisk(rootDiskPath);
          yield* persist({ type: "disk.initialized" });
        }
        const resources = orbSizeResources(record.definition.orbSize);
        const environment = yield* provider.make({
          rootDiskPath,
          sessionLabel: `openorb session ${sessionId}`,
          sessionId,
          github: {
            repositoryUrl: record.definition.repositoryUrl,
            gitAuthor: record.definition.gitAuthor,
            ...(githubToken === undefined ? {} : { token: githubToken }),
          },
          ...(environmentSecrets === undefined ? {} : { environmentSecrets }),
          cpuCount: resources.cpuCount,
          memoryMiB: resources.memoryMiB,
        });
        yield* acquired(environment);
        // Gondolin boots lazily; readiness means a guest that runs commands.
        const probe = yield* environment.run(["/bin/true"]);
        if (probe.exitCode !== 0) {
          return yield* new AgentEnvironmentError("The guest did not answer.", undefined);
        }
        return environment;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof AgentEnvironmentError
            ? cause
            : new AgentEnvironmentError("The guest environment could not be started.", cause)
        ),
      ),
    changed: (state: EnvironmentState, forced?: boolean) =>
      persist(
        state === "stopped" && !forced
          ? { type: "stop.completed" }
          : { type: "environment.changed", state },
      ).pipe(
        Effect.mapError((cause) =>
          new AgentEnvironmentError("Environment state could not be recorded.", cause)
        ),
      ),
    snapshot: () => Effect.void,
    syncDisk: store.syncRootDisk(sessionId),
    warning: (message) =>
      Effect.logWarning("environment.warning").pipe(
        Effect.annotateLogs({ component: "openorb-runner", sessionId, message }),
      ),
  }).pipe(Effect.provideService(Scope.Scope, owner));

  const closeLinks = Effect.suspend(() =>
    Effect.forEach([...links], (fiber) => Fiber.interrupt(fiber), { discard: true })
  );

  const control = (payload: ControlEnvironmentPayload) =>
    commands.withPermit(Effect.gen(function* () {
      if (payload.action !== "stop") {
        // Credentials apply to the VM this action starts; a running VM keeps its own.
        githubToken = payload.githubToken;
        environmentSecrets = payload.environmentSecrets;
      }
      if (payload.action === "start" && record.state === "error") {
        if (payload.recovery !== "restart-environment") {
          return yield* rejected(
            "The environment was interrupted; restart it to recover the root disk.",
          );
        }
        // No VM can still own the disk after a runner restart; only a live instance needs stopping.
        if (lifecycle.active) yield* lifecycle.forceStop.pipe(Effect.ignore);
      }
      if (payload.action !== "start") yield* closeLinks;
      const result = yield* lifecycle.control(payload.action).pipe(
        Effect.mapError((error) => rejected(error.message)),
      );
      return new EnvironmentControlled({ state: result.state, forced: result.forced });
    }));

  const attach = (nonce: string) =>
    Effect.gen(function* () {
      if (record.state !== "running" && record.state !== "starting") {
        return yield* rejected(
          record.state === "error"
            ? "The environment failed; restart it to recover."
            : "The environment is stopped. Start it with the environment tool.",
        );
      }
      const attached = yield* Deferred.make<void>();
      let failureMessage: string | undefined;
      const fiber = yield* Effect.scoped(Effect.gen(function* () {
        const daemon = yield* lifecycle.proxy.startDaemon;
        yield* Effect.addFinalizer(() => daemon.close);
        const end = yield* dialEnvironmentLink({
          gatewayUrl: link.gatewayUrl,
          sessionId,
          runnerToken: link.runnerToken,
          nonce,
        });
        yield* Deferred.succeed(attached, undefined);
        const reason = yield* relayEnvironmentDaemon(daemon, end);
        yield* Effect.logInfo("environment.link-closed").pipe(
          Effect.annotateLogs({ component: "openorb-runner", sessionId, reason }),
        );
      })).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failureMessage = error.message;
          })
        ),
        Effect.ensuring(Deferred.succeed(attached, undefined)),
        Effect.forkIn(owner),
      );
      links.add(fiber);
      fiber.addObserver(() => links.delete(fiber));
      yield* Deferred.await(attached);
      if (failureMessage !== undefined) {
        return yield* rejected(`The Environment Link could not be attached: ${failureMessage}`);
      }
    });

  const stopForDeletion = commands.withPermit(
    closeLinks.pipe(
      Effect.andThen(lifecycle.forceStop),
      Effect.asVoid,
      Effect.mapError((error) => rejected(error.message)),
    ),
  );

  const shutdown = commands.withPermit(
    closeLinks.pipe(
      Effect.andThen(lifecycle.stop.pipe(Effect.timeout("30 seconds"))),
      Effect.catch(() => lifecycle.forceStop.pipe(Effect.timeout("20 seconds"), Effect.ignore)),
      Effect.ensuring(Scope.close(owner, Exit.void)),
      Effect.ignore,
    ),
  );

  // A runner interruption leaves no VM, so a recorded running or stopping state is unprovable.
  if (record.state !== "stopped" && record.state !== "error") {
    yield* persist({ type: "environment.changed", state: "error" }).pipe(Effect.ignore);
  }

  return {
    sessionId,
    get active() {
      return lifecycle.active;
    },
    snapshot: () => environmentSnapshot(record),
    control,
    attach,
    stopForDeletion,
    shutdown,
  } satisfies EnvironmentActor;
});
