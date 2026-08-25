import {
  AbortRejected,
  CapacityExceeded,
  ClientRequestId,
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
  SessionId,
  SessionNotFound,
  type WatchSessionEvent,
} from "@openorb/protocol/runner-api";
import { orbSizeResources } from "@openorb/protocol";
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
  payload: OmitUnion<Parameters<Client["session.provision"]>[0], "sessionId">;
}
export interface PromptSessionInput {
  userId: string;
  sessionId: string;
  payload: Omit<Parameters<Client["session.prompt"]>[0], "sessionId" | "clientRequestId">;
}
export interface AbortSessionInput {
  userId: string;
  sessionId: string;
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
  readonly provisionSession: (
    input: ProvisionSessionInput,
  ) => Effect.Effect<OperationResult<unknown>>;
  readonly promptSession: (input: PromptSessionInput) => Effect.Effect<OperationResult<unknown>>;
  readonly abortSession: (input: AbortSessionInput) => Effect.Effect<OperationResult<unknown>>;
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
}
interface ConnectionRuntime {
  readonly client: Client;
  readonly scope: Scope.Closeable;
}
interface RegistryState {
  readonly nextGeneration: number;
  readonly connections: ReadonlyMap<string, Connection>;
  readonly routes: ReadonlyMap<string, Connection>;
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
  PromptRejected,
  AbortRejected,
]);

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
      revoked: new Set(),
    });
    const runtime: RegistryRuntime = { repository, state };
    return RunnerRegistry.of({
      accept: (socket) => Effect.scoped(accept(runtime, socket)),
      getRunnerLiveState: (userId, runnerId) => getRunnerLiveState(runtime, userId, runnerId),
      getSessionRunner: (userId, sessionId) => getSessionRunner(runtime, userId, sessionId),
      getSessionSnapshot: (userId, sessionId) => getSessionSnapshot(runtime, userId, sessionId),
      provisionSession: (input) => provisionSession(runtime, input),
      promptSession: (input) => promptSession(runtime, input),
      abortSession: (input) => abortSession(runtime, input),
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
          const sessions = new Map(
            initial.filter((x) => accepted.has(x.id)).map((x) => [x.id, x]),
          );
          const connectionRuntime: ConnectionRuntime = { client, scope };
          const [connection, old] = yield* SynchronizedRef.modifyEffect(
            registry.state,
            (current) => {
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
  return SynchronizedRef.modify(registry.state, (state) => {
    const current = state.connections.get(connection.runner.id);
    if (!current || current.generation !== connection.generation) return [null, state] as const;
    let removedSessionId: string | null = null;
    const routes = new Map(state.routes);
    const sessions = new Map(current.sessions);
    if (event.type === "session.updated" && event.revision > current.revision) {
      sessions.set(event.session.id, event.session);
    } else if (event.type === "session.removed" && event.revision > current.revision) {
      sessions.delete(event.sessionId);
      routes.delete(routeKey(connection.runner.userId, event.sessionId));
      removedSessionId = event.sessionId;
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
      updated = { ...current, sessions, revision: Math.max(current.revision, event.revision) };
    }
    if (updated === current) return [removedSessionId, state] as const;
    if (event.type === "session.updated") {
      routes.set(routeKey(current.runner.userId, event.session.id), updated);
    }
    const connections = new Map(state.connections).set(connection.runner.id, updated);
    for (const [id, route] of routes) {
      if (route.generation === current.generation) routes.set(id, updated);
    }
    return [removedSessionId, { ...state, connections, routes }] as const;
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
          const limit = connection.capacity.maxConcurrentSessions;
          if (
            limit !== undefined &&
            connection.capacity.activeSessions + connection.createReservations.size >= limit
          ) {
            rejection = "Runner has reached its concurrent session limit.";
          } else if (!runnerSupportsOrbSize(connection.capacity, input.payload.orbSize)) {
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
        if (snapshot.state !== "ready" && snapshot.state !== "running") {
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
      Effect.timeout(OPERATION_TIMEOUT_MS),
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
    yield* SynchronizedRef.update(registry.state, (state) => {
      const current = state.connections.get(connection.runner.id);
      if (!current || current.generation !== connection.generation) return state;
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
      return { ...replaced, routes };
    });
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
