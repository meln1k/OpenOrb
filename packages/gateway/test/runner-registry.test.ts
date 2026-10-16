import { createServer } from "node:http";
import { test } from "vite-plus/test";
import { assert, assertEquals } from "@jsr/std__assert";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  ControlEnvironmentPayload,
  CreateEnvironmentPayload,
  DeleteEnvironmentPayload,
  EnvironmentControlled,
  EnvironmentCreated,
  EnvironmentDeleted,
  EnvironmentRejected,
  GitAuthor,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  RunnerCapacity,
  RunnerEnvironmentSnapshot,
  RunnerIdentity,
  RunnerStateEvent,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { RunnerBulkApi, runnerBulkRpcSerializationLayer } from "@openorb/protocol/runner-bulk-api";
import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Queue,
  Schema,
  Stream,
} from "effect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import {
  runnerControlRpcSerializationLayer,
  runnerControlWebSocket,
} from "@openorb/protocol/runner-control-transport";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";

import {
  type EnvironmentNotice,
  type EnvironmentObserver,
  makeRunnerRegistry,
  PERMANENT_REJECTION_CLOSE_CODE,
} from "../app/cells/runners/runner-registry.ts";
import type { WorkspaceApi } from "../app/cells/workspace/api.ts";

const WORKSPACE_ID = WorkspaceId.make("018f47f2-39b1-7b30-8000-000000000000");
const FOREIGN_WORKSPACE_ID = WorkspaceId.make("018f47f2-39b1-7b30-8000-000000000099");
const RUNNER_ID = "018f47f2-39b1-7b30-8000-000000000001";
const SESSION_1 = "018f47f2-39b1-7b30-8000-000000000011";
const SESSION_2 = "018f47f2-39b1-7b30-8000-000000000012";
const TOKEN = "openorb_runner_test-token";
const GITHUB_TOKEN = "github-secret-token";
const REPOSITORY_URL = "https://github.com/openorb/test.git";
const GIT_AUTHOR = new GitAuthor({ name: "OpenOrb User", email: "user@example.com" });

const decode = Schema.decodeUnknownSync;

const capacity = decode(RunnerCapacity)({
  activeSessions: 1,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: 50_000,
});

function environment(sessionId = SESSION_1, state: RunnerEnvironmentSnapshot["state"] = "running") {
  return new RunnerEnvironmentSnapshot({ sessionId: decode(SessionId)(sessionId), state });
}

/** Every environment command addresses the runner its Session's placement names. */
const AT = { workspaceId: WORKSPACE_ID, runnerId: RUNNER_ID };

interface Block {
  started: Deferred.Deferred<void>;
  release: Deferred.Deferred<void>;
}

const makeBlock = Effect.fn(function* () {
  const block: Block = {
    started: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  };
  return block;
});

interface Probe {
  identity: RunnerIdentity;
  runnerEvents: Queue.Queue<RunnerStateEvent, Cause.Done>;
  identifyCalls: number;
  watchCalls: number;
  bulkWatchCalls: number;
  environmentRequests: { procedure: string; payload: unknown }[];
  /** Holds the next environment command after it reaches the runner. */
  environmentBlock: Block | null;
  rejectEnvironment: boolean;
  connectionFinalized: Deferred.Deferred<void>;
  closeCode: Deferred.Deferred<number>;
}

const makeProbe = Effect.fn(function* (token = TOKEN, protocolVersion = RUNNER_PROTOCOL_VERSION) {
  const probe: Probe = {
    identity: decode(RunnerIdentity)({
      token,
      runnerId: RUNNER_ID,
      runnerVersion: "test-1",
      protocolVersion,
    }),
    runnerEvents: yield* Queue.unbounded<RunnerStateEvent, Cause.Done>(),
    identifyCalls: 0,
    watchCalls: 0,
    bulkWatchCalls: 0,
    environmentRequests: [],
    environmentBlock: null,
    rejectEnvironment: false,
    connectionFinalized: yield* Deferred.make<void>(),
    closeCode: yield* Deferred.make<number>(),
  };
  return probe;
});

interface AuthenticationProbe {
  block: Block | null;
  /** The Workspace revoked the runner: its token no longer authenticates. */
  revoked?: boolean;
}

type Repository = Pick<WorkspaceApi, "authenticateRunner">;

function fakeRepository(authentication?: AuthenticationProbe): Repository {
  return {
    authenticateRunner: (token: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const block = authentication?.block;
          if (block) {
            authentication.block = null;
            yield* Deferred.succeed(block.started, undefined);
            yield* Deferred.await(block.release);
          }
          return token === TOKEN && !authentication?.revoked
            ? { id: RUNNER_ID, workspaceId: WORKSPACE_ID }
            : null;
        }),
      ),
  };
}

const waitUntil = (predicate: () => Effect.Effect<boolean>, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (yield* predicate()) return;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(message);
  });

const emit = (probe: Probe, event: unknown) =>
  Queue.offer(probe.runnerEvents, decode(RunnerStateEvent)(event));

const publishSnapshot = (probe: Probe, environments: RunnerEnvironmentSnapshot[], observedAt = 1) =>
  emit(probe, { type: "snapshot", observedAt, capacity, environments });

function environmentCommand<A>(
  probe: Probe,
  procedure: string,
  payload: { readonly sessionId: SessionId },
  acknowledge: () => A,
) {
  return Effect.gen(function* () {
    probe.environmentRequests.push({ procedure, payload });
    const block = probe.environmentBlock;
    if (block) {
      yield* Deferred.succeed(block.started, undefined);
      yield* Deferred.await(block.release);
    }
    if (probe.rejectEnvironment) {
      return yield* new EnvironmentRejected({
        sessionId: payload.sessionId,
        message: "Injected environment rejection.",
      });
    }
    return acknowledge();
  });
}

function handlers(probe: Probe) {
  return RunnerApi.toLayer(
    RunnerApi.of({
      "runner.identify": () => Effect.sync(() => (probe.identifyCalls++, probe.identity)),
      "runner.watch": () => {
        probe.watchCalls++;
        return Stream.fromQueue(probe.runnerEvents);
      },
      "environment.create": (payload) =>
        environmentCommand(
          probe,
          "create",
          payload,
          () => new EnvironmentCreated({ environment: environment(payload.sessionId, "stopped") }),
        ),
      "environment.control": (payload) =>
        environmentCommand(
          probe,
          "control",
          payload,
          () =>
            new EnvironmentControlled({
              state: payload.action === "stop" ? "stopped" : "running",
              forced: false,
            }),
        ),
      "environment.delete": (payload) =>
        environmentCommand(probe, "delete", payload, () => new EnvironmentDeleted({})),
    }),
  );
}

function bulkHandlers(probe: Probe) {
  return RunnerBulkApi.toLayer(
    RunnerBulkApi.of({
      "runner.bulk.identify": () => Effect.sync(() => (probe.identifyCalls++, probe.identity)),
      "runner.bulk.watch": () => {
        probe.bulkWatchCalls++;
        return Stream.make({ observedAt: 1 }).pipe(Stream.concat(Stream.never));
      },
    }),
  );
}

function observeClose(socket: Socket.Socket, probe: Probe): Socket.Socket {
  const observe = <A, E, R>(effect: Effect.Effect<A, E | Socket.SocketError, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Socket.isSocketError(error) && error.reason._tag === "SocketCloseError"
          ? Deferred.succeed(probe.closeCode, error.reason.code)
          : Effect.void,
      ),
    );
  return Socket.make({
    reader: observe(
      Effect.map(socket.reader, (reader) => ({
        ...reader,
        pull: observe(reader.pull),
      })),
    ),
    writer: socket.writer,
  });
}

/** Runs the runner side: an RPC server on an outbound WebSocket, as the real runner does. */
const connectRunner = Effect.fn(function* (url: string, probe: Probe, bulk = false) {
  const socketLayer = NodeSocket.layerWebSocket(bulk ? `${url}/bulk` : url);
  const socketServer = Layer.effect(
    SocketServer.SocketServer,
    Effect.map(Socket.Socket, (socket) => {
      const observed = observeClose(socket, probe);
      return {
        address: NetAddress.socketAddressFromInputUnsafe({ address: "127.0.0.1", port: 0 }),
        run: <R, E, A>(
          handler: (socket: Socket.Socket) => Effect.Effect<A, E, R>,
        ): Effect.Effect<never, SocketServer.SocketServerError, R> =>
          handler(bulk ? observed : runnerControlWebSocket(observed)).pipe(
            Effect.ensuring(Deferred.succeed(probe.connectionFinalized, undefined)),
            Effect.exit,
            Effect.andThen(Effect.never),
          ),
      } satisfies SocketServer.SocketServer["Service"];
    }),
  ).pipe(Layer.provide(socketLayer));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(socketServer),
    Layer.provide(bulk ? runnerBulkRpcSerializationLayer : runnerControlRpcSerializationLayer),
  );
  const rpc = bulk
    ? RpcServer.layer(RunnerBulkApi).pipe(Layer.provide(bulkHandlers(probe)))
    : RpcServer.layer(RunnerApi).pipe(Layer.provide(handlers(probe)));
  yield* Layer.launch(rpc.pipe(Layer.provide(protocol))).pipe(Effect.forkScoped);
});

const makeHarness = Effect.fn(function* (
  repository: Repository = fakeRepository(),
  observer?: EnvironmentObserver,
) {
  const gateway = yield* makeRunnerRegistry(repository, observer);
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const accept = request.url.endsWith("/bulk") ? gateway.acceptBulk : gateway.accept;
    // Node performs the upgrade when the socket reader is acquired. Returning
    // after a fork can send an HTTP response before that handshake happens.
    // Keep the request alive for the entire upgraded connection, too.
    yield* accept(socket);
    return HttpServerResponse.empty();
  });
  const layer = HttpServer.serve(app).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
  );
  const context = yield* Layer.build(layer);
  const server = Context.get(context, HttpServer.HttpServer);
  if (server.address._tag !== "InetAddressV4") return yield* Effect.die("Expected IPv4 server");
  return { gateway, url: `ws://127.0.0.1:${server.address.port}/runner` };
});

type Gateway = Effect.Success<ReturnType<typeof makeHarness>>["gateway"];

const live = (gateway: Gateway) =>
  waitUntil(
    () => gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID).pipe(Effect.map((x) => x !== null)),
    "runner not admitted",
  );

function recordingObserver() {
  const notices: { workspaceId: WorkspaceId; sessionId: string; notice: EnvironmentNotice }[] = [];
  const observer: EnvironmentObserver = {
    notify: (workspaceId, sessionId, notice) => {
      notices.push({ workspaceId, sessionId, notice });
      return Promise.resolve();
    },
  };
  return { notices, observer };
}

/** The Workspace revokes the runner, then the Runners Durable Object closes its connections. */
const revoke = (gateway: Gateway, authentication: AuthenticationProbe) =>
  Effect.suspend(() => {
    authentication.revoked = true;
    return gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID);
  });

test("gateway lifecycle logs admission, operations, revocation and offline routing without secrets", async () => {
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authentication: AuthenticationProbe = { block: null };
        const { gateway, url } = yield* makeHarness(fakeRepository(authentication));
        const probe = yield* makeProbe();
        yield* connectRunner(url, probe);
        yield* waitUntil(() => Effect.sync(() => probe.watchCalls === 1), "watch not started");
        assertEquals(logs.filter((log) => log.message === "connection.connected").length, 0);
        yield* publishSnapshot(probe, [environment(SESSION_1, "stopped")]);
        yield* waitUntil(
          () => Effect.sync(() => logs.some((log) => log.message === "connection.connected")),
          "admission not logged",
        );
        assertEquals(
          logs.find((log) => log.message === "connection.connected")?.annotations.environmentCount,
          1,
        );
        const started = yield* gateway.controlEnvironment({
          ...AT,
          sessionId: SESSION_1,
          payload: { action: "start", githubToken: GITHUB_TOKEN },
        });
        assertEquals(started.status, "accepted");
        assert(logs.some((log) => log.message === "environment.control.accepted"));
        assert(yield* revoke(gateway, authentication));
        assert(logs.some((log) => log.message === "connection.revoked"));
        yield* waitUntil(
          () =>
            gateway
              .getRunnerLiveState(WORKSPACE_ID, RUNNER_ID)
              .pipe(Effect.map((state) => state === null)),
          "runner still online",
        );
        const offline = yield* gateway.controlEnvironment({
          ...AT,
          sessionId: SESSION_1,
          payload: { action: "stop" },
        });
        assertEquals(offline.status, "unavailable");
        assert(logs.some((log) => log.message === "environment.control.unavailable"));
        const invalid = yield* makeProbe("openorb_runner_secret-invalid-token");
        yield* connectRunner(url, invalid);
        yield* Deferred.await(invalid.closeCode);
        assert(logs.some((log) => log.message === "connection.rejected"));
      }),
    ).pipe(Effect.provide(Logger.layer([logger]))),
  );
  assert(logs.some((log) => log.message === "connection.disconnected"));
  const serialized = JSON.stringify(logs);
  assert(!serialized.includes(TOKEN));
  assert(!serialized.includes("secret-invalid-token"));
  assert(!serialized.includes(GITHUB_TOKEN));
  assert(logs.every((log) => log.annotations.component === "openorb-gateway"));
});

test("valid identity admits; invalid token and previous protocol close 4401 without watch", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const valid = yield* makeProbe();
        yield* connectRunner(harness.url, valid);
        yield* publishSnapshot(valid, [environment()]);
        yield* live(harness.gateway);
        assertEquals(valid.identifyCalls, 1);
        assertEquals(valid.watchCalls, 1);

        // Tenant isolation: another Workspace can neither see nor command this runner.
        const foreign = {
          workspaceId: FOREIGN_WORKSPACE_ID,
          runnerId: RUNNER_ID,
          sessionId: SESSION_1,
        };
        assertEquals(
          yield* harness.gateway.getRunnerLiveState(FOREIGN_WORKSPACE_ID, RUNNER_ID),
          null,
        );
        assertEquals(
          (yield* harness.gateway.controlEnvironment({ ...foreign, payload: { action: "stop" } }))
            .status,
          "unavailable",
        );
        assertEquals((yield* harness.gateway.deleteEnvironment(foreign)).status, "unavailable");
        assertEquals(
          (yield* harness.gateway.createEnvironment({
            ...foreign,
            payload: {
              orbSize: "small",
              repository: { url: REPOSITORY_URL, gitAuthor: GIT_AUTHOR },
            },
          })).status,
          "unavailable",
        );
        assertEquals(valid.environmentRequests, []);
        assertEquals(
          yield* harness.gateway.disconnectRunner(FOREIGN_WORKSPACE_ID, RUNNER_ID),
          false,
        );
        assert((yield* harness.gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID)) !== null);

        const invalid = yield* makeProbe("openorb_runner_invalid");
        yield* connectRunner(harness.url, invalid);
        assertEquals(yield* Deferred.await(invalid.closeCode), PERMANENT_REJECTION_CLOSE_CODE);
        assertEquals(invalid.watchCalls, 0);

        const previousProtocol = yield* makeProbe(TOKEN, RUNNER_PROTOCOL_VERSION - 1);
        yield* connectRunner(harness.url, previousProtocol);
        assertEquals(
          yield* Deferred.await(previousProtocol.closeCode),
          PERMANENT_REJECTION_CLOSE_CODE,
        );
        assertEquals(previousProtocol.watchCalls, 0);
      }),
    ),
  ));

test("revocation during authentication rejects the runner before it watches", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authentication: AuthenticationProbe = { block: yield* makeBlock() };
        const block = authentication.block!;
        const harness = yield* makeHarness(fakeRepository(authentication));
        const probe = yield* makeProbe();
        yield* connectRunner(harness.url, probe);
        yield* Deferred.await(block.started);

        assertEquals(yield* revoke(harness.gateway, authentication), false);
        yield* Deferred.succeed(block.release, undefined);
        assertEquals(
          yield* Deferred.await(probe.closeCode).pipe(Effect.timeout("2 seconds")),
          PERMANENT_REJECTION_CLOSE_CODE,
        );
        assertEquals(probe.watchCalls, 0);
        assertEquals(yield* harness.gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
      }),
    ),
  ));

test("a revocation between authentication and admission still rejects the runner", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authentication: AuthenticationProbe = { block: null };
        const harness = yield* makeHarness(fakeRepository(authentication));
        const probe = yield* makeProbe();
        yield* connectRunner(harness.url, probe);
        yield* waitUntil(() => Effect.sync(() => probe.watchCalls === 1), "watch not started");

        // Authenticated and watching, but not yet admitted: there is no connection to close.
        assertEquals(yield* revoke(harness.gateway, authentication), false);
        yield* publishSnapshot(probe, [environment()]);
        assertEquals(
          yield* Deferred.await(probe.closeCode).pipe(Effect.timeout("2 seconds")),
          PERMANENT_REJECTION_CLOSE_CODE,
        );
        yield* Deferred.await(probe.connectionFinalized).pipe(Effect.timeout("2 seconds"));
        assertEquals(yield* harness.gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
        assertEquals(
          (yield* harness.gateway.controlEnvironment({
            ...AT,
            sessionId: SESSION_1,
            payload: { action: "stop" },
          })).status,
          "unavailable",
        );
        assertEquals(probe.environmentRequests, []);
      }),
    ),
  ));

test("a runner whose first event is not its snapshot is rejected", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, url } = yield* makeHarness();
        const probe = yield* makeProbe();
        yield* connectRunner(url, probe);
        yield* emit(probe, { type: "environment.changed", environment: environment() });
        yield* publishSnapshot(probe, []);
        assertEquals(
          yield* Deferred.await(probe.closeCode).pipe(Effect.timeout("2 seconds")),
          PERMANENT_REJECTION_CLOSE_CODE,
        );
        assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
      }),
    ),
  ));

test("a replacement takes over only once admitted, and the replaced connection goes quiet", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { notices, observer } = recordingObserver();
        const { gateway, url } = yield* makeHarness(fakeRepository(), observer);
        const first = yield* makeProbe();
        yield* connectRunner(url, first);
        yield* publishSnapshot(first, [environment(SESSION_1)], 1);
        yield* live(gateway);

        const second = yield* makeProbe();
        yield* connectRunner(url, second);
        yield* waitUntil(
          () => Effect.sync(() => second.watchCalls === 1),
          "replacement did not begin watching",
        );
        assertEquals(
          (yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID))?.lastObservedAt,
          1,
        );
        yield* publishSnapshot(second, [environment(SESSION_2)], 10);
        yield* Deferred.await(first.connectionFinalized);
        assertEquals(
          (yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID))?.lastObservedAt,
          10,
        );

        // The replaced connection neither notifies Sessions nor makes them unreachable.
        yield* emit(first, { type: "environment.changed", environment: environment(SESSION_1) });
        yield* Effect.sleep(30);
        assertEquals(
          notices.map(({ sessionId, notice }) => [sessionId, notice.type]),
          [
            [SESSION_1, "changed"],
            [SESSION_2, "changed"],
          ],
        );

        const controlled = yield* gateway.controlEnvironment({
          ...AT,
          sessionId: SESSION_2,
          payload: { action: "stop" },
        });
        assertEquals(controlled.status, "accepted");
        assertEquals(first.environmentRequests, []);
        assertEquals(
          second.environmentRequests.map((request) => request.procedure),
          ["control"],
        );
      }),
    ),
  ));

test("runner.observed updates live capacity", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, url } = yield* makeHarness();
        const probe = yield* makeProbe();
        yield* connectRunner(url, probe);
        yield* publishSnapshot(probe, [], 5);
        yield* live(gateway);
        assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), {
          capacity,
          lastObservedAt: 5,
        });
        yield* emit(probe, {
          type: "runner.observed",
          observedAt: 60,
          capacity: { ...capacity, activeSessions: 3 },
        });
        yield* waitUntil(
          () =>
            gateway
              .getRunnerLiveState(WORKSPACE_ID, RUNNER_ID)
              .pipe(Effect.map((state) => state?.capacity.activeSessions === 3)),
          "capacity not observed",
        );
        assertEquals(
          (yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID))?.lastObservedAt,
          60,
        );
      }),
    ),
  ));

test("bulk connections require a valid identity, replace by runner and close on revocation", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authentication: AuthenticationProbe = { block: null };
        const { gateway, url } = yield* makeHarness(fakeRepository(authentication));
        for (const rejected of [
          yield* makeProbe("openorb_runner_invalid"),
          yield* makeProbe(TOKEN, RUNNER_PROTOCOL_VERSION - 1),
        ]) {
          yield* connectRunner(url, rejected, true);
          assertEquals(
            yield* Deferred.await(rejected.closeCode).pipe(Effect.timeout("2 seconds")),
            PERMANENT_REJECTION_CLOSE_CODE,
          );
          assertEquals(rejected.bulkWatchCalls, 0);
        }

        const control = yield* makeProbe();
        yield* connectRunner(url, control);
        yield* publishSnapshot(control, [environment()]);
        yield* live(gateway);
        const firstBulk = yield* makeProbe();
        yield* connectRunner(url, firstBulk, true);
        yield* waitUntil(
          () => Effect.sync(() => firstBulk.bulkWatchCalls === 1),
          "bulk not watching",
        );

        const secondBulk = yield* makeProbe();
        yield* connectRunner(url, secondBulk, true);
        yield* waitUntil(
          () => Effect.sync(() => secondBulk.bulkWatchCalls === 1),
          "replacement bulk not watching",
        );
        yield* Deferred.await(firstBulk.connectionFinalized).pipe(Effect.timeout("2 seconds"));
        // Replacing the bulk connection leaves the control connection alone.
        assert((yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID)) !== null);

        assert(yield* revoke(gateway, authentication));
        yield* Deferred.await(secondBulk.connectionFinalized).pipe(Effect.timeout("2 seconds"));
        yield* Deferred.await(control.connectionFinalized).pipe(Effect.timeout("2 seconds"));
        assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);

        const revoked = yield* makeProbe();
        yield* connectRunner(url, revoked, true);
        assertEquals(
          yield* Deferred.await(revoked.closeCode).pipe(Effect.timeout("2 seconds")),
          PERMANENT_REJECTION_CLOSE_CODE,
        );
        assertEquals(revoked.bulkWatchCalls, 0);
      }),
    ),
  ));

test("environment commands preserve typed rejection and delivery uncertainty", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, url } = yield* makeHarness();
        const probe = yield* makeProbe();
        yield* connectRunner(url, probe);
        yield* publishSnapshot(probe, [environment(SESSION_1, "stopped")]);
        yield* live(gateway);

        probe.rejectEnvironment = true;
        assertEquals(
          yield* gateway.controlEnvironment({
            ...AT,
            sessionId: SESSION_1,
            payload: { action: "start" },
          }),
          { status: "rejected", message: "Injected environment rejection." },
        );

        probe.rejectEnvironment = false;
        const block = yield* makeBlock();
        probe.environmentBlock = block;
        const starting = yield* gateway
          .controlEnvironment({
            ...AT,
            sessionId: SESSION_1,
            payload: { action: "start" },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(block.started);
        assert(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));

        assertEquals((yield* Fiber.join(starting)).status, "delivery-uncertain");
        assertEquals(probe.environmentRequests.length, 2);
      }),
    ),
  ));

test("environment creation needs the runner online and reports uncertain delivery", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, url } = yield* makeHarness();
        const input = {
          ...AT,
          sessionId: SESSION_2,
          payload: {
            orbSize: "small" as const,
            repository: { url: REPOSITORY_URL, gitAuthor: GIT_AUTHOR },
          },
        };
        assertEquals((yield* gateway.createEnvironment(input)).status, "unavailable");

        const probe = yield* makeProbe();
        const block = yield* makeBlock();
        probe.environmentBlock = block;
        yield* connectRunner(url, probe);
        yield* publishSnapshot(probe, []);
        yield* live(gateway);

        const create = yield* gateway
          .createEnvironment(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(block.started);
        assert(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));

        assertEquals((yield* Fiber.join(create)).status, "delivery-uncertain");
        assertEquals(probe.environmentRequests.length, 1);
      }),
    ),
  ));

test("typed environment commands carry Session-scoped payloads and disconnect finalizes the connection", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, url } = yield* makeHarness();
        const probe = yield* makeProbe();
        yield* connectRunner(url, probe);
        yield* publishSnapshot(probe, []);
        yield* live(gateway);

        const input = { ...AT, sessionId: SESSION_2 };
        const results = [
          yield* gateway.createEnvironment({
            ...input,
            payload: {
              orbSize: "small",
              repository: { url: REPOSITORY_URL, gitAuthor: GIT_AUTHOR },
            },
          }),
          yield* gateway.controlEnvironment({
            ...input,
            payload: { action: "start", githubToken: GITHUB_TOKEN },
          }),
          yield* gateway.deleteEnvironment(input),
        ];
        assertEquals(
          results.map((result) => result.status),
          ["accepted", "accepted", "accepted"],
        );
        assertEquals(probe.environmentRequests, [
          {
            procedure: "create",
            payload: decode(CreateEnvironmentPayload)({
              sessionId: SESSION_2,
              orbSize: "small",
              repository: { url: REPOSITORY_URL, gitAuthor: GIT_AUTHOR },
            }),
          },
          {
            procedure: "control",
            payload: decode(ControlEnvironmentPayload)({
              sessionId: SESSION_2,
              action: "start",
              githubToken: GITHUB_TOKEN,
            }),
          },
          {
            procedure: "delete",
            payload: decode(DeleteEnvironmentPayload)({ sessionId: SESSION_2 }),
          },
        ]);

        assert(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));
        yield* Deferred.await(probe.connectionFinalized);
        assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
      }),
    ),
  ));

test("reported environment states notify their Session in the runner's Workspace", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { notices, observer } = recordingObserver();
        const { gateway, url } = yield* makeHarness(fakeRepository(), observer);
        const probe = yield* makeProbe();
        yield* connectRunner(url, probe);
        yield* publishSnapshot(probe, [environment(SESSION_1, "stopped")]);
        yield* waitUntil(() => Effect.sync(() => notices.length === 1), "snapshot notice missing");
        yield* emit(probe, { type: "environment.changed", environment: environment(SESSION_1) });
        yield* waitUntil(() => Effect.sync(() => notices.length === 2), "change notice missing");
        assertEquals(notices, [
          {
            workspaceId: WORKSPACE_ID,
            sessionId: SESSION_1,
            notice: { type: "changed", runnerId: RUNNER_ID, state: "stopped" },
          },
          {
            workspaceId: WORKSPACE_ID,
            sessionId: SESSION_1,
            notice: { type: "changed", runnerId: RUNNER_ID, state: "running" },
          },
        ]);
        assertEquals(
          (yield* gateway.controlEnvironment({
            ...AT,
            sessionId: SESSION_1,
            payload: { action: "stop" },
          })).status,
          "accepted",
        );
      }),
    ),
  ));

test("a lost runner makes its reported and created environments unreachable, not deleted ones", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { notices, observer } = recordingObserver();
        const { gateway, url } = yield* makeHarness(fakeRepository(), observer);
        const probe = yield* makeProbe();
        yield* connectRunner(url, probe);
        yield* publishSnapshot(probe, [environment(SESSION_1)]);
        yield* live(gateway);
        const created = { ...AT, sessionId: SESSION_2 };
        const deleted = { ...AT, sessionId: "018f47f2-39b1-7b30-8000-000000000013" };
        for (const input of [created, deleted]) {
          assertEquals(
            (yield* gateway.createEnvironment({ ...input, payload: { orbSize: "small" } })).status,
            "accepted",
          );
        }
        assertEquals((yield* gateway.deleteEnvironment(deleted)).status, "accepted");

        yield* Queue.end(probe.runnerEvents);
        yield* waitUntil(
          () => Effect.sync(() => notices.some(({ notice }) => notice.type === "unreachable")),
          "unreachable notices missing",
        );
        assertEquals(
          notices
            .filter(({ notice }) => notice.type === "unreachable")
            .map(({ sessionId }) => sessionId)
            .sort(),
          [SESSION_1, SESSION_2],
        );
        assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
      }),
    ),
  ));

test("revocation tells the runner's Sessions so they close its links", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { notices, observer } = recordingObserver();
        const authentication: AuthenticationProbe = { block: null };
        const { gateway, url } = yield* makeHarness(fakeRepository(authentication), observer);
        const probe = yield* makeProbe();
        yield* connectRunner(url, probe);
        yield* publishSnapshot(probe, [environment()]);
        yield* live(gateway);
        assertEquals(yield* revoke(gateway, authentication), true);
        yield* waitUntil(
          () => Effect.sync(() => notices.some(({ notice }) => notice.type === "revoked")),
          "revocation notice missing",
        );
        const offline = yield* gateway.controlEnvironment({
          ...AT,
          sessionId: SESSION_1,
          payload: { action: "start" },
        });
        assertEquals(offline.status, "unavailable");
      }),
    ),
  ));
