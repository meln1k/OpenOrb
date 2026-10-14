import { test } from "vite-plus/test";
import { assert, assertEquals } from "@jsr/std__assert";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  EnvironmentControlled,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  RunnerCapacity,
  RunnerEnvironmentSnapshot,
  RunnerIdentity,
  RunnerStateEvent,
  SessionId,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";
import { RunnerBulkApi, runnerBulkRpcSerializationLayer } from "@openorb/protocol/runner-bulk-api";
import {
  runnerControlRpcSerializationLayer,
  runnerControlWebSocket,
} from "@openorb/protocol/runner-control-transport";
import { Deferred, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import { createRpcClient } from "./workspace/rpc-client.ts";

// Only point this at test/celld.jsonc: Workspace.fetch throws and all data is disposable.
const gatewayUrl = process.env["OPENORB_TEST_GATEWAY_URL"];
const decode = Schema.decodeUnknownSync;
const capacity = new RunnerCapacity({
  activeSessions: 1,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: 50_000,
});

function environment(sessionId: string, workspaceId: WorkspaceId) {
  return new RunnerEnvironmentSnapshot({
    sessionId: SessionId.make(sessionId),
    workspaceId,
    createdAt: "2026-10-08T12:00:00Z",
    orbSize: "small",
    state: "running",
  });
}

function endpoint(path: string, params: Record<string, string> = {}) {
  assert(gatewayUrl);
  const url = new URL(path, gatewayUrl);
  url.search = new URLSearchParams(params).toString();
  return url;
}

async function request(path: string, params: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(endpoint(path, params), {
    signal: AbortSignal.timeout(5_000),
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return response;
}

async function json(path: string, params: Record<string, string> = {}, body?: unknown) {
  const response = await request(path, params, body);
  assertEquals(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json();
}

const eventually = (predicate: () => Effect.Effect<boolean>, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (yield* predicate()) return;
      yield* Effect.sleep(30);
    }
    return yield* Effect.die(message);
  }).pipe(Effect.timeout("5 seconds"));

const makeProbe = Effect.fn(function* (identity: RunnerIdentity) {
  const stops: string[] = [];
  return {
    identity,
    events: yield* Queue.unbounded<RunnerStateEvent>(),
    identifyCalls: 0,
    watchCalls: 0,
    stops,
    closed: yield* Deferred.make<void>(),
    closeCode: yield* Deferred.make<number>(),
  };
});
type Probe = Effect.Success<ReturnType<typeof makeProbe>>;

function controlHandlers(probe: Probe) {
  const unused = () => Effect.die("Unexpected runner command");
  return RunnerApi.toLayer(
    RunnerApi.of({
      "runner.identify": () => Effect.sync(() => (probe.identifyCalls++, probe.identity)),
      "runner.watch": () => {
        probe.watchCalls++;
        return Stream.fromQueue(probe.events);
      },
      "environment.create": unused,
      "environment.control": ({ sessionId, action }) =>
        Effect.sync(() => {
          assertEquals(action, "stop");
          probe.stops.push(sessionId);
          return new EnvironmentControlled({ state: "stopped", forced: false });
        }),
      "environment.attach": unused,
      "environment.delete": unused,
    }),
  );
}

function bulkHandlers(probe: Probe) {
  return RunnerBulkApi.toLayer(
    RunnerBulkApi.of({
      "runner.bulk.identify": () => Effect.succeed(probe.identity),
      "runner.bulk.watch": () => {
        probe.watchCalls++;
        return Stream.make({ observedAt: 1 }).pipe(Stream.concat(Stream.never));
      },
    }),
  );
}

// Same synthetic outbound RPC-server adapter as runner-registry.test.ts, not a mock DO.
const connect = Effect.fn(function* (probe: Probe, bulk = false) {
  const url = endpoint(bulk ? "/api/runners/connect/bulk" : "/api/runners/connect");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const server = Layer.effect(
    SocketServer.SocketServer,
    Effect.map(Socket.Socket, (socket) => {
      const observe = <A, E, R>(effect: Effect.Effect<A, E | Socket.SocketError, R>) =>
        effect.pipe(
          Effect.tapError((error) =>
            Socket.isSocketError(error) && error.reason._tag === "SocketCloseError"
              ? Deferred.succeed(probe.closeCode, error.reason.code)
              : Effect.void,
          ),
        );
      const observed = Socket.make({
        reader: observe(
          Effect.map(socket.reader, (reader) => ({
            ...reader,
            pull: observe(reader.pull),
          })),
        ),
        writer: socket.writer,
      });
      return {
        address: NetAddress.socketAddressFromInputUnsafe({ address: "127.0.0.1", port: 0 }),
        run: <R, E, A>(
          handler: (socket: Socket.Socket) => Effect.Effect<A, E, R>,
        ): Effect.Effect<never, SocketServer.SocketServerError, R> =>
          handler(bulk ? observed : runnerControlWebSocket(observed)).pipe(
            Effect.ensuring(Deferred.succeed(probe.closed, undefined)),
            Effect.exit,
            Effect.andThen(Effect.never),
          ),
      } satisfies SocketServer.SocketServer["Service"];
    }),
  ).pipe(Layer.provide(NodeSocket.layerWebSocket(url.href)));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(server),
    Layer.provide(bulk ? runnerBulkRpcSerializationLayer : runnerControlRpcSerializationLayer),
  );
  const rpc = bulk
    ? RpcServer.layer(RunnerBulkApi).pipe(Layer.provide(bulkHandlers(probe)))
    : RpcServer.layer(RunnerApi).pipe(Layer.provide(controlHandlers(probe)));
  yield* Layer.launch(rpc.pipe(Layer.provide(protocol))).pipe(Effect.forkScoped);
});

const fixture = Effect.fn(function* () {
  assert(gatewayUrl);
  const workspace = createRpcClient(new URL("/__workspace", gatewayUrl).href);
  yield* Effect.promise(() => workspace.createAdministrator("rpc-fixture-password"));
  const identity = yield* Effect.promise(() =>
    workspace.verifyAdministratorPassword("rpc-fixture-password"),
  );
  assert(identity, "use a fresh disposable celld fixture");
  const workspaceId = identity.workspaceId;
  const enrollment = yield* Effect.promise(() => workspace.getRunnerEnrollmentToken(workspaceId));
  const enrolled = yield* Effect.promise(() =>
    workspace.enrollRunner({
      enrollmentPsk: enrollment.token,
      name: `Native ${crypto.randomUUID()}`,
      architecture: "x64",
    }),
  );
  assert(enrolled);
  const runnerParams = { workspaceId, runnerId: enrolled.runnerId };
  const environments = [crypto.randomUUID(), crypto.randomUUID()].map((id) =>
    environment(id, workspaceId),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await workspace.revokeRunner(workspaceId, enrolled.runnerId);
      await json("/__registry/disconnect", {}, runnerParams);
      await workspace.deleteRunner(workspaceId, enrolled.runnerId);
    }).pipe(Effect.timeout("5 seconds"), Effect.orDie),
  );
  const runnerIdentity = decode(RunnerIdentity)({
    token: enrolled.runnerToken,
    runnerId: enrolled.runnerId,
    runnerVersion: "native-test",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  });
  const probe = yield* makeProbe(runnerIdentity);
  return { workspace, workspaceId, runnerParams, environments, probe };
});

const publish = (probe: Probe, environments: RunnerEnvironmentSnapshot[], revision = 1) =>
  Effect.forEach(
    [
      ...environments.map((environment) => ({
        type: "snapshot.environment" as const,
        environment,
      })),
      {
        type: "snapshot.complete" as const,
        revision,
        environmentCount: environments.length,
        observedAt: revision,
        capacity,
      },
    ],
    (event) => Queue.offer(probe.events, decode(RunnerStateEvent)(event)),
    { discard: true },
  );

/** The routed environment as native RPC returns it: a plain record, not a Schema.Class. */
const routedEnvironment = (runnerId: string, environment: RunnerEnvironmentSnapshot) => ({
  runnerId,
  environment: { ...environment },
});

const admitted = (params: Record<string, string>) =>
  eventually(
    () => Effect.promise(async () => (await json("/__registry/live", params)) !== null),
    "native control manifest was not admitted",
  );

test(
  "native celld Runners admits environments, routes control, replaces connections and revokes",
  { skip: !gatewayUrl, timeout: 120_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const [first, second] = f.environments;
          assert(first && second);
          const runnerId = f.runnerParams.runnerId;
          const firstParams = { workspaceId: f.workspaceId, sessionId: first.sessionId };
          const secondParams = { workspaceId: f.workspaceId, sessionId: second.sessionId };
          const routed = (params: Record<string, string>) =>
            Effect.promise(() => json("/__registry/environment", params));
          yield* connect(f.probe);
          yield* eventually(
            () => Effect.sync(() => f.probe.watchCalls === 1),
            "runner.watch did not start",
          );
          assertEquals(yield* Effect.promise(() => json("/__registry/live", f.runnerParams)), null);
          yield* publish(f.probe, [first]);
          yield* admitted(f.runnerParams);
          assertEquals(yield* routed(firstParams), routedEnvironment(runnerId, first));
          assertEquals(
            yield* Effect.promise(() =>
              json("/__registry/environment/control", {}, { ...firstParams, action: "stop" }),
            ),
            { status: "accepted", acknowledgement: { state: "stopped", forced: false } },
          );
          assertEquals(f.probe.stops, [first.sessionId]);
          assertEquals(f.probe.identifyCalls, 1);
          const foreign = { ...firstParams, workspaceId: crypto.randomUUID() };
          assertEquals(yield* routed(foreign), null);
          assertEquals(
            (yield* Effect.promise(() =>
              json("/__registry/environment/control", {}, { ...foreign, action: "stop" }),
            )).status,
            "unavailable",
          );
          assertEquals(f.probe.stops, [first.sessionId]);
          for (const identity of [
            decode(RunnerIdentity)({ ...f.probe.identity, token: "openorb_runner_invalid" }),
            decode(RunnerIdentity)({
              ...f.probe.identity,
              protocolVersion: RUNNER_PROTOCOL_VERSION - 1,
            }),
          ]) {
            const rejected = yield* makeProbe(identity);
            yield* connect(rejected);
            assertEquals(
              yield* Deferred.await(rejected.closeCode).pipe(Effect.timeout("3 seconds")),
              4401,
            );
            assertEquals(rejected.watchCalls, 0);
          }
          const replacement = yield* makeProbe(f.probe.identity);
          yield* connect(replacement);
          yield* eventually(
            () => Effect.sync(() => replacement.watchCalls === 1),
            "replacement watch missing",
          );
          assertEquals(yield* routed(firstParams), routedEnvironment(runnerId, first));
          yield* publish(replacement, [second], 10);
          yield* eventually(
            () => Effect.map(routed(secondParams), (route) => route !== null),
            "replacement environments missing",
          );
          assertEquals(yield* routed(firstParams), null);
          assertEquals(
            yield* Effect.promise(() =>
              f.workspace.revokeRunner(f.workspaceId, f.runnerParams.runnerId),
            ),
            "revoked",
          );
          assertEquals(
            yield* Effect.promise(() => json("/__registry/disconnect", {}, f.runnerParams)),
            true,
          );
          assertEquals(yield* Effect.promise(() => json("/__registry/live", f.runnerParams)), null);
          assertEquals(yield* routed(secondParams), null);
          const revoked = yield* makeProbe(f.probe.identity);
          yield* connect(revoked);
          assertEquals(
            yield* Deferred.await(revoked.closeCode).pipe(Effect.timeout("3 seconds")),
            4401,
          );
          assertEquals(revoked.watchCalls, 0);
        }).pipe(Effect.timeout("30 seconds")),
      ),
    ),
);

test(
  "native celld Runners revocation closes control and bulk peer connections",
  { skip: !gatewayUrl, timeout: 120_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* connect(f.probe);
          yield* publish(f.probe, [f.environments[0]!]);
          yield* admitted(f.runnerParams);
          const bulk = yield* makeProbe(f.probe.identity);
          yield* connect(bulk, true);
          yield* eventually(
            () => Effect.sync(() => bulk.watchCalls === 1),
            "bulk watch did not start",
          );
          assertEquals(
            yield* Effect.promise(() =>
              f.workspace.revokeRunner(f.workspaceId, f.runnerParams.runnerId),
            ),
            "revoked",
          );
          assertEquals(
            yield* Effect.promise(() => json("/__registry/disconnect", {}, f.runnerParams)),
            true,
          );
          assertEquals(yield* Effect.promise(() => json("/__registry/live", f.runnerParams)), null);
          yield* eventually(
            () =>
              Effect.gen(function* () {
                const controlClosed = Option.isSome(yield* Deferred.poll(f.probe.closed));
                const bulkClosed = Option.isSome(yield* Deferred.poll(bulk.closed));
                return controlClosed && bulkClosed;
              }),
            "Revocation did not close peer WebSockets",
          ).pipe(
            Effect.catchCause(() =>
              Effect.gen(function* () {
                const controlClosed = Option.isSome(yield* Deferred.poll(f.probe.closed));
                const bulkClosed = Option.isSome(yield* Deferred.poll(bulk.closed));
                return yield* Effect.die(
                  `Revocation removed registry state but peer cleanup failed: controlClosed=${controlClosed}, bulkClosed=${bulkClosed}`,
                );
              }),
            ),
          );
        }).pipe(Effect.timeout("20 seconds")),
      ),
    ),
);
