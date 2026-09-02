import {
  AbortRejected,
  CapacityExceeded,
  ClientRequestId,
  DeleteFailed,
  DeleteRejected,
  DeleteSessionPayload,
  type GitFileUpdateAccepted,
  GitFileUpdateRejected,
  initialPromptPreview,
  PromptRejected,
  ProvisionRejected,
  ProvisionSessionPayload,
  type ProvisionSessionSuccess,
  RunId,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  type RunnerCapacity,
  type RunnerSessionSnapshot,
  type RunnerStateEvent,
  SessionConflict,
  type SessionGitSnapshot,
  SessionId,
  SessionNotFound,
  StopRejected,
  type StopSessionAccepted,
  UpdateSessionGitFilePayload,
  UserId,
  WakeRejected,
  type WakeSessionAccepted,
  type WatchSessionEvent,
} from "@openorb/protocol/runner-api";
import { orbSizeResources } from "@openorb/protocol";
import { sessionWakeKind } from "@/app/utils/session-recovery.ts";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientApi from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import type { AuthenticatedRunner, RunnerRepository } from "@/app/data/runner-repository.ts";
import type { SessionCatalogRepository } from "@/app/data/session-catalog-repository.ts";

const AUTHENTICATION_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 15_000;
const COLD_CONTINUATION_TIMEOUT_MS = 5 * 60_000;
const GIT_UPDATE_TIMEOUT_MS = 60_000;
export const RUNNER_WATCH_INACTIVITY_TIMEOUT_MS = 60_000;
export const PERMANENT_REJECTION_CLOSE_CODE = 4401;
export const BOOTSTRAP_TIMEOUT_CLOSE_CODE = 4408;
const REJECTION_REASON = "Runner connection rejected";

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof RunnerApi>, RpcClientError>;
type OmitUnion<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface RunnerLiveState {
  capacity: RunnerCapacity;
  lastObservedAt: number;
}

export type OperationResult<A> =
  | { status: "accepted"; acknowledgement: A }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "delivery-uncertain"; message: string };

export interface ProvisionSessionInput {
  userId: string;
  runnerId: string;
  sessionId: string;
  payload: OmitUnion<Parameters<Client["session.provision"]>[0], "sessionId" | "userId">;
}
export interface PromptSessionInput {
  userId: string;
  sessionId: string;
  payload: Omit<Parameters<Client["session.prompt"]>[0], "sessionId" | "clientRequestId">;
}
export interface WakeSessionInput {
  userId: string;
  sessionId: string;
  payload: Omit<Parameters<Client["session.wake"]>[0], "sessionId">;
}
export interface AbortSessionInput {
  userId: string;
  sessionId: string;
}
export interface StopSessionInput {
  userId: string;
  sessionId: string;
}
export interface DeleteSessionInput {
  userId: string;
  sessionId: string;
}
export interface UpdateSessionGitFileInput {
  userId: string;
  sessionId: string;
  action: "stage" | "unstage";
  path: string;
  previousPath?: string;
}

export interface RunnerRegistryService {
  readonly getRunnerLiveState: (
    userId: string,
    runnerId: string,
  ) => Effect.Effect<RunnerLiveState | null>;
  readonly getSessionRunner: (userId: string, sessionId: string) => Effect.Effect<string | null>;
  readonly getSessionSnapshot: (
    userId: string,
    sessionId: string,
  ) => Effect.Effect<RunnerSessionSnapshot | null>;
  readonly getSessionGitSnapshot: (
    userId: string,
    sessionId: string,
  ) => Effect.Effect<OperationResult<SessionGitSnapshot>>;
  readonly updateSessionGitFile: (
    input: UpdateSessionGitFileInput,
  ) => Effect.Effect<OperationResult<GitFileUpdateAccepted>>;
  readonly provisionSession: (
    input: ProvisionSessionInput,
  ) => Effect.Effect<OperationResult<unknown>>;
  readonly wakeSession: (
    input: WakeSessionInput,
  ) => Effect.Effect<OperationResult<WakeSessionAccepted>>;
  readonly promptSession: (input: PromptSessionInput) => Effect.Effect<OperationResult<unknown>>;
  readonly abortSession: (input: AbortSessionInput) => Effect.Effect<OperationResult<unknown>>;
  readonly stopSession: (
    input: StopSessionInput,
  ) => Effect.Effect<OperationResult<StopSessionAccepted>>;
  readonly deleteSession: (input: DeleteSessionInput) => Effect.Effect<void>;
  readonly watchSession: (
    userId: string,
    sessionId: string,
    afterCursor: number,
  ) => Stream.Stream<typeof WatchSessionEvent.Type, unknown>;
  readonly disconnectRunner: (userId: string, runnerId: string) => Effect.Effect<boolean>;
}

export interface RunnerRegistry extends RunnerRegistryService {
  readonly accept: (socket: Socket.Socket) => Effect.Effect<void, unknown>;
}

interface Connection {
  readonly generation: number;
  readonly runner: AuthenticatedRunner;
  readonly runtime: ConnectionRuntime;
  readonly capacity: RunnerCapacity;
  readonly observedAt: number;
  readonly revision: number;
  readonly sessions: ReadonlyMap<string, RunnerSessionSnapshot>;
  readonly reservations: ReadonlySet<string>;
  readonly createReservations: ReadonlySet<string>;
  readonly tombstones: ReadonlySet<string>;
  readonly cleanupInFlight: ReadonlySet<string>;
}
interface ConnectionRuntime {
  readonly client: Client;
  readonly scope: Scope.Closeable;
}
interface RegistryState {
  readonly nextGeneration: number;
  readonly connections: ReadonlyMap<string, Connection>;
  readonly routes: ReadonlyMap<string, Connection>;
  readonly deletions: ReadonlySet<string>;
  readonly revoked: ReadonlySet<string>;
}
type ReservationResult =
  | { readonly status: "reserved"; readonly connection: Connection }
  | { readonly status: "rejected"; readonly message: string };
type RoutedSessionResult =
  | {
    readonly status: "routed";
    readonly connection: Connection;
    readonly snapshot: RunnerSessionSnapshot;
  }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string };
type GatewayRepository =
  & Pick<RunnerRepository, "authenticateRunner">
  & Pick<SessionCatalogRepository, "reconcileSessionManifestEntries">;
const OperationRejection = Schema.Union([
  CapacityExceeded,
  SessionConflict,
  ProvisionRejected,
  SessionNotFound,
  WakeRejected,
  PromptRejected,
  AbortRejected,
  StopRejected,
  GitFileUpdateRejected,
]);
const DeletionFailure = Schema.Union([DeleteRejected, DeleteFailed]);

interface RegistryRuntime {
  readonly repository: GatewayRepository;
  readonly state: SynchronizedRef.SynchronizedRef<RegistryState>;
}

export const RunnerRegistry: Context.Service<RunnerRegistry, RunnerRegistry> = Context.Service(
  "@openorb/gateway/RunnerRegistry",
);

export function makeRunnerRegistry(
  repository: GatewayRepository,
): Effect.Effect<RunnerRegistry> {
  return Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<RegistryState>({
      nextGeneration: 1,
      connections: new Map(),
      routes: new Map(),
      deletions: new Set(),
      revoked: new Set(),
    });
    const runtime: RegistryRuntime = { repository, state };
    return RunnerRegistry.of({
      accept: (socket) => Effect.scoped(accept(runtime, socket)),
      getRunnerLiveState: (userId, runnerId) => getRunnerLiveState(runtime, userId, runnerId),
      getSessionRunner: (userId, sessionId) => getSessionRunner(runtime, userId, sessionId),
      getSessionSnapshot: (userId, sessionId) => getSessionSnapshot(runtime, userId, sessionId),
      getSessionGitSnapshot: (userId, sessionId) =>
        getSessionGitSnapshot(runtime, userId, sessionId),
      updateSessionGitFile: (input) => updateSessionGitFile(runtime, input),
      provisionSession: (input) => provisionSession(runtime, input),
      wakeSession: (input) => wakeSession(runtime, input),
      promptSession: (input) => promptSession(runtime, input),
      abortSession: (input) => abortSession(runtime, input),
      stopSession: (input) => stopSession(runtime, input),
      deleteSession: (input) => deleteSession(runtime, input),
      watchSession: (userId, sessionId, afterCursor) =>
        watchSession(runtime, userId, sessionId, afterCursor),
      disconnectRunner: (userId, runnerId) => disconnectRunner(runtime, userId, runnerId),
    });
  });
}

export const runnerRegistryLayer = (
  repository: GatewayRepository,
) => Layer.effect(RunnerRegistry, makeRunnerRegistry(repository));

const accept = Effect.fn("RunnerRegistry.accept")(
  function* (registry: RegistryRuntime, socket: Socket.Socket) {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const write = yield* socket.writer;
    const reject = (code: number, reason: string) => write(new Socket.CloseEvent(code, reason));
    const protocol = yield* RpcClientApi.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) })
      .pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerJson),
        Effect.provideService(Scope.Scope, scope),
      );
    const client = yield* RpcClientApi.make(RunnerApi).pipe(
      Effect.provideService(RpcClientApi.Protocol, protocol),
      Effect.provideService(Scope.Scope, scope),
    );
    const identity = yield* client["runner.identify"]().pipe(
      Effect.timeoutOption(AUTHENTICATION_TIMEOUT_MS),
    );
    if (Option.isNone(identity)) {
      yield* reject(BOOTSTRAP_TIMEOUT_CLOSE_CODE, "Runner identification timed out");
      yield* Scope.close(scope, Exit.void);
      return;
    }
    const authenticated = yield* Effect.tryPromise(() =>
      registry.repository.authenticateRunner(identity.value.token)
    );
    const state = yield* SynchronizedRef.get(registry.state);
    if (
      !authenticated || authenticated.id !== identity.value.runnerId ||
      identity.value.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
      state.revoked.has(runnerKey(authenticated.userId, authenticated.id))
    ) {
      yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
      yield* Scope.close(scope, Exit.void);
      return;
    }

    const initial: RunnerSessionSnapshot[] = [];
    let complete: {
      capacity: RunnerCapacity;
      revision: number;
      observedAt: number;
      sessionCount: number;
    } | undefined;
    let ownedConnection: Connection | undefined;
    const events = client["runner.watch"]().pipe(
      Stream.timeout(RUNNER_WATCH_INACTIVITY_TIMEOUT_MS),
    );
    yield* Stream.runForEach(
      events,
      (event) =>
        Effect.gen(function* () {
          if (complete) {
            if (ownedConnection) yield* applyEvent(registry, ownedConnection, event);
            return;
          }
          if (event.type === "snapshot.session") {
            initial.push(event.session);
            return;
          }
          if (event.type !== "snapshot.complete") {
            yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
            return yield* Effect.fail(new CandidateRejected());
          }
          const completed = event;
          complete = completed;
          if (
            complete.sessionCount !== initial.length ||
            new Set(initial.map((x) => x.id)).size !== initial.length
          ) {
            yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
            return yield* Effect.fail(new CandidateRejected());
          }
          const reconciled = yield* reconcile(registry, authenticated.userId, initial).pipe(
            Effect.catch(() => Effect.fail(new CandidateRejected())),
          );
          if (reconciled.rejected.length > 0) {
            yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
            return yield* Effect.fail(new CandidateRejected());
          }
          const accepted = new Set(reconciled.acceptedSessionIds);
          const reconciledSessions = new Map(
            initial.filter((x) => accepted.has(x.id)).map((x) => [x.id, x]),
          );
          const connectionRuntime: ConnectionRuntime = { client, scope };
          const [connection, old] = yield* SynchronizedRef.modifyEffect(
            registry.state,
            (current) => {
              const sessions = new Map(reconciledSessions);
              const tombstones = new Set(reconciled.tombstonedSessionIds);
              for (const sessionId of sessions.keys()) {
                if (current.deletions.has(routeKey(authenticated.userId, sessionId))) {
                  sessions.delete(sessionId);
                  tombstones.add(sessionId);
                }
              }
              for (const sessionId of sessions.keys()) {
                const routed = current.routes.get(routeKey(authenticated.userId, sessionId));
                if (routed && routed.runner.id !== authenticated.id) {
                  return Effect.fail(new CandidateRejected());
                }
              }
              const connection: Connection = {
                generation: current.nextGeneration,
                runner: authenticated,
                runtime: connectionRuntime,
                sessions,
                reservations: new Set(),
                createReservations: new Set(),
                tombstones,
                cleanupInFlight: new Set(),
                capacity: completed.capacity,
                revision: completed.revision,
                observedAt: completed.observedAt,
              };
              const previous = current.connections.get(authenticated.id);
              const connections = new Map(current.connections).set(authenticated.id, connection);
              const routes = new Map(current.routes);
              if (previous) {
                for (const [id, route] of routes) if (route === previous) routes.delete(id);
              }
              for (const id of sessions.keys()) {
                routes.set(routeKey(authenticated.userId, id), connection);
              }
              return Effect.succeed(
                [[connection, previous] as const, {
                  ...current,
                  nextGeneration: current.nextGeneration + 1,
                  connections,
                  routes,
                }] as const,
              );
            },
          ).pipe(
            Effect.catch((error) =>
              reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON).pipe(
                Effect.andThen(Effect.fail(error)),
              )
            ),
          );
          ownedConnection = connection;
          if (old) yield* Scope.close(old.runtime.scope, Exit.void);
          yield* Effect.forEach(
            connection.tombstones,
            (sessionId) => scheduleDeletedSessionCleanup(registry, connection, sessionId),
            { discard: true },
          );
        }),
    ).pipe(
      Effect.ensuring(Effect.suspend(() => {
        const remove = ownedConnection ? removeConnection(registry, ownedConnection) : Effect.void;
        return remove.pipe(Effect.andThen(Scope.close(scope, Exit.void)));
      })),
      Effect.provideService(Scope.Scope, scope),
    );
  },
);

function applyEvent(
  registry: RegistryRuntime,
  connection: Connection,
  event: typeof RunnerStateEvent.Type,
) {
  return Effect.gen(function* () {
    let unknownSessionDisposition: "accepted" | "tombstoned" | "rejected" | null = null;
    if (event.type === "session.updated") {
      const current = (yield* SynchronizedRef.get(registry.state)).connections.get(
        connection.runner.id,
      );
      if (
        current?.generation === connection.generation && event.revision > current.revision &&
        !current.sessions.has(event.session.id) && !current.tombstones.has(event.session.id)
      ) {
        const reconciled = yield* reconcile(registry, connection.runner.userId, [event.session]);
        unknownSessionDisposition = reconciled.tombstonedSessionIds.includes(event.session.id)
          ? "tombstoned"
          : reconciled.acceptedSessionIds.includes(event.session.id)
          ? "accepted"
          : "rejected";
      }
    }

    const cleanupSessionId = yield* SynchronizedRef.modify(registry.state, (state) => {
      const current = state.connections.get(connection.runner.id);
      if (!current || current.generation !== connection.generation) return [null, state] as const;
      let cleanupSessionId: string | null = null;
      const routes = new Map(state.routes);
      const sessions = new Map(current.sessions);
      const tombstones = new Set(current.tombstones);
      if (event.type === "session.updated") {
        if (
          unknownSessionDisposition === "tombstoned" ||
          state.deletions.has(routeKey(connection.runner.userId, event.session.id))
        ) {
          tombstones.add(event.session.id);
        }
      }
      if (event.type === "session.updated" && event.revision > current.revision) {
        if (tombstones.has(event.session.id)) {
          sessions.delete(event.session.id);
          routes.delete(routeKey(connection.runner.userId, event.session.id));
          cleanupSessionId = event.session.id;
        } else if (unknownSessionDisposition !== "rejected") {
          sessions.set(event.session.id, event.session);
        }
      } else if (event.type === "session.removed" && event.revision > current.revision) {
        sessions.delete(event.sessionId);
        routes.delete(routeKey(connection.runner.userId, event.sessionId));
      }
      let updated = current;
      if (event.type === "runner.observed" && event.revision > current.revision) {
        updated = {
          ...current,
          capacity: event.capacity,
          observedAt: event.observedAt,
          revision: event.revision,
        };
      } else if (event.type === "session.updated" || event.type === "session.removed") {
        updated = {
          ...current,
          sessions,
          tombstones,
          revision: Math.max(current.revision, event.revision),
        };
      }
      if (updated === current) return [cleanupSessionId, state] as const;
      if (
        event.type === "session.updated" && !tombstones.has(event.session.id) &&
        unknownSessionDisposition !== "rejected"
      ) {
        routes.set(routeKey(current.runner.userId, event.session.id), updated);
      }
      const connections = new Map(state.connections).set(connection.runner.id, updated);
      for (const [id, route] of routes) {
        if (route.generation === current.generation) routes.set(id, updated);
      }
      return [cleanupSessionId, { ...state, connections, routes }] as const;
    });
    if (cleanupSessionId) {
      yield* scheduleDeletedSessionCleanup(registry, connection, cleanupSessionId);
    }
  });
}

function removeConnection(registry: RegistryRuntime, connection: Connection) {
  return SynchronizedRef.update(registry.state, (state) => {
    if (state.connections.get(connection.runner.id)?.generation !== connection.generation) {
      return state;
    }
    const connections = new Map(state.connections);
    connections.delete(connection.runner.id);
    const routes = new Map(state.routes);
    for (const [id, route] of routes) {
      if (route.generation === connection.generation) routes.delete(id);
    }
    return { ...state, connections, routes };
  });
}

function reconcile(registry: RegistryRuntime, userId: string, entries: RunnerSessionSnapshot[]) {
  return Effect.tryPromise({
    try: async () => {
      const [reconciled, reconciliationError] = await registry.repository
        .reconcileSessionManifestEntries(userId, entries);
      if (reconciliationError !== undefined) throw reconciliationError;
      return reconciled;
    },
    catch: (cause) => cause,
  });
}

function getRunnerLiveState(registry: RegistryRuntime, userId: string, runnerId: string) {
  return SynchronizedRef.get(registry.state).pipe(Effect.map((state) => {
    const connection = state.connections.get(runnerId);
    if (!connection || connection.runner.userId !== userId) return null;
    return {
      capacity: {
        ...connection.capacity,
        activeSessions: connection.capacity.activeSessions + connection.createReservations.size,
      },
      lastObservedAt: connection.observedAt,
    };
  }));
}

function getSessionRunner(registry: RegistryRuntime, userId: string, sessionId: string) {
  return SynchronizedRef.get(registry.state).pipe(
    Effect.map((state) => state.routes.get(routeKey(userId, sessionId))?.runner.id ?? null),
  );
}

function getSessionSnapshot(registry: RegistryRuntime, userId: string, sessionId: string) {
  return SynchronizedRef.get(registry.state).pipe(
    Effect.map((state) =>
      state.routes.get(routeKey(userId, sessionId))?.sessions.get(sessionId) ?? null
    ),
  );
}

const getSessionGitSnapshot = Effect.fn("RunnerRegistry.getSessionGitSnapshot")(
  function* (registry: RegistryRuntime, userId: string, sessionId: string) {
    const routed = yield* routeSession(registry, userId, sessionId, () => undefined);
    if (routed.status === "unavailable") return unavailable(routed.message);
    if (routed.status === "rejected") {
      return { status: "rejected" as const, message: routed.message };
    }
    const decoded = Schema.decodeUnknownOption(SessionId)(sessionId);
    if (Option.isNone(decoded)) return unavailable("The session identifier is invalid.");
    return yield* routed.connection.runtime.client["session.git-snapshot.read"]({
      sessionId: decoded.value,
    }).pipe(
      Effect.timeout(OPERATION_TIMEOUT_MS),
      Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
      Effect.catchCause(() =>
        Effect.succeed(unavailable("The cached Git Snapshot is unavailable."))
      ),
    );
  },
);

const updateSessionGitFile = Effect.fn("RunnerRegistry.updateSessionGitFile")(
  function* (registry: RegistryRuntime, input: UpdateSessionGitFileInput) {
    const routed = yield* routeSession(
      registry,
      input.userId,
      input.sessionId,
      () => undefined,
    );
    if (routed.status === "unavailable") return unavailable(routed.message);
    if (routed.status === "rejected") {
      return { status: "rejected" as const, message: routed.message };
    }
    const request = Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
      sessionId: input.sessionId,
      action: input.action,
      path: input.path,
      ...(input.previousPath === undefined ? {} : { previousPath: input.previousPath }),
    });
    return yield* routed.connection.runtime.client["session.git-file.update"](request).pipe(
      Effect.timeout(GIT_UPDATE_TIMEOUT_MS),
      Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
      Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
    );
  },
);

const provisionSession = Effect.fn("RunnerRegistry.provisionSession")(
  function* (registry: RegistryRuntime, input: ProvisionSessionInput) {
    const sessionId = Schema.decodeUnknownSync(SessionId)(input.sessionId);
    const reserved = yield* SynchronizedRef.modifyEffect(
      registry.state,
      (state): Effect.Effect<readonly [ReservationResult, RegistryState]> => {
        const connection = state.connections.get(input.runnerId);
        let rejection: string | undefined;
        if (!connection || connection.runner.userId !== input.userId) {
          rejection = "Runner is unavailable.";
        } else if (connection.reservations.has(input.sessionId)) {
          rejection = "This session already has a provisioning request in flight.";
        } else if (input.payload.mode === "create") {
          if (!runnerSupportsOrbSize(connection.capacity, input.payload.orbSize)) {
            rejection = `Runner cannot provision the ${input.payload.orbSize} orb size.`;
          } else {
            const existing = state.routes.get(routeKey(input.userId, input.sessionId));
            if (existing && existing.generation !== connection.generation) {
              rejection = "This session is pinned to another runner.";
            }
          }
        }
        if (!connection || rejection) {
          return Effect.succeed(
            [
              { status: "rejected" as const, message: rejection ?? "Runner is unavailable." },
              state,
            ] as const,
          );
        }
        const updated = {
          ...connection,
          reservations: new Set(connection.reservations).add(input.sessionId),
          createReservations: input.payload.mode === "create"
            ? new Set(connection.createReservations).add(input.sessionId)
            : connection.createReservations,
        };
        return Effect.succeed(
          [
            { status: "reserved" as const, connection: updated },
            replaceConnection(state, connection, updated),
          ] as const,
        );
      },
    );
    if (reserved.status === "rejected") return unavailable(reserved.message);
    const request = Schema.decodeUnknownSync(ProvisionSessionPayload)({
      ...input.payload,
      sessionId,
      ...(input.payload.mode === "create"
        ? { userId: Schema.decodeUnknownSync(UserId)(input.userId) }
        : {}),
    });
    return yield* reserved.connection.runtime.client["session.provision"](request).pipe(
      Effect.timeout(OPERATION_TIMEOUT_MS),
      Effect.flatMap((acknowledgement) =>
        acceptProvisioned(registry, reserved.connection, input, acknowledgement).pipe(
          Effect.as({ status: "accepted" as const, acknowledgement }),
        )
      ),
      Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
      Effect.ensuring(
        releaseReservation(
          registry,
          reserved.connection.generation,
          input.runnerId,
          input.sessionId,
        ),
      ),
    );
  },
);
const promptSession = Effect.fn("RunnerRegistry.promptSession")(
  function* (registry: RegistryRuntime, input: PromptSessionInput) {
    const routed = yield* routeSession(
      registry,
      input.userId,
      input.sessionId,
      (snapshot) => {
        if (
          snapshot.state !== "ready" && snapshot.state !== "running" &&
          snapshot.state !== "stopped"
        ) {
          return "The session cannot accept a prompt right now.";
        }
        return snapshot.model === input.payload.modelRuntime.model
          ? undefined
          : "The session model cannot change during continuation.";
      },
    );
    if (routed.status === "unavailable") return unavailable(routed.message);
    if (routed.status === "rejected") {
      return { status: "rejected" as const, message: routed.message };
    }
    const sessionId = Schema.decodeUnknownSync(SessionId)(input.sessionId);
    const clientRequestId = Schema.decodeUnknownSync(ClientRequestId)(crypto.randomUUID());
    return yield* routed.connection.runtime.client["session.prompt"]({
      ...input.payload,
      sessionId,
      clientRequestId,
    }).pipe(
      Effect.timeout(
        routed.snapshot.state === "stopped" ? COLD_CONTINUATION_TIMEOUT_MS : OPERATION_TIMEOUT_MS,
      ),
      Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
      Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
    );
  },
);
const wakeSession = Effect.fn("RunnerRegistry.wakeSession")(
  function* (registry: RegistryRuntime, input: WakeSessionInput) {
    const routed = yield* routeSession(
      registry,
      input.userId,
      input.sessionId,
      (snapshot) =>
        snapshot.model === input.payload.modelRuntime.model
          ? undefined
          : "The session model cannot change during restoration.",
    );
    if (routed.status === "unavailable") return unavailable(routed.message);
    if (routed.status === "rejected") {
      return { status: "rejected" as const, message: routed.message };
    }
    const wakeKind = sessionWakeKind(routed.snapshot, input.payload.recovery);
    if (wakeKind === undefined) {
      return {
        status: "rejected" as const,
        message: "The session cannot be restored right now.",
      };
    }
    const sessionId = Schema.decodeUnknownSync(SessionId)(input.sessionId);
    return yield* routed.connection.runtime.client["session.wake"]({
      ...input.payload,
      sessionId,
    }).pipe(
      Effect.timeout(
        wakeKind === "cold" ? COLD_CONTINUATION_TIMEOUT_MS : OPERATION_TIMEOUT_MS,
      ),
      Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
      Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
    );
  },
);
const abortSession = Effect.fn("RunnerRegistry.abortSession")(
  function* (registry: RegistryRuntime, input: AbortSessionInput) {
    const routed = yield* routeSession(
      registry,
      input.userId,
      input.sessionId,
      (snapshot) => snapshot.activeRunId ? undefined : "There is no active Pi run to abort.",
    );
    if (routed.status === "unavailable") return unavailable(routed.message);
    if (routed.status === "rejected") {
      return { status: "rejected" as const, message: routed.message };
    }
    const sessionId = Schema.decodeUnknownSync(SessionId)(input.sessionId);
    const runId = Schema.decodeUnknownSync(RunId)(routed.snapshot.activeRunId);
    return yield* routed.connection.runtime.client["session.abort"]({
      sessionId,
      runId,
    }).pipe(
      Effect.timeout(OPERATION_TIMEOUT_MS),
      Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
      Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
    );
  },
);
const stopSession = Effect.fn("RunnerRegistry.stopSession")(
  function* (registry: RegistryRuntime, input: StopSessionInput) {
    const routed = yield* routeSession(
      registry,
      input.userId,
      input.sessionId,
      (snapshot) => snapshot.state === "ready" ? undefined : "The session is not ready and idle.",
    );
    if (routed.status === "unavailable") return unavailable(routed.message);
    if (routed.status === "rejected") {
      return { status: "rejected" as const, message: routed.message };
    }
    const sessionId = Schema.decodeUnknownSync(SessionId)(input.sessionId);
    return yield* routed.connection.runtime.client["session.stop"]({ sessionId }).pipe(
      Effect.timeout(COLD_CONTINUATION_TIMEOUT_MS),
      Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
      Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
    );
  },
);
const deleteSession = Effect.fn("RunnerRegistry.deleteSession")(
  function* (registry: RegistryRuntime, input: DeleteSessionInput) {
    const connection = yield* SynchronizedRef.modify(registry.state, (state) => {
      const key = routeKey(input.userId, input.sessionId);
      const deletions = new Set(state.deletions).add(key);
      const routed = state.routes.get(key);
      const current = routed && state.connections.get(routed.runner.id);
      if (
        !routed || !current || current.generation !== routed.generation ||
        current.runner.userId !== input.userId
      ) return [null, { ...state, deletions }] as const;

      const sessions = new Map(current.sessions);
      sessions.delete(input.sessionId);
      const reservations = new Set(current.reservations);
      reservations.delete(input.sessionId);
      const createReservations = new Set(current.createReservations);
      createReservations.delete(input.sessionId);
      const updated: Connection = {
        ...current,
        sessions,
        reservations,
        createReservations,
        tombstones: new Set(current.tombstones).add(input.sessionId),
      };
      const replaced = replaceConnection(state, current, updated);
      const routes = new Map(replaced.routes);
      routes.delete(key);
      return [updated, { ...replaced, routes, deletions }] as const;
    });
    if (connection) {
      yield* scheduleDeletedSessionCleanup(registry, connection, input.sessionId);
    }
  },
);

function watchSession(
  registry: RegistryRuntime,
  userId: string,
  sessionId: string,
  afterCursor: number,
) {
  return Stream.unwrap(Effect.gen(function* () {
    const decoded = Schema.decodeUnknownOption(SessionId)(sessionId);
    if (Option.isNone(decoded)) return Stream.fail(new Error("The session identifier is invalid."));
    const connection = (yield* SynchronizedRef.get(registry.state)).routes.get(
      routeKey(userId, sessionId),
    );
    if (!connection) return Stream.fail(new Error("The pinned runner is offline."));
    const routed = (yield* SynchronizedRef.get(registry.state)).routes.get(
      routeKey(userId, sessionId),
    );
    if (!routed || routed.generation !== connection.generation) {
      return Stream.fail(new Error("The pinned runner is offline."));
    }
    return connection.runtime.client["session.watch"]({
      sessionId: decoded.value,
      afterCursor,
    });
  }));
}

const disconnectRunner = Effect.fn("RunnerRegistry.disconnectRunner")(
  function* (registry: RegistryRuntime, userId: string, runnerId: string) {
    const connection = (yield* SynchronizedRef.get(registry.state)).connections.get(runnerId);
    if (!connection || connection.runner.userId !== userId) return false;
    yield* SynchronizedRef.update(
      registry.state,
      (s) => ({ ...s, revoked: new Set(s.revoked).add(runnerKey(userId, runnerId)) }),
    );
    yield* Scope.close(connection.runtime.scope, Exit.void);
    return true;
  },
);

function releaseReservation(
  registry: RegistryRuntime,
  generation: number,
  runnerId: string,
  sessionId: string,
) {
  return SynchronizedRef.update(registry.state, (state) => {
    const connection = state.connections.get(runnerId);
    if (
      !connection || connection.generation !== generation ||
      !connection.reservations.has(sessionId)
    ) return state;
    const reservations = new Set(connection.reservations);
    reservations.delete(sessionId);
    const createReservations = new Set(connection.createReservations);
    createReservations.delete(sessionId);
    return replaceConnection(state, connection, {
      ...connection,
      reservations,
      createReservations,
    });
  });
}

function scheduleDeletedSessionCleanup(
  registry: RegistryRuntime,
  connection: Connection,
  sessionId: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const runtime = yield* SynchronizedRef.modify(registry.state, (state) => {
      const current = state.connections.get(connection.runner.id);
      if (
        !current || current.generation !== connection.generation ||
        !current.tombstones.has(sessionId) || current.cleanupInFlight.has(sessionId)
      ) return [null, state] as const;
      const updated = {
        ...current,
        cleanupInFlight: new Set(current.cleanupInFlight).add(sessionId),
      };
      return [updated.runtime, replaceConnection(state, current, updated)] as const;
    });
    if (!runtime) return;
    const decoded = Schema.decodeUnknownOption(SessionId)(sessionId);
    if (Option.isNone(decoded)) return;
    yield* Effect.forkIn(
      cleanupDeletedSession(connection, decoded.value).pipe(
        Effect.ensuring(clearCleanupInFlight(registry, connection, sessionId)),
      ),
      runtime.scope,
    );
  });
}

function cleanupDeletedSession(
  connection: Connection,
  sessionId: typeof SessionId.Type,
): Effect.Effect<void> {
  const retry = () =>
    Effect.sleep(1_000).pipe(
      Effect.andThen(Effect.suspend(() => cleanupDeletedSession(connection, sessionId))),
    );
  return connection.runtime.client["session.delete"](
    new DeleteSessionPayload({ sessionId }),
  ).pipe(
    Effect.timeout(OPERATION_TIMEOUT_MS),
    Effect.asVoid,
    Effect.catchCause((cause) => {
      const failure = Option.flatMap(
        Cause.findErrorOption(cause),
        Schema.decodeUnknownOption(DeletionFailure),
      );
      if (Option.isSome(failure) && failure.value instanceof DeleteFailed) {
        return Effect.logWarning(
          `Runner cleanup for deleted session ${sessionId} failed and will be retried: ${failure.value.message}`,
        ).pipe(Effect.andThen(retry()));
      }
      return retry();
    }),
  );
}

function clearCleanupInFlight(
  registry: RegistryRuntime,
  connection: Connection,
  sessionId: string,
) {
  return SynchronizedRef.update(registry.state, (state) => {
    const current = state.connections.get(connection.runner.id);
    if (
      !current || current.generation !== connection.generation ||
      !current.cleanupInFlight.has(sessionId)
    ) return state;
    const cleanupInFlight = new Set(current.cleanupInFlight);
    cleanupInFlight.delete(sessionId);
    return replaceConnection(state, current, { ...current, cleanupInFlight });
  });
}

function routeSession(
  registry: RegistryRuntime,
  userId: string,
  sessionId: string,
  validate: (snapshot: RunnerSessionSnapshot) => string | undefined,
): Effect.Effect<RoutedSessionResult> {
  return SynchronizedRef.get(registry.state).pipe(
    Effect.map((state): RoutedSessionResult => {
      const connection = state.routes.get(routeKey(userId, sessionId));
      const snapshot = connection?.sessions.get(sessionId);
      if (!connection || !snapshot) {
        return { status: "unavailable", message: "The pinned runner is offline." };
      }
      const rejection = validate(snapshot);
      if (rejection) {
        return { status: "rejected", message: rejection };
      }
      return { status: "routed", connection, snapshot };
    }),
  );
}

function acceptProvisioned(
  registry: RegistryRuntime,
  connection: Connection,
  input: ProvisionSessionInput,
  acknowledgement: ProvisionSessionSuccess,
) {
  return Effect.gen(function* () {
    if (input.payload.mode === "create") {
      if (
        acknowledgement.session.projectId !== input.payload.projectId ||
        acknowledgement.ref !== input.payload.ref ||
        acknowledgement.branchName !== input.payload.branchName ||
        acknowledgement.session.orbSize !== input.payload.orbSize ||
        acknowledgement.session.initialPromptPreview !==
          initialPromptPreview(input.payload.initialPrompt)
      ) {
        return yield* Effect.fail(
          new ProvisionAcceptanceError(
            "Runner provisioning acceptance did not match the request.",
          ),
        );
      }
      const reconciled = yield* reconcile(registry, input.userId, [acknowledgement.session]).pipe(
        Effect.mapError(() =>
          new ProvisionAcceptanceError("Session catalog reconciliation failed.")
        ),
      );
      if (
        reconciled.rejected.length > 0 ||
        !reconciled.acceptedSessionIds.includes(input.sessionId)
      ) {
        return yield* Effect.fail(
          new ProvisionAcceptanceError("Session catalog reconciliation was rejected."),
        );
      }
    }
    const cleanupConnection = yield* SynchronizedRef.modify(registry.state, (state) => {
      const current = state.connections.get(connection.runner.id);
      if (!current || current.generation !== connection.generation) {
        return [null, state] as const;
      }
      if (
        current.tombstones.has(input.sessionId) ||
        state.deletions.has(routeKey(input.userId, input.sessionId))
      ) {
        const sessions = new Map(current.sessions);
        sessions.delete(input.sessionId);
        const updated = {
          ...current,
          sessions,
          tombstones: new Set(current.tombstones).add(input.sessionId),
        };
        const replaced = replaceConnection(state, current, updated);
        const routes = new Map(replaced.routes);
        routes.delete(routeKey(input.userId, input.sessionId));
        return [updated, { ...replaced, routes }] as const;
      }
      const sessions = new Map(current.sessions).set(
        input.sessionId,
        acknowledgement.session,
      );
      const updated = { ...current, sessions };
      const replaced = replaceConnection(state, current, updated);
      const routes = new Map(replaced.routes).set(
        routeKey(input.userId, input.sessionId),
        updated,
      );
      return [null, { ...replaced, routes }] as const;
    });
    if (cleanupConnection) {
      yield* scheduleDeletedSessionCleanup(registry, cleanupConnection, input.sessionId);
    }
  });
}

function unavailable(message: string) {
  return { status: "unavailable" as const, message };
}
function operationFailure(cause: Cause.Cause<unknown>, uncertain: boolean): OperationResult<never> {
  const rejection = Option.flatMap(
    Cause.findErrorOption(cause),
    Schema.decodeUnknownOption(OperationRejection),
  );
  if (Option.isSome(rejection)) return { status: "rejected", message: rejection.value.message };
  return {
    status: uncertain ? "delivery-uncertain" : "unavailable",
    message: uncertain
      ? "Delivery may be uncertain; the operation will not be retried automatically."
      : "Runner is unavailable.",
  };
}
function replaceConnection(
  state: RegistryState,
  previous: Connection,
  next: Connection,
): RegistryState {
  const connections = new Map(state.connections).set(previous.runner.id, next);
  const routes = new Map(state.routes);
  for (const [id, route] of routes) if (route === previous) routes.set(id, next);
  return { ...state, connections, routes };
}
function runnerSupportsOrbSize(
  capacity: RunnerCapacity,
  orbSize: Extract<ProvisionSessionInput["payload"], { mode: "create" }>["orbSize"],
) {
  const resources = orbSizeResources(orbSize);
  return resources.cpuCount <= capacity.vmCpuCount && resources.memoryMiB <= capacity.vmMemoryMiB;
}

class CandidateRejected extends Error {}
class ProvisionAcceptanceError extends Error {}
function runnerKey(userId: string, runnerId: string) {
  return `${userId}:${runnerId}`;
}
function routeKey(userId: string, sessionId: string) {
  return `${userId}:${sessionId}`;
}
