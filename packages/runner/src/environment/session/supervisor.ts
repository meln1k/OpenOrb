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
import { EnvironmentDefinition, EnvironmentStore } from "./store.ts";

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
  readonly changes: Effect.Effect<Stream.Stream<RunnerEnvironmentSnapshot>, never, Scope.Scope>;
  readonly create: (
    payload: CreateEnvironmentPayload,
  ) => Effect.Effect<
    RunnerEnvironmentSnapshot,
    CapacityExceeded | SessionConflict | EnvironmentRejected
  >;
  readonly control: (
    payload: ControlEnvironmentPayload,
  ) => Effect.Effect<EnvironmentControlled, EnvironmentNotFound | EnvironmentRejected>;
  readonly delete: (
    sessionId: SessionId,
  ) => Effect.Effect<void, EnvironmentRejected | DeleteFailed>;
}

export const EnvironmentSupervisor: Context.Service<EnvironmentSupervisor, EnvironmentSupervisor> =
  Context.Service("@openorb/runner/EnvironmentSupervisor");

export const makeEnvironmentSupervisor = Effect.fn("makeEnvironmentSupervisor")(function* (
  options: EnvironmentSupervisorOptions,
) {
  const store = yield* EnvironmentStore;
  const dependencies = yield* Effect.context<EnvironmentStore | AgentEnvironmentProvider>();
  const admission = yield* Semaphore.make(1);
  const published = yield* PubSub.unbounded<RunnerEnvironmentSnapshot>();
  const actors = new Map<SessionId, EnvironmentActor>();
  const deleting = new Set<SessionId>();

  const spawn = (definition: EnvironmentDefinition) =>
    makeEnvironmentActor(definition, options, (environment) =>
      PubSub.publish(published, environment).pipe(Effect.asVoid),
    ).pipe(
      Effect.provide(dependencies),
      Effect.tap((actor) => Effect.sync(() => actors.set(definition.sessionId, actor))),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...actors.values()], (actor) => actor.shutdown, {
      concurrency: "unbounded",
      discard: true,
    }),
  );

  // Every environment is restored stopped: a runner restart leaves no VM.
  for (const definition of yield* store.list.pipe(Effect.orDie)) {
    if (definition.runnerId === options.runnerId) yield* spawn(definition);
  }

  const find = (sessionId: SessionId): Effect.Effect<EnvironmentActor, EnvironmentNotFound> => {
    const actor = actors.get(sessionId);
    return actor === undefined || deleting.has(sessionId)
      ? Effect.fail(
          new EnvironmentNotFound({ sessionId, message: "The environment does not exist." }),
        )
      : Effect.succeed(actor);
  };

  const create = (payload: CreateEnvironmentPayload) =>
    admission.withPermit(
      Effect.gen(function* () {
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
          if (existing.definition.orbSize === payload.orbSize && !deleting.has(sessionId)) {
            return existing.snapshot();
          }
          return yield* new SessionConflict({
            sessionId,
            message: "Another environment already uses this session.",
          });
        }
        const definition = new EnvironmentDefinition({
          sessionId,
          runnerId: options.runnerId,
          orbSize: payload.orbSize,
          ...(payload.repository === undefined ? {} : { repository: payload.repository }),
        });
        const disposition = yield* store.create(definition).pipe(
          Effect.mapError(
            () =>
              new EnvironmentRejected({
                sessionId,
                message: "Environment storage could not be created.",
              }),
          ),
        );
        if (disposition === "existing") {
          return yield* new SessionConflict({
            sessionId,
            message: "Storage for this session already exists on the runner.",
          });
        }
        const actor = yield* spawn(definition);
        return actor.snapshot();
      }),
    );

  const remove = (sessionId: SessionId) =>
    admission.withPermit(
      Effect.gen(function* () {
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
          Effect.mapError(
            () =>
              new DeleteFailed({
                sessionId,
                message: "Environment storage cleanup failed and can be retried.",
              }),
          ),
        );
        deleting.delete(sessionId);
      }),
    );

  return EnvironmentSupervisor.of({
    activeCount: () => [...actors.values()].filter((actor) => actor.active).length,
    snapshots: () =>
      [...actors.values()]
        .filter((actor) => !deleting.has(actor.definition.sessionId))
        .map((actor) => actor.snapshot()),
    changes: PubSub.subscribe(published).pipe(Effect.map(Stream.fromSubscription)),
    create,
    control: (payload) =>
      find(payload.sessionId).pipe(Effect.flatMap((actor) => actor.control(payload))),
    delete: remove,
  });
});

export function environmentSupervisorLayer(
  options: EnvironmentSupervisorOptions,
): Layer.Layer<EnvironmentSupervisor, never, EnvironmentStore | AgentEnvironmentProvider> {
  return Layer.effect(EnvironmentSupervisor, makeEnvironmentSupervisor(options));
}
