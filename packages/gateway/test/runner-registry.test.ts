import { assert, assertEquals } from "@std/assert";
import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import * as DenoSocket from "@effect/platform-deno/DenoSocket";
import {
  AttachEnvironmentPayload,
  ControlEnvironmentPayload,
  CreateEnvironmentPayload,
  DeleteEnvironmentPayload,
  EnvironmentAttachAccepted,
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
} from "@/app/cells/runners/runner-registry.ts";
import type { WorkspaceApi } from "@/app/cells/workspace/api.ts";

const WORKSPACE_ID = WorkspaceId.make("018f47f2-39b1-7b30-8000-000000000000");
const FOREIGN_WORKSPACE_ID = WorkspaceId.make("018f47f2-39b1-7b30-8000-000000000099");
const RUNNER_ID = "018f47f2-39b1-7b30-8000-000000000001";
const SESSION_1 = "018f47f2-39b1-7b30-8000-000000000011";
const SESSION_2 = "018f47f2-39b1-7b30-8000-000000000012";
const TOKEN = "openorb_runner_test-token";
const GITHUB_TOKEN = "github-secret-token";
const NONCE = "N".repeat(43);
const REPOSITORY_URL = "https://github.com/openorb/test.git";
const GIT_AUTHOR = new GitAuthor({ name: "OpenOrb User", email: "user@example.com" });

const decode = Schema.decodeUnknownSync;

const capacity = decode(RunnerCapacity)({
  activeSessions: 1,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: 50_000,
});

function environment(
  sessionId = SESSION_1,
  state: RunnerEnvironmentSnapshot["state"] = "running",
  workspaceId = WORKSPACE_ID,
) {
  return new RunnerEnvironmentSnapshot({
    sessionId: decode(SessionId)(sessionId),
    workspaceId,
    createdAt: "2026-10-11T00:00:00.000Z",
    orbSize: "small",
    state,
  });
}

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

const makeProbe = Effect.fn(function* (
  token = TOKEN,
  protocolVersion = RUNNER_PROTOCOL_VERSION,
) {
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
}

type Repository = Pick<WorkspaceApi, "authenticateRunner">;

function fakeRepository(authentication?: AuthenticationProbe): Repository {
  return {
    authenticateRunner: (token: string) =>
      Effect.runPromise(Effect.gen(function* () {
        const block = authentication?.block;
        if (block) {
          authentication.block = null;
          yield* Deferred.succeed(block.started, undefined);
          yield* Deferred.await(block.release);
        }
        return token === TOKEN ? { id: RUNNER_ID, workspaceId: WORKSPACE_ID } : null;
      })),
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

const publishSnapshot = (
  probe: Probe,
  environments: RunnerEnvironmentSnapshot[],
  revision = 1,
  environmentCount = environments.length,
) =>
  Effect.forEach(
    [
      ...environments.map((environment) => ({
        type: "snapshot.environment" as const,
        environment,
      })),
      {
        type: "snapshot.complete" as const,
        revision,
        environmentCount,
        observedAt: revision,
        capacity,
      },
    ],
    (event) => emit(probe, event),
    { discard: true },
  );

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
  return RunnerApi.toLayer(RunnerApi.of({
    "runner.identify": () => Effect.sync(() => (probe.identifyCalls++, probe.identity)),
    "runner.watch": () => {
      probe.watchCalls++;
      return Stream.fromQueue(probe.runnerEvents);
    },
    "environment.create": (payload) =>
      environmentCommand(probe, "create", payload, () =>
        new EnvironmentCreated({
          environment: new RunnerEnvironmentSnapshot({
            sessionId: payload.sessionId,
            workspaceId: payload.workspaceId,
            createdAt: "2026-10-11T00:00:00.000Z",
            orbSize: payload.orbSize,
            state: "stopped",
          }),
        })),
    "environment.control": (payload) =>
      environmentCommand(probe, "control", payload, () =>
        new EnvironmentControlled({
          state: payload.action === "stop" ? "stopped" : "running",
          forced: false,
        })),
    "environment.attach": (payload) =>
      environmentCommand(probe, "attach", payload, () => new EnvironmentAttachAccepted({})),
    "environment.delete": (payload) =>
      environmentCommand(probe, "delete", payload, () => new EnvironmentDeleted({})),
  }));
}

function bulkHandlers(probe: Probe) {
  return RunnerBulkApi.toLayer(RunnerBulkApi.of({
    "runner.bulk.identify": () => Effect.sync(() => (probe.identifyCalls++, probe.identity)),
    "runner.bulk.watch": () => {
      probe.bulkWatchCalls++;
      return Stream.make({ observedAt: 1 }).pipe(Stream.concat(Stream.never));
    },
  }));
}

function observeClose(socket: Socket.Socket, probe: Probe): Socket.Socket {
  const observe = <A, E, R>(effect: Effect.Effect<A, E | Socket.SocketError, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Socket.isSocketError(error) && error.reason._tag === "SocketCloseError"
          ? Deferred.succeed(probe.closeCode, error.reason.code)
          : Effect.void
      ),
    );
  return Socket.make({
    reader: observe(Effect.map(socket.reader, (reader) => ({
      ...reader,
      pull: observe(reader.pull),
    }))),
    writer: socket.writer,
  });
}

/** Runs the runner side: an RPC server on an outbound WebSocket, as the real runner does. */
const connectRunner = Effect.fn(function* (url: string, probe: Probe, bulk = false) {
  const socketLayer = DenoSocket.layerWebSocket(bulk ? `${url}/bulk` : url);
  const socketServer = Layer.effect(
    SocketServer.SocketServer,
    Effect.map(Socket.Socket, (socket) => {
      const observed = observeClose(socket, probe);
      return {
        address: NetAddress.socketAddressFromInputUnsafe({ address: "127.0.0.1", port: 0 }),
        run: (handler) =>
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
  const gatewayScope = yield* Effect.scope;
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const accept = request.url.endsWith("/bulk") ? gateway.acceptBulk : gateway.accept;
    yield* Effect.forkIn(accept(socket), gatewayScope);
    return HttpServerResponse.empty();
  });
  const layer = HttpServer.serve(app).pipe(Layer.provideMerge(DenoHttpServer.layer({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  })));
  const context = yield* Layer.build(layer);
  const server = Context.get(context, HttpServer.HttpServer);
  if (server.address._tag !== "InetAddressV4") return yield* Effect.die("Expected IPv4 server");
  return { gateway, url: `ws://127.0.0.1:${server.address.port}/runner` };
});

type Gateway = Effect.Success<ReturnType<typeof makeHarness>>["gateway"];

const routed = (gateway: Gateway, sessionId = SESSION_1, workspaceId = WORKSPACE_ID) =>
  waitUntil(
    () => gateway.getEnvironment(workspaceId, sessionId).pipe(Effect.map((x) => x !== null)),
    "environment route missing",
  );

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

Deno.test("gateway lifecycle logs admission, operations, revocation and offline routing without secrets", async () => {
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const { gateway, url } = yield* makeHarness();
      const probe = yield* makeProbe();
      yield* connectRunner(url, probe);
      yield* waitUntil(() => Effect.sync(() => probe.watchCalls === 1), "watch not started");
      assertEquals(logs.filter((log) => log.message === "connection.connected").length, 0);
      yield* publishSnapshot(probe, [environment(SESSION_1, "stopped")], 1);
      yield* waitUntil(
        () => Effect.sync(() => logs.some((log) => log.message === "connection.connected")),
        "admission not logged",
      );
      assertEquals(
        logs.find((log) => log.message === "snapshot.accepted")?.annotations.environmentCount,
        1,
      );
      const started = yield* gateway.controlEnvironment({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_1,
        payload: { action: "start", githubToken: GITHUB_TOKEN },
      });
      assertEquals(started.status, "accepted");
      assert(logs.some((log) => log.message === "environment.control.accepted"));
      assert(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));
      assert(logs.some((log) => log.message === "connection.revoked"));
      yield* waitUntil(
        () =>
          gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID).pipe(
            Effect.map((state) => state === null),
          ),
        "runner still online",
      );
      const offline = yield* gateway.controlEnvironment({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_1,
        payload: { action: "stop" },
      });
      assertEquals(offline.status, "unavailable");
      assert(logs.some((log) => log.message === "environment.control.unavailable"));
      const invalid = yield* makeProbe("openorb_runner_secret-invalid-token");
      yield* connectRunner(url, invalid);
      yield* Deferred.await(invalid.closeCode);
      assert(logs.some((log) => log.message === "connection.rejected"));
    })).pipe(Effect.provide(Logger.layer([logger]))),
  );
  assert(logs.some((log) => log.message === "connection.disconnected"));
  const serialized = JSON.stringify(logs);
  assert(!serialized.includes(TOKEN));
  assert(!serialized.includes("secret-invalid-token"));
  assert(!serialized.includes(GITHUB_TOKEN));
  assert(logs.every((log) => log.annotations.component === "openorb-gateway"));
});

Deno.test("valid identity admits; invalid token and previous protocol close 4401 without watch", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const harness = yield* makeHarness();
    const valid = yield* makeProbe();
    yield* connectRunner(harness.url, valid);
    yield* publishSnapshot(valid, [environment()]);
    yield* routed(harness.gateway);
    assertEquals(valid.identifyCalls, 1);
    assertEquals(valid.watchCalls, 1);
    assertEquals(
      (yield* harness.gateway.getEnvironment(WORKSPACE_ID, SESSION_1))?.runnerId,
      RUNNER_ID,
    );

    // Tenant isolation: another Workspace can neither see nor command this runner.
    assertEquals(yield* harness.gateway.getEnvironment(FOREIGN_WORKSPACE_ID, SESSION_1), null);
    assertEquals(yield* harness.gateway.getRunnerLiveState(FOREIGN_WORKSPACE_ID, RUNNER_ID), null);
    assertEquals(
      (yield* harness.gateway.controlEnvironment({
        workspaceId: FOREIGN_WORKSPACE_ID,
        sessionId: SESSION_1,
        payload: { action: "stop" },
      })).status,
      "unavailable",
    );
    assertEquals(
      (yield* harness.gateway.deleteEnvironment({
        workspaceId: FOREIGN_WORKSPACE_ID,
        sessionId: SESSION_1,
      })).status,
      "unavailable",
    );
    assertEquals(
      (yield* harness.gateway.createEnvironment({
        workspaceId: FOREIGN_WORKSPACE_ID,
        runnerId: RUNNER_ID,
        sessionId: SESSION_2,
        payload: { orbSize: "small", repository: { url: REPOSITORY_URL, gitAuthor: GIT_AUTHOR } },
      })).status,
      "unavailable",
    );
    assertEquals(valid.environmentRequests, []);
    assertEquals(yield* harness.gateway.disconnectRunner(FOREIGN_WORKSPACE_ID, RUNNER_ID), false);
    assertEquals(
      (yield* harness.gateway.getEnvironment(WORKSPACE_ID, SESSION_1))?.runnerId,
      RUNNER_ID,
    );

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
  }))));

Deno.test("revocation during authentication rejects the runner before it watches", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const block = yield* makeBlock();
    const harness = yield* makeHarness(fakeRepository({ block }));
    const probe = yield* makeProbe();
    yield* connectRunner(harness.url, probe);
    yield* Deferred.await(block.started);

    assertEquals(yield* harness.gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID), false);
    yield* Deferred.succeed(block.release, undefined);
    assertEquals(
      yield* Deferred.await(probe.closeCode).pipe(Effect.timeout("2 seconds")),
      PERMANENT_REJECTION_CLOSE_CODE,
    );
    assertEquals(probe.watchCalls, 0);
    assertEquals(yield* harness.gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
  }))));

Deno.test("revocation wins atomically over in-flight snapshot admission", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const harness = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(harness.url, probe);
    yield* waitUntil(() => Effect.sync(() => probe.watchCalls === 1), "watch not started");

    // Authenticated and watching, but not yet admitted: there is no connection to close.
    assertEquals(yield* harness.gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID), false);
    yield* publishSnapshot(probe, [environment()]);
    assertEquals(
      yield* Deferred.await(probe.closeCode).pipe(Effect.timeout("2 seconds")),
      PERMANENT_REJECTION_CLOSE_CODE,
    );
    assertEquals(yield* harness.gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
    assertEquals(yield* harness.gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null);

    const rejected = yield* makeProbe();
    yield* connectRunner(harness.url, rejected);
    assertEquals(
      yield* Deferred.await(rejected.closeCode).pipe(Effect.timeout("2 seconds")),
      PERMANENT_REJECTION_CLOSE_CODE,
    );
    assertEquals(rejected.watchCalls, 0);
  }))));

Deno.test("a runner snapshot with duplicate, miscounted or out-of-order environments is rejected", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const cases: { name: string; publish: (probe: Probe) => Effect.Effect<void> }[] = [
      {
        name: "duplicate",
        publish: (probe) => publishSnapshot(probe, [environment(), environment()]),
      },
      { name: "miscounted", publish: (probe) => publishSnapshot(probe, [environment()], 1, 2) },
      {
        name: "out-of-order",
        publish: (probe) =>
          Effect.andThen(
            emit(probe, { type: "environment.updated", revision: 1, environment: environment() }),
            publishSnapshot(probe, []),
          ),
      },
    ];
    for (const { name, publish } of cases) {
      const probe = yield* makeProbe();
      yield* connectRunner(url, probe);
      yield* publish(probe);
      assertEquals(
        yield* Deferred.await(probe.closeCode).pipe(Effect.timeout("2 seconds")),
        PERMANENT_REJECTION_CLOSE_CODE,
        name,
      );
      assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null, name);
      assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null, name);
    }
  }))));

Deno.test("partial replacement stays hidden until make-before-break admission completes", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const first = yield* makeProbe();
    yield* connectRunner(url, first);
    yield* publishSnapshot(first, [environment(SESSION_1)], 1);
    yield* routed(gateway, SESSION_1);

    const second = yield* makeProbe();
    yield* connectRunner(url, second);
    yield* waitUntil(
      () => Effect.sync(() => second.watchCalls === 1),
      "replacement did not begin watching",
    );
    assertEquals((yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1))?.runnerId, RUNNER_ID);
    assertEquals((yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID))?.lastObservedAt, 1);
    yield* publishSnapshot(second, [environment(SESSION_2)], 10);
    yield* Deferred.await(first.connectionFinalized);
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null);
    assertEquals((yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_2))?.runnerId, RUNNER_ID);
    assertEquals((yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID))?.lastObservedAt, 10);

    // The replaced generation can no longer publish routes.
    yield* emit(first, { type: "environment.updated", revision: 99, environment: environment() });
    yield* Effect.sleep(30);
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null);

    const controlled = yield* gateway.controlEnvironment({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_2,
      payload: { action: "stop" },
    });
    assertEquals(controlled.status, "accepted");
    assertEquals(first.environmentRequests, []);
    assertEquals(second.environmentRequests.map((request) => request.procedure), ["control"]);
  }))));

Deno.test("runner.observed updates live capacity only for newer revisions", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [], 5);
    yield* live(gateway);
    assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), {
      capacity,
      lastObservedAt: 5,
    });

    const observed = (revision: number, activeSessions: number) =>
      emit(probe, {
        type: "runner.observed",
        revision,
        observedAt: revision * 10,
        capacity: { ...capacity, activeSessions },
      });
    yield* observed(6, 3);
    yield* waitUntil(
      () =>
        gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID).pipe(
          Effect.map((state) => state?.capacity.activeSessions === 3),
        ),
      "newer capacity not observed",
    );
    yield* observed(4, 7);
    // Events apply in order, so this route proves the stale observation was already handled.
    yield* emit(probe, { type: "environment.updated", revision: 7, environment: environment() });
    yield* routed(gateway);
    const state = yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID);
    assertEquals(state?.capacity.activeSessions, 3);
    assertEquals(state?.lastObservedAt, 60);
  }))));

Deno.test("bulk connections require a valid identity, replace by runner and close on revocation", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    for (
      const rejected of [
        yield* makeProbe("openorb_runner_invalid"),
        yield* makeProbe(TOKEN, RUNNER_PROTOCOL_VERSION - 1),
      ]
    ) {
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
    yield* routed(gateway);
    const firstBulk = yield* makeProbe();
    yield* connectRunner(url, firstBulk, true);
    yield* waitUntil(() => Effect.sync(() => firstBulk.bulkWatchCalls === 1), "bulk not watching");

    const secondBulk = yield* makeProbe();
    yield* connectRunner(url, secondBulk, true);
    yield* waitUntil(
      () => Effect.sync(() => secondBulk.bulkWatchCalls === 1),
      "replacement bulk not watching",
    );
    yield* Deferred.await(firstBulk.connectionFinalized).pipe(Effect.timeout("2 seconds"));
    // Replacing the bulk connection leaves the control connection and its routes alone.
    assertEquals((yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1))?.runnerId, RUNNER_ID);

    assert(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));
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
  }))));

Deno.test("environment commands preserve typed rejection and delivery uncertainty", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [environment(SESSION_1, "stopped")]);
    yield* routed(gateway);

    probe.rejectEnvironment = true;
    assertEquals(
      yield* gateway.controlEnvironment({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_1,
        payload: { action: "start" },
      }),
      { status: "rejected", message: "Injected environment rejection." },
    );

    probe.rejectEnvironment = false;
    const block = yield* makeBlock();
    probe.environmentBlock = block;
    const starting = yield* gateway.controlEnvironment({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_1,
      payload: { action: "start" },
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(block.started);
    assert(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));

    assertEquals((yield* Fiber.join(starting)).status, "delivery-uncertain");
    assertEquals(probe.environmentRequests.length, 2);
  }))));

Deno.test("disconnect after environment create dispatch reports uncertain delivery", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    const block = yield* makeBlock();
    probe.environmentBlock = block;
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, []);
    yield* live(gateway);

    const create = yield* gateway.createEnvironment({
      workspaceId: WORKSPACE_ID,
      runnerId: RUNNER_ID,
      sessionId: SESSION_2,
      payload: { orbSize: "small", repository: { url: REPOSITORY_URL, gitAuthor: GIT_AUTHOR } },
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(block.started);
    assert(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));

    assertEquals((yield* Fiber.join(create)).status, "delivery-uncertain");
    assertEquals(probe.environmentRequests.length, 1);
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_2), null);
  }))));

Deno.test("environment creation checks the runner is online and can host the orb size", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const input = {
      workspaceId: WORKSPACE_ID,
      runnerId: RUNNER_ID,
      sessionId: SESSION_1,
      payload: {
        orbSize: "small" as const,
        repository: { url: REPOSITORY_URL, gitAuthor: GIT_AUTHOR },
      },
    };
    assertEquals((yield* gateway.createEnvironment(input)).status, "unavailable");

    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, []);
    yield* live(gateway);
    assertEquals(
      yield* gateway.createEnvironment({
        ...input,
        payload: { ...input.payload, orbSize: "xxlarge" },
      }),
      { status: "rejected", message: "The runner cannot host this orb size." },
    );
    assertEquals(probe.environmentRequests, []);
    assertEquals((yield* gateway.createEnvironment(input)).status, "accepted");
  }))));

Deno.test("typed environment commands carry Workspace-scoped payloads and disconnect finalizes the connection", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, []);
    yield* live(gateway);

    const input = { workspaceId: WORKSPACE_ID, sessionId: SESSION_2 };
    const results = [
      yield* gateway.createEnvironment({
        ...input,
        runnerId: RUNNER_ID,
        payload: { orbSize: "small", repository: { url: REPOSITORY_URL, gitAuthor: GIT_AUTHOR } },
      }),
      yield* gateway.controlEnvironment({
        ...input,
        payload: { action: "start", githubToken: GITHUB_TOKEN },
      }),
      yield* gateway.attachEnvironment({ ...input, nonce: NONCE }),
      yield* gateway.deleteEnvironment(input),
    ];
    assertEquals(results.map((result) => result.status), [
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
    assertEquals(probe.environmentRequests, [
      {
        procedure: "create",
        payload: decode(CreateEnvironmentPayload)({
          sessionId: SESSION_2,
          workspaceId: WORKSPACE_ID,
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
        procedure: "attach",
        payload: decode(AttachEnvironmentPayload)({ sessionId: SESSION_2, nonce: NONCE }),
      },
      { procedure: "delete", payload: decode(DeleteEnvironmentPayload)({ sessionId: SESSION_2 }) },
    ]);
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_2), null);

    assert(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));
    yield* Deferred.await(probe.connectionFinalized);
    assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
  }))));

Deno.test("reported environments route control and attach and notify their Session", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { notices, observer } = recordingObserver();
    const { gateway, url } = yield* makeHarness(fakeRepository(), observer);
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [environment(SESSION_1, "stopped")]);
    yield* routed(gateway);
    assertEquals(notices.map(({ notice }) => notice.type), ["updated"]);

    const started = yield* gateway.controlEnvironment({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_1,
      payload: { action: "start", githubToken: "gh-secret" },
    });
    assertEquals(started.status, "accepted");
    const attached = yield* gateway.attachEnvironment({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_1,
      nonce: NONCE,
    });
    assertEquals(attached.status, "accepted");
    assertEquals(probe.environmentRequests.map((request) => request.procedure), [
      "control",
      "attach",
    ]);

    yield* emit(probe, {
      type: "environment.updated",
      revision: 2,
      environment: environment(SESSION_1, "running"),
    });
    yield* waitUntil(() => Effect.sync(() => notices.length === 2), "update notice missing");
    const last = notices[1]!.notice;
    assertEquals(last.type === "updated" && last.environment.state, "running");
    assert(notices.every((notice) => notice.workspaceId === WORKSPACE_ID));
  }))));

Deno.test("another Workspace's environment in a runner snapshot rejects the connection", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [environment(SESSION_1, "running", FOREIGN_WORKSPACE_ID)]);
    assertEquals(yield* Deferred.await(probe.closeCode), PERMANENT_REJECTION_CLOSE_CODE);
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null);
    assertEquals(yield* gateway.getEnvironment(FOREIGN_WORKSPACE_ID, SESSION_1), null);
    assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
  }))));

Deno.test("after admission, another Workspace's environment updates are ignored and removals notify", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { notices, observer } = recordingObserver();
    const { gateway, url } = yield* makeHarness(fakeRepository(), observer);
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [environment(SESSION_1)]);
    yield* routed(gateway);

    yield* emit(probe, {
      type: "environment.updated",
      revision: 2,
      environment: environment(SESSION_2, "running", FOREIGN_WORKSPACE_ID),
    });
    yield* emit(probe, { type: "environment.removed", revision: 3, sessionId: SESSION_1 });
    yield* waitUntil(
      () => Effect.sync(() => notices.some(({ notice }) => notice.type === "removed")),
      "removal notice missing",
    );
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null);
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_2), null);
    assertEquals(yield* gateway.getEnvironment(FOREIGN_WORKSPACE_ID, SESSION_2), null);
    assertEquals(
      notices.map(({ workspaceId, sessionId, notice }) => [workspaceId, sessionId, notice.type]),
      [[WORKSPACE_ID, SESSION_1, "updated"], [WORKSPACE_ID, SESSION_1, "removed"]],
    );
  }))));

Deno.test("a runner whose watch ends makes its environments unreachable", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { notices, observer } = recordingObserver();
    const { gateway, url } = yield* makeHarness(fakeRepository(), observer);
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [environment(SESSION_1), environment(SESSION_2)]);
    yield* routed(gateway, SESSION_2);

    yield* Queue.end(probe.runnerEvents);
    yield* waitUntil(
      () =>
        Effect.sync(() =>
          notices.filter(({ notice }) => notice.type === "unreachable").length === 2
        ),
      "unreachable notices missing",
    );
    assertEquals(
      notices.filter(({ notice }) => notice.type === "unreachable").map(({ sessionId }) =>
        sessionId
      )
        .sort(),
      [SESSION_1, SESSION_2],
    );
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null);
    assertEquals(yield* gateway.getRunnerLiveState(WORKSPACE_ID, RUNNER_ID), null);
  }))));

Deno.test("losing the runner makes environments unreachable and revocation closes their links", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { notices, observer } = recordingObserver();
    const { gateway, url } = yield* makeHarness(fakeRepository(), observer);
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [environment()]);
    yield* routed(gateway);
    assertEquals(yield* gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID), true);
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null);
    yield* waitUntil(
      () => Effect.sync(() => notices.some(({ notice }) => notice.type === "revoked")),
      "revocation notice missing",
    );
    const offline = yield* gateway.controlEnvironment({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_1,
      payload: { action: "start" },
    });
    assertEquals(offline.status, "unavailable");
  }))));

Deno.test("created environments are routed before the runner's watch reports them", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, []);
    yield* live(gateway);
    const created = yield* gateway.createEnvironment({
      workspaceId: WORKSPACE_ID,
      runnerId: RUNNER_ID,
      sessionId: SESSION_1,
      payload: {
        orbSize: "small",
        repository: {
          url: "https://github.com/meln1k/openorb-test-repo.git",
          gitAuthor: new GitAuthor({ name: "Tester", email: "test@example.com" }),
        },
      },
    });
    assertEquals(created.status, "accepted");
    const routedEnvironment = yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1);
    assertEquals(routedEnvironment?.runnerId, RUNNER_ID);
    const deleted = yield* gateway.deleteEnvironment({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_1,
    });
    assertEquals(deleted.status, "accepted");
    assertEquals(yield* gateway.getEnvironment(WORKSPACE_ID, SESSION_1), null);
  }))));
