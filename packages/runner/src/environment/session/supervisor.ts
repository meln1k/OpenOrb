import { orbSizeResources } from "@openorb/protocol";
import type { Result } from "@openorb/result";
import {
  CapacityExceeded,
  type ControlEnvironmentPayload,
  type CreateEnvironmentPayload,
  DeleteFailed,
  type EnvironmentControlled,
  EnvironmentNotFound,
  EnvironmentRejected,
  type RunnerEnvironmentSnapshot,
  type RunnerId,
  SessionConflict,
  type SessionId,
} from "@openorb/protocol/runner-api";
import { Context, Effect, Layer, PubSub, type Scope, Semaphore, Stream } from "effect";

import { assertPersistentRootDiskDetached } from "../gondolin/persistent-root-disk.ts";
import type { AgentEnvironmentProvider } from "../agent-environment.ts";
import {
  type EnvironmentActor,
  type EnvironmentLinkOptions,
  makeEnvironmentActor,
} from "./actor.ts";
import { EnvironmentDefinition, EnvironmentStore, type ReplayedEnvironment } from "./store.ts";

export type EnvironmentChange =
  | { readonly type: "updated"; readonly environment: RunnerEnvironmentSnapshot }
  | { readonly type: "removed"; readonly sessionId: SessionId };

export interface EnvironmentSupervisorOptions extends EnvironmentLinkOptions {
  readonly runnerId: RunnerId;
  readonly cpuCount: number;
  readonly memoryMiB: number;
  /** Confirms no VM still owns a root disk before its storage is removed. */
  readonly assertDetached?: (rootDiskPath: string) => Promise<Result<void, unknown>>;
}

/** Owns every environment-only Session on this runner (ADR 0006). */
export interface EnvironmentSupervisor {
  readonly activeCount: () => number;
  readonly snapshots: () => readonly RunnerEnvironmentSnapshot[];
  /** Subscribe before reading `snapshots` so no change falls between them. */
  readonly changes: Effect.Effect<Stream.Stream<EnvironmentChange>, never, Scope.Scope>;
  readonly create: (
    payload: CreateEnvironmentPayload,
  ) => Effect.Effect<
    RunnerEnvironmentSnapshot,
    CapacityExceeded | SessionConflict | EnvironmentRejected
  >;
  readonly control: (
    payload: ControlEnvironmentPayload,
  ) => Effect.Effect<EnvironmentControlled, EnvironmentNotFound | EnvironmentRejected>;
  readonly attach: (
    sessionId: SessionId,
    nonce: string,
  ) => Effect.Effect<void, EnvironmentNotFound | EnvironmentRejected>;
  readonly delete: (
    sessionId: SessionId,
  ) => Effect.Effect<void, EnvironmentRejected | DeleteFailed>;
}

export const EnvironmentSupervisor: Context.Service<
  EnvironmentSupervisor,
  EnvironmentSupervisor
> = Context.Service("@openorb/runner/EnvironmentSupervisor");

export const makeEnvironmentSupervisor = Effect.fn("makeEnvironmentSupervisor")(function* (
  options: EnvironmentSupervisorOptions,
) {
  const store = yield* EnvironmentStore;
  const dependencies = yield* Effect.context<EnvironmentStore | AgentEnvironmentProvider>();
  const admission = yield* Semaphore.make(1);
  const published = yield* PubSub.unbounded<EnvironmentChange>();
  const actors = new Map<SessionId, EnvironmentActor>();
  const deleting = new Set<SessionId>();

  const spawn = (replayed: ReplayedEnvironment) =>
    makeEnvironmentActor(
      replayed,
      options,
      (environment) =>
        PubSub.publish(published, { type: "updated", environment }).pipe(Effect.asVoid),
    ).pipe(
      Effect.provide(dependencies),
      Effect.tap((actor) => Effect.sync(() => actors.set(actor.sessionId, actor))),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...actors.values()], (actor) => actor.shutdown, {
      concurrency: "unbounded",
      discard: true,
    })
  );

  // Every environment is restored eagerly: an actor holds no VM until it is started.
  for (const sessionId of yield* store.list.pipe(Effect.orDie)) {
    const replayed = yield* store.replay(sessionId).pipe(Effect.option);
    if (replayed._tag === "None" || replayed.value === undefined) {
      yield* Effect.logWarning("environment.restore-skipped").pipe(
        Effect.annotateLogs({ component: "openorb-runner", sessionId }),
      );
      continue;
    }
    if (replayed.value.record.definition.runnerId !== options.runnerId) continue;
    yield* spawn(replayed.value);
  }

  const find = (
    sessionId: SessionId,
  ): Effect.Effect<EnvironmentActor, EnvironmentNotFound> => {
    const actor = actors.get(sessionId);
    return actor === undefined || deleting.has(sessionId)
      ? Effect.fail(
        new EnvironmentNotFound({ sessionId, message: "The environment does not exist." }),
      )
      : Effect.succeed(actor);
  };

  const create = (payload: CreateEnvironmentPayload) =>
    admission.withPermit(Effect.gen(function* () {
      const sessionId = payload.sessionId;
      const resources = orbSizeResources(payload.orbSize);
      if (resources.cpuCount > options.cpuCount || resources.memoryMiB > options.memoryMiB) {
        return yield* new CapacityExceeded({
          message: `This runner cannot host a ${payload.orbSize} environment.`,
        });
      }
      const existing = actors.get(sessionId);
      if (existing !== undefined) {
        // An uncertain delivery may repeat creation; the same definition is the same environment.
        const snapshot = existing.snapshot();
        if (
          snapshot.workspaceId === payload.workspaceId && snapshot.orbSize === payload.orbSize &&
          !deleting.has(sessionId)
        ) return snapshot;
        return yield* new SessionConflict({
          sessionId,
          message: "Another environment already uses this session.",
        });
      }
      const rejected = (message: string) => () => new EnvironmentRejected({ sessionId, message });
      const disposition = yield* store.ensure(sessionId).pipe(
        Effect.mapError(rejected("Environment storage could not be created.")),
      );
      if (disposition === "existing") {
        return yield* new SessionConflict({
          sessionId,
          message: "Storage for this session already exists on the runner.",
        });
      }
      const definition = new EnvironmentDefinition({
        sessionId,
        workspaceId: payload.workspaceId,
        runnerId: options.runnerId,
        createdAt: new Date().toISOString(),
        orbSize: payload.orbSize,
        ...(payload.repository === undefined ? {} : { repository: payload.repository }),
      });
      yield* store.append(sessionId, 0, { type: "environment.created", definition }).pipe(
        Effect.flatMap(() => store.replay(sessionId)),
        Effect.flatMap((replayed) =>
          replayed === undefined ? Effect.die("The created environment vanished.") : spawn(replayed)
        ),
        Effect.onError(() => store.remove(sessionId).pipe(Effect.ignore)),
        Effect.mapError(rejected("The environment could not be recorded.")),
      );
      const snapshot = actors.get(sessionId)!.snapshot();
      yield* PubSub.publish(published, { type: "updated", environment: snapshot });
      return snapshot;
    }));

  const remove = (sessionId: SessionId) =>
    admission.withPermit(Effect.gen(function* () {
      const actor = actors.get(sessionId);
      if (actor === undefined) {
        // Already gone, or an interrupted deletion: finishing it is idempotent.
        yield* store.remove(sessionId).pipe(Effect.ignore);
        return;
      }
      deleting.add(sessionId);
      yield* actor.stopForDeletion.pipe(
        Effect.tapError(() => Effect.sync(() => deleting.delete(sessionId))),
      );
      const rootDiskPath = yield* store.rootDiskPath(sessionId).pipe(Effect.option);
      if (rootDiskPath._tag === "Some") {
        const assertDetached = options.assertDetached ?? assertPersistentRootDiskDetached;
        const [, attached] = yield* Effect.promise(() => assertDetached(rootDiskPath.value));
        if (attached !== undefined) {
          deleting.delete(sessionId);
          return yield* new EnvironmentRejected({
            sessionId,
            message: "The root disk may still be attached to a VM, so its storage was preserved.",
          });
        }
      }
      yield* actor.shutdown;
      actors.delete(sessionId);
      yield* store.remove(sessionId).pipe(
        Effect.mapError(() =>
          new DeleteFailed({
            sessionId,
            message: "Environment storage cleanup failed and can be retried.",
          })
        ),
      );
      deleting.delete(sessionId);
      yield* PubSub.publish(published, { type: "removed", sessionId });
    }));

  return EnvironmentSupervisor.of({
    activeCount: () => [...actors.values()].filter((actor) => actor.active).length,
    snapshots: () =>
      [...actors.values()].filter((actor) => !deleting.has(actor.sessionId)).map((actor) =>
        actor.snapshot()
      ),
    changes: PubSub.subscribe(published).pipe(Effect.map(Stream.fromSubscription)),
    create,
    control: (payload) =>
      find(payload.sessionId).pipe(Effect.flatMap((actor) => actor.control(payload))),
    attach: (sessionId, nonce) =>
      find(sessionId).pipe(Effect.flatMap((actor) => actor.attach(nonce))),
    delete: remove,
  });
});

export function environmentSupervisorLayer(
  options: EnvironmentSupervisorOptions,
): Layer.Layer<EnvironmentSupervisor, never, EnvironmentStore | AgentEnvironmentProvider> {
  return Layer.effect(EnvironmentSupervisor, makeEnvironmentSupervisor(options));
}
