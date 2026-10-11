import { RunnerBulkApi, runnerBulkRpcSerializationLayer } from "@openorb/protocol/runner-bulk-api";
import {
  CapacityExceeded,
  type EnvironmentAttachAccepted,
  EnvironmentAttachNonce,
  type EnvironmentControlled,
  type EnvironmentCreated,
  type EnvironmentDeleted,
  EnvironmentNotFound,
  EnvironmentRejected,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  type RunnerCapacity,
  type RunnerEnvironmentSnapshot,
  type RunnerStateEvent,
  SessionConflict,
  SessionId,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";
import { orbSizeResources } from "@openorb/protocol";
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
// Session Durable Objects; a runner only reports its environments and capacity.

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
  readonly getEnvironment: (
    workspaceId: WorkspaceId,
    sessionId: string,
  ) => Effect.Effect<RoutedEnvironment | null>;
  readonly createEnvironment: (
    input: CreateEnvironmentInput,
  ) => Effect.Effect<OperationResult<EnvironmentCreated>>;
  readonly controlEnvironment: (
    input: ControlEnvironmentInput,
  ) => Effect.Effect<OperationResult<EnvironmentControlled>>;
  readonly attachEnvironment: (
    input: AttachEnvironmentInput,
  ) => Effect.Effect<OperationResult<EnvironmentAttachAccepted>>;
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
  readonly revision: number;
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
export interface EnvironmentInput {
  workspaceId: WorkspaceId;
  sessionId: string;
}
export interface CreateEnvironmentInput {
  workspaceId: WorkspaceId;
  runnerId: string;
  sessionId: string;
  payload: Omit<Parameters<Client["environment.create"]>[0], "sessionId" | "workspaceId">;
}
export interface ControlEnvironmentInput extends EnvironmentInput {
  payload: Omit<Parameters<Client["environment.control"]>[0], "sessionId">;
}
export interface AttachEnvironmentInput extends EnvironmentInput {
  nonce: string;
}
export interface RoutedEnvironment {
  readonly runnerId: string;
  readonly environment: RunnerEnvironmentSnapshot;
}

/** What a Session Durable Object learns about its runner environment (ADR 0006). */
export type EnvironmentNotice =
  | {
    readonly type: "updated";
    readonly runnerId: string;
    readonly environment: RunnerEnvironmentSnapshot;
  }
  | { readonly type: "removed"; readonly runnerId: string }
  | { readonly type: "unreachable"; readonly runnerId: string }
  | { readonly type: "revoked"; readonly runnerId: string };

export interface EnvironmentObserver {
  readonly notify: (
    workspaceId: WorkspaceId,
    sessionId: string,
    notice: EnvironmentNotice,
  ) => Promise<void>;
}

interface EnvironmentRoute {
  readonly runnerId: string;
  readonly generation: number;
  readonly environment: RunnerEnvironmentSnapshot;
}

interface RunnerSlot {
  readonly runner: AuthenticatedRunner;
  readonly control?: Connection;
  readonly bulk?: BulkConnection;
}
interface RegistryState {
  readonly nextGeneration: number;
  readonly runners: ReadonlyMap<string, RunnerSlot>;
  readonly revoked: ReadonlySet<string>;
  /** Keyed by Workspace and Session; valid only for the connection generation that reported it. */
  readonly environments: ReadonlyMap<string, EnvironmentRoute>;
}
type BulkAdmission =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly old?: BulkConnection };
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
      revoked: new Set(),
      environments: new Map(),
    });
    const runtime: RegistryRuntime = { repository, state, observer };
    yield* Effect.addFinalizer(() => closeRegistryConnections(runtime));
    return RunnerRegistry.of({
      accept: (socket) => Effect.scoped(accept(runtime, socket)),
      acceptBulk: (socket) => Effect.scoped(acceptBulk(runtime, socket)),
      getRunnerLiveState: (workspaceId, runnerId) =>
        getRunnerLiveState(runtime, workspaceId, runnerId),
      disconnectRunner: (workspaceId, runnerId) => disconnectRunner(runtime, workspaceId, runnerId),
      getEnvironment: (workspaceId, sessionId) =>
        routeEnvironment(runtime, workspaceId, sessionId).pipe(
          Effect.map((routed) =>
            routed.status === "routed"
              ? { runnerId: routed.route.runnerId, environment: routed.route.environment }
              : null
          ),
        ),
      createEnvironment: (input) =>
        observeOperation("environment.create", input, createEnvironment(runtime, input)),
      controlEnvironment: (input) =>
        observeOperation("environment.control", input, controlEnvironment(runtime, input)),
      attachEnvironment: (input) =>
        observeOperation("environment.attach", input, attachEnvironment(runtime, input)),
      deleteEnvironment: (input) =>
        observeOperation("environment.delete", input, deleteEnvironment(runtime, input)),
    });
  });
}

export const runnerRegistryLayer = (
  repository: GatewayRepository,
  observer?: EnvironmentObserver,
) => Layer.effect(RunnerRegistry, makeRunnerRegistry(repository, observer));

const accept = Effect.fn("RunnerRegistry.accept")(
  function* (registry: RegistryRuntime, socket: Socket.Socket) {
    const startedAt = yield* Clock.currentTimeMillis;
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const { write } = yield* socket.writer;
    const reject = (code: number, reason: string) =>
      Effect.logWarning("connection.rejected").pipe(
        Effect.annotateLogs({ component: "openorb-gateway", closeCode: code, reason }),
        Effect.andThen(write(new Socket.CloseEvent(code, reason))),
      );
    const protocol = yield* RpcClientApi.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) })
      .pipe(
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
    const authenticated = yield* Effect.tryPromise(() =>
      registry.repository.authenticateRunner(identity.value.token)
    );
    const state = yield* SynchronizedRef.get(registry.state);
    if (
      !authenticated || authenticated.id !== identity.value.runnerId ||
      identity.value.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
      state.revoked.has(runnerKey(authenticated.workspaceId, authenticated.id))
    ) {
      yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
      yield* Scope.close(scope, Exit.void);
      return;
    }

    const initialEnvironments: RunnerEnvironmentSnapshot[] = [];
    let complete: {
      capacity: RunnerCapacity;
      revision: number;
      observedAt: number;
      environmentCount: number;
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
          if (event.type === "snapshot.environment") {
            initialEnvironments.push(event.environment);
            return;
          }
          if (event.type !== "snapshot.complete") {
            yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
            return yield* Effect.fail(new CandidateRejected());
          }
          const completed = event;
          complete = completed;
          if (
            complete.environmentCount !== initialEnvironments.length ||
            new Set(initialEnvironments.map((x) => x.sessionId)).size !==
              initialEnvironments.length ||
            // Tenant isolation: a runner reports only its own Workspace's environments.
            initialEnvironments.some((x) => x.workspaceId !== authenticated.workspaceId)
          ) {
            yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
            return yield* Effect.fail(new CandidateRejected());
          }
          const connectionRuntime: ConnectionRuntime = { client, scope };
          const [connection, old] = yield* SynchronizedRef.modifyEffect(
            registry.state,
            (current) => {
              const key = runnerKey(authenticated.workspaceId, authenticated.id);
              if (current.revoked.has(key)) return Effect.fail(new CandidateRejected());
              const connection: Connection = {
                generation: current.nextGeneration,
                runner: authenticated,
                runtime: connectionRuntime,
                capacity: completed.capacity,
                revision: completed.revision,
                observedAt: completed.observedAt,
              };
              const previousSlot = current.runners.get(key);
              const previous = previousSlot?.control;
              const runners = new Map(current.runners).set(key, {
                runner: authenticated,
                control: connection,
                ...(previousSlot?.bulk === undefined ? {} : { bulk: previousSlot.bulk }),
              });
              const environments = new Map(current.environments);
              for (const [id, route] of environments) {
                if (route.runnerId === authenticated.id) environments.delete(id);
              }
              for (const environment of initialEnvironments) {
                environments.set(routeKey(authenticated.workspaceId, environment.sessionId), {
                  runnerId: authenticated.id,
                  generation: connection.generation,
                  environment,
                });
              }
              return Effect.succeed(
                [[connection, previous] as const, {
                  ...current,
                  nextGeneration: current.nextGeneration + 1,
                  runners,
                  environments,
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
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.logInfo("snapshot.accepted").pipe(Effect.annotateLogs({
            component: "openorb-gateway",
            runnerId: authenticated.id,
            generation: connection.generation,
            environmentCount: initialEnvironments.length,
            durationMs: now - startedAt,
          }));
          yield* Effect.logInfo("connection.connected").pipe(Effect.annotateLogs({
            component: "openorb-gateway",
            runnerId: authenticated.id,
            generation: connection.generation,
          }));
          if (old) {
            yield* Effect.logInfo("connection.replaced").pipe(Effect.annotateLogs({
              component: "openorb-gateway",
              runnerId: authenticated.id,
              generation: connection.generation,
              previousGeneration: old.generation,
            }));
            yield* Scope.close(old.runtime.scope, Exit.void);
          }
          // A reconnect tells each Session Durable Object its environment is reachable again.
          yield* Effect.forEach(
            initialEnvironments,
            (environment) =>
              notifyEnvironment(registry, authenticated.workspaceId, environment.sessionId, {
                type: "updated",
                runnerId: authenticated.id,
                environment,
              }),
            { discard: true },
          );
        }),
    ).pipe(
      Effect.tapError(() =>
        Effect.logWarning("connection.watch-failed").pipe(
          Effect.annotateLogs({
            component: "openorb-gateway",
            runnerId: authenticated.id,
            admitted: ownedConnection !== undefined,
          }),
        )
      ),
      Effect.ensuring(Effect.suspend(() => {
        const remove = ownedConnection ? removeConnection(registry, ownedConnection) : Effect.void;
        return remove.pipe(
          Effect.andThen(
            ownedConnection
              ? Effect.logInfo("connection.disconnected").pipe(
                Effect.annotateLogs({
                  component: "openorb-gateway",
                  runnerId: authenticated.id,
                  generation: ownedConnection.generation,
                }),
              )
              : Effect.void,
          ),
          Effect.andThen(Scope.close(scope, Exit.void)),
        );
      })),
      Effect.provideService(Scope.Scope, scope),
    );
  },
);

const acceptBulk = Effect.fn("RunnerRegistry.acceptBulk")(
  function* (registry: RegistryRuntime, socket: Socket.Socket) {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const { write } = yield* socket.writer;
    const reject = (code: number, reason: string) => write(new Socket.CloseEvent(code, reason));
    const protocol = yield* RpcClientApi.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) })
      .pipe(
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
    const authenticated = yield* Effect.tryPromise(() =>
      registry.repository.authenticateRunner(identity.value.token)
    );
    const state = yield* SynchronizedRef.get(registry.state);
    if (
      !authenticated || authenticated.id !== identity.value.runnerId ||
      identity.value.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
      state.revoked.has(runnerKey(authenticated.workspaceId, authenticated.id))
    ) {
      yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
      return;
    }

    const connection: BulkConnection = { runner: authenticated, client, scope };
    const key = runnerKey(authenticated.workspaceId, authenticated.id);
    const admitted = yield* SynchronizedRef.modify(
      registry.state,
      (current): readonly [BulkAdmission, RegistryState] => {
        if (current.revoked.has(key)) {
          return [{ accepted: false as const }, current] as const;
        }
        const previous = current.runners.get(key);
        const runners = new Map(current.runners).set(key, {
          runner: authenticated,
          ...(previous?.control === undefined ? {} : { control: previous.control }),
          bulk: connection,
        });
        return [{
          accepted: true as const,
          ...(previous?.bulk === undefined ? {} : { old: previous.bulk }),
        }, { ...current, runners }] as const;
      },
    );
    if (!admitted.accepted) {
      yield* reject(PERMANENT_REJECTION_CLOSE_CODE, REJECTION_REASON);
      return;
    }
    if (admitted.old !== undefined) yield* Scope.close(admitted.old.scope, Exit.void);
    yield* client["runner.bulk.watch"]().pipe(
      Stream.timeout(RUNNER_WATCH_INACTIVITY_TIMEOUT_MS),
      Stream.runDrain,
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
  },
);

function applyEvent(
  registry: RegistryRuntime,
  connection: Connection,
  event: typeof RunnerStateEvent.Type,
) {
  if (event.type === "environment.updated" || event.type === "environment.removed") {
    return applyEnvironmentEvent(registry, connection, event);
  }
  if (event.type !== "runner.observed") return Effect.void;
  return SynchronizedRef.update(registry.state, (state) => {
    const current = getControlConnection(
      state,
      connection.runner.workspaceId,
      connection.runner.id,
    );
    if (current?.generation !== connection.generation || event.revision <= current.revision) {
      return state;
    }
    const updated: Connection = {
      ...current,
      capacity: event.capacity,
      observedAt: event.observedAt,
      revision: event.revision,
    };
    return { ...state, runners: replaceSlotControl(state.runners, current, updated) };
  });
}

function removeConnection(registry: RegistryRuntime, connection: Connection) {
  return SynchronizedRef.modify(registry.state, (state) => {
    const key = runnerKey(connection.runner.workspaceId, connection.runner.id);
    const slot = state.runners.get(key);
    if (slot?.control?.generation !== connection.generation) {
      const lost: string[] = [];
      return [lost, state] as const;
    }
    const runners = new Map(state.runners);
    if (slot.bulk === undefined) runners.delete(key);
    else runners.set(key, { runner: slot.runner, bulk: slot.bulk });
    const [environments, lost] = withoutGeneration(state.environments, connection.generation);
    return [lost, { ...state, runners, environments }] as const;
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
      )
    ),
  );
}

function getRunnerLiveState(registry: RegistryRuntime, workspaceId: WorkspaceId, runnerId: string) {
  return SynchronizedRef.get(registry.state).pipe(Effect.map((state) => {
    const connection = getControlConnection(state, workspaceId, runnerId);
    if (!connection) return null;
    return { capacity: connection.capacity, lastObservedAt: connection.observedAt };
  }));
}

const disconnectRunner = Effect.fn("RunnerRegistry.disconnectRunner")(
  function* (registry: RegistryRuntime, workspaceId: WorkspaceId, runnerId: string) {
    const key = runnerKey(workspaceId, runnerId);
    const slot = yield* SynchronizedRef.modify(
      registry.state,
      (state) => {
        const slot = state.runners.get(key);
        const runners = new Map(state.runners);
        runners.delete(key);
        const environments = new Map(state.environments);
        const revokedSessions: string[] = [];
        for (const [id, route] of environments) {
          if (route.runnerId === runnerId && id.startsWith(`${workspaceId}:`)) {
            environments.delete(id);
            revokedSessions.push(route.environment.sessionId);
          }
        }
        return [{ slot, revokedSessions }, {
          ...state,
          runners,
          environments,
          revoked: new Set(state.revoked).add(key),
        }] as const;
      },
    ).pipe(
      Effect.tap(({ revokedSessions }) =>
        // Revocation must also close Environment Links the runner dialed directly.
        Effect.forEach(
          revokedSessions,
          (sessionId) =>
            notifyEnvironment(registry, workspaceId, sessionId, { type: "revoked", runnerId }),
          { discard: true },
        )
      ),
      Effect.map(({ slot }) => slot),
    );
    if (slot === undefined) return false;
    yield* Effect.logInfo("connection.revoked").pipe(Effect.annotateLogs({
      component: "openorb-gateway",
      runnerId,
      ...(slot.control === undefined ? {} : { generation: slot.control.generation }),
    }));
    yield* closeRunnerSlot(slot);
    return true;
  },
);

const closeRegistryConnections = Effect.fn("RunnerRegistry.close")(
  function* (registry: RegistryRuntime) {
    const slots = yield* SynchronizedRef.modify(registry.state, (state) => [
      Array.from(state.runners.values()),
      { ...state, runners: new Map() },
    ]);
    yield* Effect.forEach(slots, closeRunnerSlot, { concurrency: "unbounded", discard: true });
  },
);

function closeRunnerSlot(slot: RunnerSlot) {
  return Effect.all([
    slot.control === undefined ? Effect.void : Scope.close(slot.control.runtime.scope, Exit.void),
    slot.bulk === undefined ? Effect.void : Scope.close(slot.bulk.scope, Exit.void),
  ], { concurrency: "unbounded", discard: true });
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
    yield* (result.status === "accepted"
      ? Effect.logInfo(`${operation}.accepted`)
      : Effect.logWarning(`${operation}.${result.status}`)).pipe(
        Effect.annotateLogs({ durationMs: now - startedAt }),
      );
    return result;
  }).pipe(Effect.annotateLogs({
    component: "openorb-gateway",
    operation,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    ...(input.runnerId === undefined ? {} : { runnerId: input.runnerId }),
  }));
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
function replaceSlotControl(
  runners: ReadonlyMap<string, RunnerSlot>,
  previous: Connection,
  next: Connection,
) {
  const key = runnerKey(previous.runner.workspaceId, previous.runner.id);
  const slot = runners.get(key);
  if (slot?.control !== previous) return runners;
  return new Map(runners).set(key, {
    runner: slot.runner,
    control: next,
    ...(slot.bulk === undefined ? {} : { bulk: slot.bulk }),
  });
}
function getControlConnection(
  state: RegistryState,
  workspaceId: WorkspaceId,
  runnerId: string,
) {
  return state.runners.get(runnerKey(workspaceId, runnerId))?.control;
}
function runnerSupportsOrbSize(
  capacity: RunnerCapacity,
  orbSize: CreateEnvironmentInput["payload"]["orbSize"],
) {
  const resources = orbSizeResources(orbSize);
  return resources.cpuCount <= capacity.vmCpuCount && resources.memoryMiB <= capacity.vmMemoryMiB;
}

class CandidateRejected extends Error {}
function runnerKey(workspaceId: WorkspaceId, runnerId: string) {
  return `${workspaceId}:${runnerId}`;
}
function routeKey(workspaceId: WorkspaceId, sessionId: string) {
  return `${workspaceId}:${sessionId}`;
}

// Environment-only Sessions (ADR 0006). A route is valid only while the connection generation
// that reported it is the runner's current control connection.

type RoutedEnvironmentResult =
  | {
    readonly status: "routed";
    readonly route: EnvironmentRoute;
    readonly connection: Connection;
  }
  | { readonly status: "unavailable"; readonly message: string };

const ENVIRONMENT_NOTICE_TIMEOUT_MS = 5_000;

function withoutGeneration(
  environments: ReadonlyMap<string, EnvironmentRoute>,
  generation: number,
): readonly [ReadonlyMap<string, EnvironmentRoute>, string[]] {
  const remaining = new Map(environments);
  const lost: string[] = [];
  for (const [id, route] of environments) {
    if (route.generation === generation) {
      remaining.delete(id);
      lost.push(route.environment.sessionId);
    }
  }
  return [remaining, lost];
}

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
      Effect.logWarning("environment.notice-failed").pipe(Effect.annotateLogs({
        component: "openorb-gateway",
        workspaceId,
        sessionId,
        notice: notice.type,
      }))
    ),
  );
}

function applyEnvironmentEvent(
  registry: RegistryRuntime,
  connection: Connection,
  event: Extract<
    typeof RunnerStateEvent.Type,
    { type: "environment.updated" | "environment.removed" }
  >,
) {
  const workspaceId = connection.runner.workspaceId;
  const sessionId = event.type === "environment.updated"
    ? event.environment.sessionId
    : event.sessionId;
  return SynchronizedRef.modify(registry.state, (state) => {
    const current = getControlConnection(state, workspaceId, connection.runner.id);
    if (current?.generation !== connection.generation) return [false, state] as const;
    if (event.type === "environment.updated" && event.environment.workspaceId !== workspaceId) {
      return [false, state] as const;
    }
    const environments = new Map(state.environments);
    const key = routeKey(workspaceId, sessionId);
    if (event.type === "environment.removed") environments.delete(key);
    else {
      environments.set(key, {
        runnerId: connection.runner.id,
        generation: connection.generation,
        environment: event.environment,
      });
    }
    return [true, { ...state, environments }] as const;
  }).pipe(
    Effect.flatMap((applied) =>
      applied
        ? notifyEnvironment(
          registry,
          workspaceId,
          sessionId,
          event.type === "environment.updated"
            ? { type: "updated", runnerId: connection.runner.id, environment: event.environment }
            : { type: "removed", runnerId: connection.runner.id },
        )
        : Effect.void
    ),
  );
}

function routeEnvironment(
  registry: RegistryRuntime,
  workspaceId: WorkspaceId,
  sessionId: string,
): Effect.Effect<RoutedEnvironmentResult> {
  return SynchronizedRef.get(registry.state).pipe(
    Effect.map((state): RoutedEnvironmentResult => {
      const route = state.environments.get(routeKey(workspaceId, sessionId));
      const connection = route && getControlConnection(state, workspaceId, route.runnerId);
      if (!route || connection?.generation !== route.generation) {
        return { status: "unavailable", message: "The environment's runner is offline." };
      }
      return { status: "routed", route, connection };
    }),
  );
}

const createEnvironment = Effect.fn("RunnerRegistry.createEnvironment")(
  function* (registry: RegistryRuntime, input: CreateEnvironmentInput) {
    const state = yield* SynchronizedRef.get(registry.state);
    const connection = getControlConnection(state, input.workspaceId, input.runnerId);
    if (!connection) return unavailable("The selected runner is offline.");
    if (!runnerSupportsOrbSize(connection.capacity, input.payload.orbSize)) {
      return { status: "rejected" as const, message: "The runner cannot host this orb size." };
    }
    const sessionId = Schema.decodeUnknownSync(SessionId)(input.sessionId);
    const result = yield* connection.runtime.client["environment.create"]({
      ...input.payload,
      sessionId,
      workspaceId: input.workspaceId,
    }).pipe(
      Effect.timeout(OPERATION_TIMEOUT_MS),
      Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
      Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
    );
    if (result.status === "accepted") {
      // The watch stream reports the same environment; recording it here routes it immediately.
      yield* SynchronizedRef.update(registry.state, (current) => {
        const live = getControlConnection(current, input.workspaceId, input.runnerId);
        if (live?.generation !== connection.generation) return current;
        return {
          ...current,
          environments: new Map(current.environments).set(
            routeKey(input.workspaceId, sessionId),
            {
              runnerId: input.runnerId,
              generation: connection.generation,
              environment: result.acknowledgement.environment,
            },
          ),
        };
      });
    }
    return result;
  },
);

function routedEnvironmentCall<A>(
  registry: RegistryRuntime,
  input: EnvironmentInput,
  timeoutMs: number,
  call: (client: Client, sessionId: SessionId) => Effect.Effect<A, unknown>,
): Effect.Effect<OperationResult<A>> {
  return routeEnvironment(registry, input.workspaceId, input.sessionId).pipe(
    Effect.flatMap((routed) => {
      if (routed.status === "unavailable") return Effect.succeed(unavailable(routed.message));
      const sessionId = Schema.decodeUnknownSync(SessionId)(input.sessionId);
      return call(routed.connection.runtime.client, sessionId).pipe(
        Effect.timeout(timeoutMs),
        Effect.map((acknowledgement) => ({ status: "accepted" as const, acknowledgement })),
        Effect.catchCause((cause) => Effect.succeed(operationFailure(cause, true))),
      );
    }),
  );
}

function controlEnvironment(registry: RegistryRuntime, input: ControlEnvironmentInput) {
  // Starting waits for guest readiness, so it shares the cold continuation budget.
  return routedEnvironmentCall(
    registry,
    input,
    COLD_CONTINUATION_TIMEOUT_MS,
    (client, sessionId) => client["environment.control"]({ ...input.payload, sessionId }),
  );
}

function attachEnvironment(registry: RegistryRuntime, input: AttachEnvironmentInput) {
  return routedEnvironmentCall(
    registry,
    input,
    COLD_CONTINUATION_TIMEOUT_MS,
    (client, sessionId) =>
      client["environment.attach"]({
        sessionId,
        nonce: Schema.decodeUnknownSync(EnvironmentAttachNonce)(input.nonce),
      }),
  );
}

function deleteEnvironment(registry: RegistryRuntime, input: EnvironmentInput) {
  return routedEnvironmentCall(
    registry,
    input,
    COLD_CONTINUATION_TIMEOUT_MS,
    (client, sessionId) => client["environment.delete"]({ sessionId }),
  ).pipe(
    Effect.tap((result) =>
      result.status === "accepted"
        ? SynchronizedRef.update(registry.state, (state) => {
          const environments = new Map(state.environments);
          environments.delete(routeKey(input.workspaceId, input.sessionId));
          return { ...state, environments };
        })
        : Effect.void
    ),
  );
}
