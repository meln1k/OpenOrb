import {
  type ControlEnvironmentPayload,
  EnvironmentControlled,
  EnvironmentRejected,
  type EnvironmentState,
  RunnerEnvironmentSnapshot,
  type SessionEnvironmentSecret,
} from "@openorb/protocol/runner-api";
import { orbSizeResources } from "@openorb/protocol";
import { Duration, Effect, Exit, Fiber, Scope, Semaphore } from "effect";

import {
  type AgentEnvironment,
  AgentEnvironmentError,
  AgentEnvironmentProvider,
} from "../agent-environment.ts";
import { makeEnvironmentLifecycle } from "./lifecycle.ts";
import { dialEnvironmentLink } from "../link/dial.ts";
import { relayEnvironmentDaemon } from "../link/relay.ts";
import { type EnvironmentDefinition, EnvironmentStore } from "./store.ts";

/** A dropped link is redialed after this, doubling per failed attempt up to the maximum. */
const LINK_RETRY = Duration.seconds(1);
const LINK_RETRY_MAX = Duration.seconds(30);

export interface EnvironmentLinkOptions {
  readonly gatewayUrl: string;
  readonly runnerToken: string;
}

/** One Session's Agent Environment on this runner: compute and links, no agent or project work. */
export interface EnvironmentActor {
  readonly definition: EnvironmentDefinition;
  /** Whether a VM instance exists; counts against runner capacity. */
  readonly active: boolean;
  readonly snapshot: () => RunnerEnvironmentSnapshot;
  readonly control: (
    payload: ControlEnvironmentPayload,
  ) => Effect.Effect<EnvironmentControlled, EnvironmentRejected>;
  /** Stops compute so the storage can be removed. */
  readonly stopForDeletion: Effect.Effect<void, EnvironmentRejected>;
  readonly shutdown: Effect.Effect<void>;
}

export const makeEnvironmentActor = Effect.fn("makeEnvironmentActor")(function* (
  definition: EnvironmentDefinition,
  link: EnvironmentLinkOptions,
  onChange: (snapshot: RunnerEnvironmentSnapshot) => Effect.Effect<void>,
) {
  const store = yield* EnvironmentStore;
  const provider = yield* AgentEnvironmentProvider;
  const owner = yield* Scope.make();
  const commands = yield* Semaphore.make(1);
  const sessionId = definition.sessionId;
  let githubToken: string | undefined;
  let environmentSecrets: readonly SessionEnvironmentSecret[] | undefined;
  let state: EnvironmentState = "stopped";
  let linking: Fiber.Fiber<never> | undefined;
  const rejected = (message: string) => new EnvironmentRejected({ sessionId, message });
  const log = (message: string, annotations: Readonly<Record<string, string>> = {}) =>
    Effect.logInfo(message).pipe(
      Effect.annotateLogs({ component: "openorb-runner", sessionId, ...annotations }),
    );

  /** One Environment Link with its own daemon; true once the gateway accepted it. */
  const dialOnce = (environment: AgentEnvironment) => {
    let attached = false;
    return Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* environment.startDaemon;
        yield* Effect.addFinalizer(() => daemon.close);
        const end = yield* dialEnvironmentLink({
          gatewayUrl: link.gatewayUrl,
          sessionId,
          runnerToken: link.runnerToken,
        });
        attached = true;
        const reason = yield* relayEnvironmentDaemon(daemon, end);
        yield* log("environment.link-closed", { reason });
      }),
    ).pipe(
      Effect.catch((error) => log("environment.link-failed", { reason: error.message })),
      Effect.map(() => attached),
    );
  };

  // The runner keeps the Session's link up whenever compute runs, so a Session never asks for it.
  const keepLinked = (environment: AgentEnvironment) =>
    Effect.gen(function* () {
      let delay = LINK_RETRY;
      while (true) {
        delay = (yield* dialOnce(environment))
          ? LINK_RETRY
          : Duration.min(Duration.times(delay, 2), LINK_RETRY_MAX);
        yield* Effect.sleep(delay);
      }
    });

  const linked = (environment: AgentEnvironment | undefined): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (environment !== undefined) {
        linking ??= yield* keepLinked(environment).pipe(Effect.forkIn(owner));
        return;
      }
      const current = linking;
      linking = undefined;
      if (current !== undefined) yield* Fiber.interrupt(current);
    });

  const lifecycle = yield* makeEnvironmentLifecycle({
    boot: (acquired) =>
      Effect.gen(function* () {
        const rootDiskPath = yield* store.rootDiskPath(sessionId);
        // Idempotent: it publishes the disk atomically and keeps an existing one.
        yield* provider.initializeRootDisk(rootDiskPath);
        const resources = orbSizeResources(definition.orbSize);
        const environment = yield* provider.make({
          rootDiskPath,
          sessionLabel: `openorb session ${sessionId}`,
          sessionId,
          ...(definition.repository === undefined
            ? {}
            : {
                github: {
                  repositoryUrl: definition.repository.url,
                  gitAuthor: definition.repository.gitAuthor,
                  ...(githubToken === undefined ? {} : { token: githubToken }),
                },
              }),
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
            : new AgentEnvironmentError("The guest environment could not be started.", cause),
        ),
      ),
    changed: (next, running) =>
      Effect.suspend(() => {
        state = next;
        return linked(running).pipe(Effect.andThen(onChange(snapshot())));
      }),
    syncDisk: store.syncRootDisk(sessionId),
    warning: (message) =>
      Effect.logWarning("environment.warning").pipe(
        Effect.annotateLogs({ component: "openorb-runner", sessionId, message }),
      ),
  }).pipe(Effect.provideService(Scope.Scope, owner));

  const snapshot = () => new RunnerEnvironmentSnapshot({ sessionId, state });

  const control = (payload: ControlEnvironmentPayload) =>
    commands.withPermit(
      Effect.gen(function* () {
        if (payload.action !== "stop") {
          // Credentials apply to the VM this action starts; a running VM keeps its own.
          githubToken = payload.githubToken;
          environmentSecrets = payload.environmentSecrets;
        }
        const result = yield* lifecycle
          .control(payload.action)
          .pipe(Effect.mapError((error) => rejected(error.message)));
        return new EnvironmentControlled({ state: result.state, forced: result.forced });
      }),
    );

  const stopForDeletion = commands.withPermit(
    lifecycle.forceStop.pipe(
      Effect.asVoid,
      Effect.mapError((error) => rejected(error.message)),
    ),
  );

  const shutdown = commands.withPermit(
    lifecycle.stop.pipe(
      Effect.timeout("30 seconds"),
      Effect.catch(() => lifecycle.forceStop.pipe(Effect.timeout("20 seconds"), Effect.ignore)),
      Effect.ensuring(Scope.close(owner, Exit.void)),
      Effect.ignore,
    ),
  );

  return {
    definition,
    get active() {
      return lifecycle.active;
    },
    snapshot,
    control,
    stopForDeletion,
    shutdown,
  } satisfies EnvironmentActor;
});
