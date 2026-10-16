import { RunnerBulkApi, runnerBulkRpcSerializationLayer } from "@openorb/protocol/runner-bulk-api";
import {
  CapacityExceeded,
  type EnvironmentControlled,
  type EnvironmentCreated,
  type EnvironmentDeleted,
  EnvironmentNotFound,
  EnvironmentRejected,
  type EnvironmentState,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  type RunnerCapacity,
  type RunnerStateEvent,
  SessionConflict,
  SessionId,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";
import {
  Cause,
  Clock,
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
import type * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientApi from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import {
  runnerControlRpcSerializationLayer,
  runnerControlWebSocket,
} from "@openorb/protocol/runner-control-transport";
import * as Socket from "effect/socket/Socket";

import type { AuthenticatedRunner, WorkspaceApi } from "../workspace/api.ts";

// The Runners Durable Object routes Environment Control to runners (ADR 0006). Sessions live in
// Session Durable Objects, which address their runner by placement; a runner only reports its
// environments' states and its capacity.

const AUTHENTICATION_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 15_000;
const COLD_CONTINUATION_TIMEOUT_MS = 5 * 60_000;
export const RUNNER_WATCH_INACTIVITY_TIMEOUT_MS = 60_000;
export const PERMANENT_REJECTION_CLOSE_CODE = 4401;
export const BOOTSTRAP_TIMEOUT_CLOSE_CODE = 4408;
const REJECTION_REASON = "Runner connection rejected";

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof RunnerApi>, RpcClientError>;
type BulkClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof RunnerBulkApi>, RpcClientError>;

export interface RunnerLiveState {
  capacity: RunnerCapacity;
  lastObservedAt: number;
}

export type OperationResult<A> =
  | { status: "accepted"; acknowledgement: A }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "delivery-uncertain"; message: string };

export interface RunnerRegistry {
  readonly getRunnerLiveState: (
    workspaceId: WorkspaceId,
    runnerId: string,
  ) => Effect.Effect<RunnerLiveState | null>;
  readonly disconnectRunner: (workspaceId: WorkspaceId, runnerId: string) => Effect.Effect<boolean>;
  readonly createEnvironment: (
    input: CreateEnvironmentInput,
  ) => Effect.Effect<OperationResult<EnvironmentCreated>>;
  readonly controlEnvironment: (
    input: ControlEnvironmentInput,
  ) => Effect.Effect<OperationResult<EnvironmentControlled>>;
  readonly deleteEnvironment: (
    input: EnvironmentInput,
  ) => Effect.Effect<OperationResult<EnvironmentDeleted>>;
  readonly accept: (socket: Socket.Socket) => Effect.Effect<void, unknown>;
  readonly acceptBulk: (socket: Socket.Socket) => Effect.Effect<void, unknown>;
}

interface Connection {
  readonly generation: number;
  readonly runner: AuthenticatedRunner;
  readonly runtime: ConnectionRuntime;
  readonly capacity: RunnerCapacity;
  readonly observedAt: number;
  /** Sessions with an environment on this runner, told when it becomes unreachable. */
  readonly sessions: ReadonlySet<string>;
}
interface ConnectionRuntime {
  readonly client: Client;
  readonly scope: Scope.Closeable;
}
interface BulkConnection {
  readonly runner: AuthenticatedRunner;
  readonly client: BulkClient;
  readonly scope: Scope.Closeable;
}
/** An environment is addressed by the runner its Session's placement names. */
export interface EnvironmentInput {
  workspaceId: WorkspaceId;
  runnerId: string;
  sessionId: string;
}
export interface CreateEnvironmentInput extends EnvironmentInput {
  payload: Omit<Parameters<Client["environment.create"]>[0], "sessionId">;
}
export interface ControlEnvironmentInput extends EnvironmentInput {
  payload: Omit<Parameters<Client["environment.control"]>[0], "sessionId">;
}

/** What a Session Durable Object learns about its runner environment (ADR 0006). */
export type EnvironmentNotice =
  | { readonly type: "changed"; readonly runnerId: string; readonly state: EnvironmentState }
  | { readonly type: "unreachable"; readonly runnerId: string }
  | { readonly type: "revoked"; readonly runnerId: string };

export interface EnvironmentObserver {
  readonly notify: (
    workspaceId: WorkspaceId,
    sessionId: string,
    notice: EnvironmentNotice,
  ) => Promise<void>;
}

interface RunnerSlot {
  readonly runner: AuthenticatedRunner;
  readonly control?: Connection;
  readonly bulk?: BulkConnection;
}
interface RegistryState {
  readonly nextGeneration: number;
  readonly runners: ReadonlyMap<string, RunnerSlot>;
}
type GatewayRepository = Pick<WorkspaceApi, "authenticateRunner">;
const OperationRejection = Schema.Union([
  CapacityExceeded,
  SessionConflict,
  EnvironmentNotFound,
  EnvironmentRejected,
]);

interface RegistryRuntime {
  readonly repository: GatewayRepository;
  readonly state: SynchronizedRef.SynchronizedRef<RegistryState>;
  readonly observer: EnvironmentObserver;
}

export const RunnerRegistry: Context.Service<RunnerRegistry, RunnerRegistry> = Context.Service(
  "@openorb/gateway/RunnerRegistry",
);

const ignoreEnvironments: EnvironmentObserver = { notify: () => Promise.resolve() };

export function makeRunnerRegistry(
  repository: GatewayRepository,
  observer: EnvironmentObserver = ignoreEnvironments,
): Effect.Effect<RunnerRegistry, never, Scope.Scope> {
  return Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<RegistryState>({
      nextGeneration: 1,
      runners: new Map(),
    });
    const runtime: RegistryRuntime = { repository, state, observer };
    yield* Effect.addFinalizer(() => closeRegistryConnections(runtime));
    return RunnerRegistry.of({
      accept: (socket) => Effect.scoped(accept(runtime, socket)),
      acceptBulk: (socket) => Effect.scoped(acceptBulk(runtime, socket)),
      getRunnerLiveState: (workspaceId, runnerId) =>
        getRunnerLiveState(runtime, workspaceId, runnerId),
      disconnectRunner: (workspaceId, runnerId) => disconnectRunner(runtime, workspaceId, runnerId),
      createEnvironment: (input) =>
        observeOperation("environment.create", input, createEnvironment(runtime, input)),
      controlEnvironment: (input) =>
        observeOperation("environment.control", input, controlEnvironment(runtime, input)),
      deleteEnvironment: (input) =>
        observeOperation("environment.delete", input, deleteEnvironment(runtime, input)),
    });
  });
}

export const runnerRegistryLayer = (
  repository: GatewayRepository,
  observer?: EnvironmentObserver,
) => Layer.effect(RunnerRegistry, makeRunnerRegistry(repository, observer));

const accept = Effect.fn("RunnerRegistry.accept")(function* (
  registry: RegistryRuntime,
  socket: Socket.Socket,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const { write } = yield* socket.writer;
  const reject = (code: number, reason: string) =>
    Effect.logWarning("connection.rejected").pipe(
      Effect.annotateLogs({ component: "openorb-gateway", closeCode: code, reason }),
      Effect.andThen(write(new Socket.CloseEvent(code, reason))),
    );
  const protocol = yield* RpcClientApi.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
    Effect.provideService(Socket.Socket, runnerControlWebSocket(socket)),
    Effect.provide(runnerControlRpcSerializationLayer),
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
  const authenticated = yield* authenticate(registry, identity.value);
  if (authenticated === undefined) {
    yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
    yield* Scope.close(scope, Exit.void);
    return;
  }
  const key = runnerKey(authenticated.workspaceId, authenticated.id);

  let ownedConnection: Connection | undefined;
  const admit = (event: Extract<RunnerStateEvent, { type: "snapshot" }>) =>
    Effect.gen(function* () {
      const [connection, old] = yield* SynchronizedRef.modify(registry.state, (current) => {
        const connection: Connection = {
          generation: current.nextGeneration,
          runner: authenticated,
          runtime: { client, scope },
          capacity: event.capacity,
          observedAt: event.observedAt,
          sessions: new Set(event.environments.map((environment) => environment.sessionId)),
        };
        const previous = current.runners.get(key);
        const runners = new Map(current.runners).set(key, {
          runner: authenticated,
          control: connection,
          ...(previous?.bulk === undefined ? {} : { bulk: previous.bulk }),
        });
        return [
          [connection, previous?.control] as const,
          { nextGeneration: current.nextGeneration + 1, runners },
        ] as const;
      });
      ownedConnection = connection;
      if (old) {
        yield* Effect.logInfo("connection.replaced").pipe(
          Effect.annotateLogs({
            component: "openorb-gateway",
            runnerId: authenticated.id,
            generation: connection.generation,
            previousGeneration: old.generation,
          }),
        );
        yield* Scope.close(old.runtime.scope, Exit.void);
      }
      // A revocation that raced the first authentication has closed nothing yet: check again.
      if ((yield* authenticate(registry, identity.value)) === undefined) {
        yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
        return yield* Effect.fail(new CandidateRejected());
      }
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("connection.connected").pipe(
        Effect.annotateLogs({
          component: "openorb-gateway",
          runnerId: authenticated.id,
          generation: connection.generation,
          environmentCount: event.environments.length,
          durationMs: now - startedAt,
        }),
      );
      // A reconnect tells each Session Durable Object its environment is reachable again.
      yield* Effect.forEach(
        event.environments,
        (environment) =>
          notifyEnvironment(registry, authenticated.workspaceId, environment.sessionId, {
            type: "changed",
            runnerId: authenticated.id,
            state: environment.state,
          }),
        { discard: true },
      );
    });

  yield* client["runner.watch"]().pipe(
    Stream.timeout(RUNNER_WATCH_INACTIVITY_TIMEOUT_MS),
    Stream.runForEach((event) => {
      if (ownedConnection !== undefined) return applyEvent(registry, ownedConnection, event);
      if (event.type === "snapshot") return admit(event);
      return reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON).pipe(
        Effect.andThen(Effect.fail(new CandidateRejected())),
      );
    }),
    Effect.tapError(() =>
      Effect.logWarning("connection.watch-failed").pipe(
        Effect.annotateLogs({
          component: "openorb-gateway",
          runnerId: authenticated.id,
          admitted: ownedConnection !== undefined,
        }),
      ),
    ),
    Effect.ensuring(
      Effect.suspend(() => {
        const owned = ownedConnection;
        if (owned === undefined) return Scope.close(scope, Exit.void);
        return removeConnection(registry, owned).pipe(
          Effect.andThen(
            Effect.logInfo("connection.disconnected").pipe(
              Effect.annotateLogs({
                component: "openorb-gateway",
                runnerId: authenticated.id,
                generation: owned.generation,
              }),
            ),
          ),
          Effect.andThen(Scope.close(scope, Exit.void)),
        );
      }),
    ),
    Effect.provideService(Scope.Scope, scope),
  );
});

/** The runner a token names, if it matches the identity and speaks this protocol. */
function authenticate(
  registry: RegistryRuntime,
  identity: { readonly token: string; readonly runnerId: string; readonly protocolVersion: number },
) {
  return Effect.tryPromise(() => registry.repository.authenticateRunner(identity.token)).pipe(
    Effect.map((runner) =>
      runner &&
      runner.id === identity.runnerId &&
      identity.protocolVersion === RUNNER_PROTOCOL_VERSION
        ? runner
        : undefined,
    ),
  );
}

const acceptBulk = Effect.fn("RunnerRegistry.acceptBulk")(function* (
  registry: RegistryRuntime,
  socket: Socket.Socket,
) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const { write } = yield* socket.writer;
  const reject = (code: number, reason: string) => write(new Socket.CloseEvent(code, reason));
  const protocol = yield* RpcClientApi.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provide(runnerBulkRpcSerializationLayer),
    Effect.provideService(Scope.Scope, scope),
  );
  const client = yield* RpcClientApi.make(RunnerBulkApi).pipe(
    Effect.provideService(RpcClientApi.Protocol, protocol),
    Effect.provideService(Scope.Scope, scope),
  );
  const identity = yield* client["runner.bulk.identify"]().pipe(
    Effect.timeoutOption(AUTHENTICATION_TIMEOUT_MS),
  );
  if (Option.isNone(identity)) {
    yield* reject(BOOTSTRAP_TIMEOUT_CLOSE_CODE, "Runner identification timed out");
    return;
  }
  const authenticated = yield* authenticate(registry, identity.value);
  if (authenticated === undefined) {
    yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
    return;
  }

  const connection: BulkConnection = { runner: authenticated, client, scope };
  const key = runnerKey(authenticated.workspaceId, authenticated.id);
  const old = yield* SynchronizedRef.modify(registry.state, (current) => {
    const previous = current.runners.get(key);
    const runners = new Map(current.runners).set(key, {
      runner: authenticated,
      ...(previous?.control === undefined ? {} : { control: previous.control }),
      bulk: connection,
    });
    return [previous?.bulk, { ...current, runners }] as const;
  });
  if (old !== undefined) yield* Scope.close(old.scope, Exit.void);
  // A revocation that raced the first authentication has closed nothing yet: check again.
  const confirmed = yield* authenticate(registry, identity.value);
  const watch: Effect.Effect<void, unknown> =
    confirmed === undefined
      ? reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON)
      : client["runner.bulk.watch"]().pipe(
          Stream.timeout(RUNNER_WATCH_INACTIVITY_TIMEOUT_MS),
          Stream.runDrain,
        );
  yield* watch.pipe(
    Effect.ensuring(
      SynchronizedRef.update(registry.state, (current) => {
        const slot = current.runners.get(key);
        if (slot?.bulk !== connection) return current;
        const runners = new Map(current.runners);
        if (slot.control === undefined) runners.delete(key);
        else runners.set(key, { runner: slot.runner, control: slot.control });
        return { ...current, runners };
      }),
    ),
    Effect.provideService(Scope.Scope, scope),
  );
});

function applyEvent(registry: RegistryRuntime, connection: Connection, event: RunnerStateEvent) {
  if (event.type === "snapshot") return Effect.void;
  const sessionId = event.type === "environment.changed" ? event.environment.sessionId : undefined;
  return updateConnection(registry, connection, (current) =>
    event.type === "runner.observed"
      ? { ...current, capacity: event.capacity, observedAt: event.observedAt }
      : { ...current, sessions: new Set(current.sessions).add(sessionId!) },
  ).pipe(
    Effect.andThen(
      event.type === "environment.changed"
        ? notifyEnvironment(registry, connection.runner.workspaceId, sessionId!, {
            type: "changed",
            runnerId: connection.runner.id,
            state: event.environment.state,
          })
        : Effect.void,
    ),
  );
}

/** Updates a runner's control connection, if `connection` is still its current one. */
function updateConnection(
  registry: RegistryRuntime,
  connection: Connection,
  update: (current: Connection) => Connection,
) {
  return SynchronizedRef.update(registry.state, (state) => {
    const key = runnerKey(connection.runner.workspaceId, connection.runner.id);
    const slot = state.runners.get(key);
    if (slot?.control?.generation !== connection.generation) return state;
    return {
      ...state,
      runners: new Map(state.runners).set(key, { ...slot, control: update(slot.control) }),
    };
  });
}

function removeConnection(registry: RegistryRuntime, connection: Connection) {
  return SynchronizedRef.modify(registry.state, (state) => {
    const key = runnerKey(connection.runner.workspaceId, connection.runner.id);
    const slot = state.runners.get(key);
    if (slot?.control?.generation !== connection.generation) {
      return [new Set<string>(), state] as const;
    }
    const runners = new Map(state.runners);
    if (slot.bulk === undefined) runners.delete(key);
    else runners.set(key, { runner: slot.runner, bulk: slot.bulk });
    return [slot.control.sessions, { ...state, runners }] as const;
  }).pipe(
    Effect.flatMap((lost) =>
      Effect.forEach(
        lost,
        (sessionId) =>
          notifyEnvironment(registry, connection.runner.workspaceId, sessionId, {
            type: "unreachable",
            runnerId: connection.runner.id,
          }),
        { discard: true },
      ),
    ),
  );
}

function getRunnerLiveState(registry: RegistryRuntime, workspaceId: WorkspaceId, runnerId: string) {
  return SynchronizedRef.get(registry.state).pipe(
    Effect.map((state) => {
      const connection = getControlConnection(state, workspaceId, runnerId);
      if (!connection) return null;
      return { capacity: connection.capacity, lastObservedAt: connection.observedAt };
    }),
  );
}

/** Closes a revoked runner's connections; its token no longer authenticates a new one. */
const disconnectRunner = Effect.fn("RunnerRegistry.disconnectRunner")(function* (
  registry: RegistryRuntime,
  workspaceId: WorkspaceId,
  runnerId: string,
) {
  const key = runnerKey(workspaceId, runnerId);
  const slot = yield* SynchronizedRef.modify(registry.state, (state) => {
    const runners = new Map(state.runners);
    runners.delete(key);
    return [state.runners.get(key), { ...state, runners }] as const;
  });
  if (slot === undefined) return false;
  yield* Effect.logInfo("connection.revoked").pipe(
    Effect.annotateLogs({
      component: "openorb-gateway",
      runnerId,
      ...(slot.control === undefined ? {} : { generation: slot.control.generation }),
    }),
  );
  yield* closeRunnerSlot(slot);
  // Revocation must also close Environment Links the runner dialed directly.
  yield* Effect.forEach(
    slot.control?.sessions ?? [],
    (sessionId) =>
      notifyEnvironment(registry, workspaceId, sessionId, { type: "revoked", runnerId }),
    { discard: true },
  );
  return true;
});

const closeRegistryConnections = Effect.fn("RunnerRegistry.close")(function* (
  registry: RegistryRuntime,
) {
  const slots = yield* SynchronizedRef.modify(registry.state, (state) => [
    Array.from(state.runners.values()),
    { ...state, runners: new Map() },
  ]);
  yield* Effect.forEach(slots, closeRunnerSlot, { concurrency: "unbounded", discard: true });
});

function closeRunnerSlot(slot: RunnerSlot) {
  return Effect.all(
    [
      slot.control === undefined ? Effect.void : Scope.close(slot.control.runtime.scope, Exit.void),
      slot.bulk === undefined ? Effect.void : Scope.close(slot.bulk.scope, Exit.void),
    ],
    { concurrency: "unbounded", discard: true },
  );
}

function observeOperation<A>(
  operation: string,
  input: { workspaceId: WorkspaceId; sessionId: string; runnerId?: string },
  effect: Effect.Effect<OperationResult<A>>,
): Effect.Effect<OperationResult<A>> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo(`${operation}.requested`);
    const result = yield* effect;
    const now = yield* Clock.currentTimeMillis;
    yield* (
      result.status === "accepted"
        ? Effect.logInfo(`${operation}.accepted`)
        : Effect.logWarning(`${operation}.${result.status}`)
    ).pipe(Effect.annotateLogs({ durationMs: now - startedAt }));
    return result;
  }).pipe(
    Effect.annotateLogs({
      component: "openorb-gateway",
      operation,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      ...(input.runnerId === undefined ? {} : { runnerId: input.runnerId }),
    }),
  );
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
function getControlConnection(state: RegistryState, workspaceId: WorkspaceId, runnerId: string) {
  return state.runners.get(runnerKey(workspaceId, runnerId))?.control;
}

class CandidateRejected extends Error {
  readonly _tag = "CandidateRejected";
}
function runnerKey(workspaceId: WorkspaceId, runnerId: string) {
  return `${workspaceId}:${runnerId}`;
}
// Environment-only Sessions (ADR 0006), addressed by the runner their placement names.

const ENVIRONMENT_NOTICE_TIMEOUT_MS = 5_000;

/** Bounded so a slow Session Durable Object cannot stall a runner's watch stream. */
function notifyEnvironment(
  registry: RegistryRuntime,
  workspaceId: WorkspaceId,
  sessionId: string,
  notice: EnvironmentNotice,
) {
  return Effect.tryPromise(() => registry.observer.notify(workspaceId, sessionId, notice)).pipe(
    Effect.timeout(ENVIRONMENT_NOTICE_TIMEOUT_MS),
    Effect.catchCause(() =>
      Effect.logWarning("environment.notice-failed").pipe(
        Effect.annotateLogs({
          component: "openorb-gateway",
          workspaceId,
          sessionId,
          notice: notice.type,
        }),
      ),
    ),
  );
}

/** Calls the runner, then records which Sessions it now hosts. */
function environmentCall<A>(
  registry: RegistryRuntime,
  input: EnvironmentInput,
  timeoutMs: number,
  call: (client: Client, sessionId: SessionId) => Effect.Effect<A, unknown>,
  hosted: (sessions: Set<string>) => void,
): Effect.Effect<OperationResult<A>> {
  return Effect.gen(function* () {
    const state = yield* SynchronizedRef.get(registry.state);
    const connection = getControlConnection(state, input.workspaceId, input.runnerId);
    if (connection === undefined) return unavailable("The environment's runner is offline.");
    const sessionId = Schema.decodeUnknownSync(SessionId)(input.sessionId);
    const result = yield* call(connection.runtime.client, sessionId).pipe(
      Effect.timeout(timeoutMs),
      Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
      Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
    );
    if (result.status === "accepted") {
      yield* updateConnection(registry, connection, (current) => {
        const sessions = new Set(current.sessions);
        hosted(sessions);
        return { ...current, sessions };
      });
    }
    return result;
  });
}

function createEnvironment(registry: RegistryRuntime, input: CreateEnvironmentInput) {
  return environmentCall(
    registry,
    input,
    OPERATION_TIMEOUT_MS,
    (client, sessionId) => client["environment.create"]({ ...input.payload, sessionId }),
    (sessions) => sessions.add(input.sessionId),
  );
}

function controlEnvironment(registry: RegistryRuntime, input: ControlEnvironmentInput) {
  // Starting waits for guest readiness, so it shares the cold continuation budget.
  return environmentCall(
    registry,
    input,
    COLD_CONTINUATION_TIMEOUT_MS,
    (client, sessionId) => client["environment.control"]({ ...input.payload, sessionId }),
    (sessions) => sessions.add(input.sessionId),
  );
}

function deleteEnvironment(registry: RegistryRuntime, input: EnvironmentInput) {
  return environmentCall(
    registry,
    input,
    COLD_CONTINUATION_TIMEOUT_MS,
    (client, sessionId) => client["environment.delete"]({ sessionId }),
    (sessions) => sessions.delete(input.sessionId),
  );
}
