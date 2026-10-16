import { Socket as NetSocket } from "node:net";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { assert, assertEquals } from "@jsr/std__assert";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodePath from "@effect/platform-node/NodePath";
import { ok } from "@openorb/result";
import {
  type ControlEnvironmentPayload,
  EnvironmentControlled,
  EnvironmentRejected,
  GitAuthor,
  RUNNER_PROTOCOL_VERSION,
  RunnerCapacity,
  RunnerEnvironmentSnapshot,
  RunnerId,
  SessionEnvironmentSecret,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { MAX_RUNNER_BULK_RPC_FRAME_BYTES } from "@openorb/protocol/runner-api-limits";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  PubSub,
  Schema,
  Stream,
} from "effect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Socket from "effect/socket/Socket";

import {
  type EnvironmentNotice,
  type EnvironmentObserver,
  makeRunnerRegistry,
} from "../../../gateway/app/cells/runners/runner-registry.ts";
import { AgentEnvironmentProvider } from "../../src/environment/agent-environment.ts";
import { environmentStoreLayer } from "../../src/environment/session/store.ts";
import {
  EnvironmentSupervisor,
  makeEnvironmentSupervisor,
} from "../../src/environment/session/supervisor.ts";
import {
  makeOutboundSocketServer,
  PERMANENT_REJECTION_CLOSE_CODE,
  type RunnerRpcStartupError,
  runRunnerRpc,
} from "../../src/connection/rpc.ts";
import { runnerBulkWebSocket, runRunnerBulkRpc } from "../../src/connection/bulk-rpc.ts";
import { FakeEnvironment } from "../environment/fake-environment.ts";

const RUNNER_ID = "018f47f2-39b1-7b30-8000-000000000001";
const SESSION_ID = "018f47f2-39b1-7b30-8000-000000000011";
const STOPPED_SESSION_ID = "018f47f2-39b1-7b30-8000-000000000012";
const WORKSPACE_ID = WorkspaceId.make("018f47f2-39b1-7b30-8000-000000000000");
const TOKEN = "openorb_runner_test-token";
const decode = Schema.decodeUnknownSync;
const runnerId = decode(RunnerId)(RUNNER_ID);

const capacity = decode(RunnerCapacity)({
  activeSessions: 1,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: 50_000,
});

function environmentSnapshot(state: RunnerEnvironmentSnapshot["state"], sessionId = SESSION_ID) {
  return new RunnerEnvironmentSnapshot({ sessionId: decode(SessionId)(sessionId), state });
}

/** The state the gateway last told each Session about. */
function reportedStates(notices: { sessionId: string; notice: EnvironmentNotice }[]) {
  const states = new Map<string, string>();
  for (const { sessionId, notice } of notices) {
    if (notice.type === "changed") states.set(sessionId, notice.state);
  }
  return states;
}

test("runner requests TCP_NODELAY and streams large snapshots and Unicode payloads through gateway RPC", async () => {
  using cleanup = new DisposableStack();
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
  const original = NetSocket.prototype.setNoDelay;
  const noDelayCalls: boolean[] = [];
  NetSocket.prototype.setNoDelay = function (noDelay = true) {
    // ws calls this for both accepted and outbound sockets. Only the outbound
    // client is proof that the runner's adapter requests TCP_NODELAY.
    if (!("server" in this) || this.server === null) noDelayCalls.push(noDelay);
    return original.call(this, noDelay);
  };
  cleanup.defer(() => {
    NetSocket.prototype.setNoDelay = original;
  });
  // The snapshot of thousands of environments crosses the control socket as one chunked message.
  const environmentCount = 20_000;
  const environments = Array.from({ length: environmentCount }, (_, index) =>
    environmentSnapshot(
      index % 2 === 0 ? "running" : "stopped",
      `018f47f2-39b1-7b30-8000-${(0x1000 + index).toString(16).padStart(12, "0")}`,
    ),
  );
  const lastEnvironment = environments.at(-1)!;
  // Near the environment secrets JSON limit, with multi-byte UTF-8 in every value.
  const secrets = Array.from(
    { length: 64 },
    (_, index) =>
      new SessionEnvironmentSecret({
        name: `SECRET_${index}`,
        value: `${String(index).padStart(2, "0")}${"🌍漢字".repeat(1_023)}`,
      }),
  );
  const controls: ControlEnvironmentPayload[] = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = EnvironmentSupervisor.of({
          ...idleEnvironmentSupervisor,
          snapshots: () => environments,
          control: (payload) =>
            payload.action === "stop"
              ? Effect.fail(
                  new EnvironmentRejected({
                    sessionId: payload.sessionId,
                    message: "The guest is busy.",
                  }),
                )
              : Effect.sync(() => {
                  controls.push(payload);
                  return new EnvironmentControlled({ state: "running", forced: false });
                }),
        });
        const { notices, observer } = recordingObserver();
        const harness = yield* makeGatewayHarness(TOKEN, observer);
        yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.forkScoped,
        );
        yield* pollEventually(
          Effect.sync(() => notices.length === environmentCount),
          "runner did not publish its environment snapshot",
        );
        const reported = reportedStates(notices);
        assertEquals(reported.get(environments[0]!.sessionId), "running");
        assertEquals(reported.get(lastEnvironment.sessionId), "stopped");

        const controlled = yield* harness.gateway.controlEnvironment({
          workspaceId: WORKSPACE_ID,
          runnerId: RUNNER_ID,
          sessionId: lastEnvironment.sessionId,
          payload: { action: "start", githubToken: "github-secret", environmentSecrets: secrets },
        });
        assertEquals(controlled, {
          status: "accepted",
          acknowledgement: new EnvironmentControlled({ state: "running", forced: false }),
        });
        assertEquals(controls.length, 1);
        assertEquals(controls[0]?.sessionId, lastEnvironment.sessionId);
        assertEquals(controls[0]?.environmentSecrets, secrets);

        // A typed rejection proves the same control connection is still usable.
        assertEquals(
          yield* harness.gateway.controlEnvironment({
            workspaceId: WORKSPACE_ID,
            runnerId: RUNNER_ID,
            sessionId: lastEnvironment.sessionId,
            payload: { action: "stop" },
          }),
          { status: "rejected", message: "The guest is busy." },
        );
        // Accepted gateway sockets are excluded from the observation above.
        assert(
          noDelayCalls.includes(true),
          "runner must enable TCP_NODELAY, not use native WebSocket",
        );
      }),
    ).pipe(Effect.provide(Logger.layer([logger]))),
  );
  const snapshots = logs.filter((log) => log.message === "snapshot.sent");
  assertEquals(snapshots.length, 1);
  assertEquals(snapshots[0]?.annotations, {
    component: "openorb-runner",
    runnerId: RUNNER_ID,
    environmentCount,
  });
  const serialized = JSON.stringify(logs);
  assert(!serialized.includes(TOKEN));
  assert(!serialized.includes("github-secret"));
  assert(!serialized.includes("🌍漢字"));
});

test("outbound adapter propagates permanent gateway rejection", async () => {
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
  const program = Effect.gen(function* () {
    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Effect.fail(closeError(PERMANENT_REJECTION_CLOSE_CODE)),
        upgrade: () => Effect.void,
      }),
      writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
    });
    const terminal = yield* Deferred.make<never, RunnerRpcStartupError>();
    const running = makeOutboundSocketServer(socket, terminal).run((decorated) =>
      Effect.scoped(Effect.flatMap(decorated.reader, (reader) => reader.pull)),
    );
    const result = yield* Effect.raceFirst(running, Deferred.await(terminal)).pipe(Effect.result);
    assert(result._tag === "Failure");
    assert(result.failure._tag === "RunnerRpcStartupError");
    assertEquals(result.failure.code, PERMANENT_REJECTION_CLOSE_CODE);
  });

  await Effect.runPromise(program.pipe(Effect.provide(Logger.layer([logger]))));
  assertEquals(
    logs.map((log) => log.message),
    [
      "connection.connecting",
      "connection.connected",
      "connection.disconnected",
      "connection.auth-rejected",
    ],
  );
  assertEquals(logs.at(-1)?.annotations, {
    component: "openorb-runner",
    attempt: 1,
    closeCode: 4401,
  });
  assertEquals(logs.at(-1)?.level, "ERROR");
  assert(logs.every((log) => log.cause === undefined));
});

test("bulk socket limits every frame in read and write batches by UTF-8 bytes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const limit = MAX_RUNNER_BULK_RPC_FRAME_BYTES;
        const acceptedText = "é".repeat(limit / 2);
        const oversizedText = acceptedText + "é";
        let frames: [string | Uint8Array, ...(string | Uint8Array)[]] = [
          acceptedText,
          new Uint8Array(limit),
        ];
        const written: (string | Uint8Array | Socket.CloseEvent)[] = [];
        let upgrades = 0;
        const underlying = Socket.make({
          reader: Effect.succeed({
            pull: Effect.sync(() => frames),
            upgrade: () =>
              Effect.sync(() => {
                upgrades++;
              }),
          }),
          writer: Effect.succeed({
            write: (frame) =>
              Effect.sync(() => {
                written.push(frame);
              }),
            writeAll: (batch) =>
              Effect.sync(() => {
                written.push(...batch);
              }),
          }),
        });
        const captured = yield* Deferred.make<Socket.Socket>();
        const terminal = yield* Deferred.make<never, RunnerRpcStartupError>();
        yield* makeOutboundSocketServer(runnerBulkWebSocket(underlying), terminal)
          .run((socket) => Deferred.succeed(captured, socket).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkScoped);
        const socket = yield* Deferred.await(captured);
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        assertEquals(yield* reader.pull, frames);
        yield* reader.upgrade();
        assertEquals(upgrades, 1);
        yield* writer.writeAll(frames);
        yield* writer.write(acceptedText);
        assertEquals(written, [...frames, acceptedText]);
        written.length = 0;

        frames = ["ok", oversizedText];
        assert(Exit.isFailure(yield* Effect.exit(reader.pull)));
        assert(Exit.isFailure(yield* Effect.exit(writer.write(oversizedText))));
        assert(
          Exit.isFailure(yield* Effect.exit(writer.writeAll(["ok", new Uint8Array(limit + 1)]))),
        );
        assertEquals(written, [
          new Socket.CloseEvent(4400, "Frame limit exceeded"),
          new Socket.CloseEvent(4400, "Frame limit exceeded"),
          new Socket.CloseEvent(4400, "Frame limit exceeded"),
        ]);
        const close = new Socket.CloseEvent(4401, "A close reason longer than the frame limit");
        yield* writer.write(close);
        assertEquals(written.at(-1), close);
      }),
    ).pipe(Effect.timeout("5 seconds")),
  ));

test("outbound reconnect logs the actual jittered delay and next attempt without close reasons", async () => {
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
  const program = Effect.gen(function* () {
    let opens = 0;
    const socket = Socket.make({
      reader: Effect.sync(() => {
        opens++;
        return {
          pull: Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketCloseError({
                code: opens === 1 ? 1006 : 4401,
                closeReason: "secret-close-reason",
              }),
            }),
          ),
          upgrade: () => Effect.void,
        };
      }),
      writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
    });
    const terminal = yield* Deferred.make<never, RunnerRpcStartupError>();
    const running = makeOutboundSocketServer(socket, terminal).run((decorated) =>
      Effect.scoped(Effect.flatMap(decorated.reader, (reader) => reader.pull)),
    );
    yield* Effect.raceFirst(running, Deferred.await(terminal)).pipe(Effect.exit);
    assertEquals(opens, 2);
  });
  await Effect.runPromise(
    program.pipe(Effect.provide(Logger.layer([logger])), Effect.timeout("5 seconds")),
  );
  const retries = logs.filter((log) => log.message === "connection.reconnect-scheduled");
  assertEquals(retries.length, 1);
  assertEquals(retries[0]?.annotations.attempt, 2);
  const delayMs = Schema.decodeUnknownSync(Schema.Number)(retries[0]?.annotations.delayMs);
  // Effect's jittered schedule uses 80–120% of the base delay.
  assert(delayMs >= 800 && delayMs <= 1_200);
  assertEquals(
    logs
      .filter((log) => log.message === "connection.connecting")
      .map((log) => log.annotations.attempt),
    [1, 2],
  );
  assert(!JSON.stringify(logs).includes("secret-close-reason"));
});

test("transient gateway restart keeps runner environments and re-reports them on reconnect", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(join(tmpdir(), "openorb-rpc-environments-"))),
          (path) => Effect.promise(() => fs.rm(path, { recursive: true })),
        );
        const bootStarted = yield* Deferred.make<void>();
        const releaseBoot = yield* Deferred.make<void>();
        const booted: FakeEnvironment[] = [];
        const provider = Layer.succeed(
          AgentEnvironmentProvider,
          AgentEnvironmentProvider.of({
            initializeRootDisk: (path) =>
              Effect.promise(() => fs.writeFile(path, new Uint8Array())),
            // A slow VM boot: the runner owns it, so it must outlive the gateway connection.
            make: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(bootStarted, undefined);
                yield* Deferred.await(releaseBoot);
                const environment = new FakeEnvironment();
                booted.push(environment);
                return environment;
              }),
          }),
        );
        const supervisor = yield* makeEnvironmentSupervisor({
          runnerId,
          cpuCount: 4,
          memoryMiB: 8192,
          gatewayUrl: "http://127.0.0.1:1",
          runnerToken: TOKEN,
          assertDetached: () => Promise.resolve(ok(undefined)),
        }).pipe(
          Effect.provide(
            Layer.merge(provider, environmentStoreLayer(directory)).pipe(
              Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
            ),
          ),
        );
        const originalNotices = recordingObserver();
        const harness = yield* makeGatewayHarness(TOKEN, originalNotices.observer);
        const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.exit,
          Effect.forkScoped,
        );

        const originalGateway = harness.gateway;
        yield* pollEventually(
          originalGateway
            .getRunnerLiveState(WORKSPACE_ID, RUNNER_ID)
            .pipe(Effect.map((state) => state !== null)),
          "the runner did not connect",
        );
        for (const sessionId of [SESSION_ID, STOPPED_SESSION_ID]) {
          const created = yield* originalGateway.createEnvironment({
            workspaceId: WORKSPACE_ID,
            runnerId: RUNNER_ID,
            sessionId,
            payload: {
              orbSize: "small",
              repository: {
                url: "https://github.com/meln1k/openorb-test-repo.git",
                gitAuthor: new GitAuthor({ name: "Tester", email: "test@example.com" }),
              },
            },
          });
          assertEquals(created.status, "accepted");
        }
        const started = yield* originalGateway
          .controlEnvironment({
            workspaceId: WORKSPACE_ID,
            runnerId: RUNNER_ID,
            sessionId: SESSION_ID,
            payload: { action: "start" },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(bootStarted);

        const restartedNotices = recordingObserver();
        yield* harness.restart(restartedNotices.observer);
        assertEquals((yield* Fiber.join(started)).status, "delivery-uncertain");
        assert(
          originalNotices.notices.some(
            ({ sessionId, notice }) => sessionId === SESSION_ID && notice.type === "revoked",
          ),
          "revoking the old gateway's runner must close its environments' links",
        );

        // The boot started before the restart completes while the runner is disconnected.
        yield* Deferred.succeed(releaseBoot, undefined);
        yield* pollEventually(
          Effect.sync(() => reportedStates(restartedNotices.notices).get(SESSION_ID) === "running"),
          "the runner did not reconnect and re-report its running environment",
        );
        assert(
          restartedNotices.notices.some(
            ({ sessionId, notice }) =>
              sessionId === STOPPED_SESSION_ID &&
              notice.type === "changed" &&
              notice.state === "stopped" &&
              notice.runnerId === RUNNER_ID,
          ),
          "the reconnect snapshot must tell each Session its environment is reachable again",
        );
        assertEquals(
          launched.pollUnsafe(),
          undefined,
          "a transient restart terminated the runner layer",
        );
        assertEquals(booted.length, 1, "the start must not be repeated after reconnecting");
        assertEquals(booted[0]?.stops, 0, "a gateway restart must not stop the runner's VM");
        assertEquals(
          supervisor.snapshots().map((environment) => [environment.sessionId, environment.state]),
          [
            [SESSION_ID, "running"],
            [STOPPED_SESSION_ID, "stopped"],
          ],
        );
        yield* Fiber.interrupt(launched);
      }),
    ),
  ));

test("WatchRunner reports an environment change made during snapshot-to-live handoff", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* PubSub.unbounded<RunnerEnvironmentSnapshot>();
        let current = environmentSnapshot("stopped");
        const supervisor = EnvironmentSupervisor.of({
          ...idleEnvironmentSupervisor,
          changes: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          snapshots: () => {
            const taken = current;
            if (taken.state === "stopped") {
              // The environment starts right after the snapshot was read, before the live phase.
              current = environmentSnapshot("running");
              assert(PubSub.publishUnsafe(changes, current));
            }
            return [taken];
          },
        });
        const { notices, observer } = recordingObserver();
        const harness = yield* makeGatewayHarness(TOKEN, observer);
        const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.exit,
          Effect.forkScoped,
        );

        yield* pollEventually(
          Effect.sync(() => reportedStates(notices).get(SESSION_ID) === "running"),
          "an environment change published during the WatchRunner handoff was not observed",
        );
        yield* Fiber.interrupt(launched);
      }),
    ),
  ));

test("launched runner RPC layer terminates after the adapter receives permanent close 4401", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeGatewayHarness(TOKEN);
        const launched = yield* runRunnerRpc(
          runnerOptions(harness.url, "openorb_runner_rejected"),
        ).pipe(
          Effect.provideService(EnvironmentSupervisor, idleEnvironmentSupervisor),
          Effect.exit,
          Effect.forkScoped,
        );

        const exit = yield* Fiber.join(launched).pipe(Effect.timeout("5 seconds"));
        assert(Exit.isFailure(exit), "the launched RPC layer must terminate with failure");
      }),
    ),
  ));

test("launched runner bulk RPC layer terminates after permanent close 4401", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeGatewayHarness(TOKEN);
        const launched = yield* runRunnerBulkRpc(
          runnerOptions(harness.url, "openorb_runner_rejected"),
        ).pipe(Effect.exit, Effect.forkScoped);

        const exit = yield* Fiber.join(launched).pipe(Effect.timeout("5 seconds"));
        assert(Exit.isFailure(exit), "the launched bulk RPC layer must terminate with failure");
      }),
    ),
  ));

function runnerOptions(gatewayUrl: string, runnerToken = TOKEN) {
  return {
    gatewayUrl,
    runnerId,
    runnerToken,
    runnerVersion: "test-1",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    getCapacity: () => Promise.resolve(capacity),
  };
}

function recordingObserver() {
  const notices: { sessionId: string; notice: EnvironmentNotice }[] = [];
  const observer: EnvironmentObserver = {
    notify: (workspaceId, sessionId, notice) => {
      assertEquals(workspaceId, WORKSPACE_ID);
      notices.push({ sessionId, notice });
      return Promise.resolve();
    },
  };
  return { notices, observer };
}

const pollEventually = (predicate: Effect.Effect<boolean>, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (yield* predicate) return;
      yield* Effect.sleep(25);
    }
    return yield* Effect.die(message);
  });

const makeGatewayHarness = Effect.fn(function* (
  validToken: string,
  observer?: EnvironmentObserver,
) {
  const repository: Parameters<typeof makeRunnerRegistry>[0] = {
    authenticateRunner: (token: string) =>
      Promise.resolve(token === validToken ? { id: RUNNER_ID, workspaceId: WORKSPACE_ID } : null),
  };
  let gateway = yield* makeRunnerRegistry(repository, observer);
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const connection = request.url.includes("/bulk")
      ? gateway.acceptBulk(socket)
      : gateway.accept(socket);
    // Node owns the upgraded WebSocket in the HTTP request scope. Keep the
    // handler alive for the connection rather than finalizing it after a fork.
    yield* connection;
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
  return {
    get gateway() {
      return gateway;
    },
    /** Replaces the registry, as a restarted gateway would, then drops the old connections. */
    restart: Effect.fn(function* (nextObserver?: EnvironmentObserver) {
      const previousGateway = gateway;
      gateway = yield* makeRunnerRegistry(repository, nextObserver);
      yield* previousGateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID);
      return gateway;
    }),
    url: `http://127.0.0.1:${server.address.port}`,
  };
});

function closeError(code: number) {
  return new Socket.SocketError({
    reason: new Socket.SocketCloseError({ code, closeReason: "rejected" }),
  });
}

const idleEnvironmentSupervisor = EnvironmentSupervisor.of({
  activeCount: () => 0,
  snapshots: () => [],
  changes: Effect.succeed(Stream.never),
  create: () => Effect.die("unexpected environment create"),
  control: () => Effect.die("unexpected environment control"),
  delete: () => Effect.die("unexpected environment delete"),
});
