import { assert, assertEquals } from "@std/assert";
import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import * as DenoSocket from "@effect/platform-deno/DenoSocket";
import {
  AbortSessionAccepted,
  AbortSessionPayload,
  DeleteFailed,
  DeleteSessionAccepted,
  DeleteSessionPayload,
  GitAuthor,
  GitFileUpdateAccepted,
  ProjectId,
  PromptSessionAccepted,
  ProvisionSessionPayload,
  ProvisionSessionSuccess,
  ReadSessionGitSnapshotPayload,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  RunnerCapacity,
  RunnerIdentity,
  RunnerSessionSnapshot,
  RunnerStateEvent,
  SessionGitSnapshot,
  StopSessionAccepted,
  StopSessionPayload,
  UpdateSessionGitFilePayload,
  WakeSessionAccepted,
  WakeSessionPayload,
  WatchSessionEvent,
  WatchSessionPayload,
} from "@openorb/protocol/runner-api";
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";

import { makeRunnerRegistry, PERMANENT_REJECTION_CLOSE_CODE } from "@/app/runner-registry.ts";
import type { RejectedSessionManifestEntry } from "@/app/data/session-catalog-repository.ts";

const USER_ID = "018f47f2-39b1-7b30-8000-000000000000";
const RUNNER_ID = "018f47f2-39b1-7b30-8000-000000000001";
const SESSION_1 = "018f47f2-39b1-7b30-8000-000000000011";
const SESSION_2 = "018f47f2-39b1-7b30-8000-000000000012";
const PROJECT_ID = "018f47f2-39b1-7b30-8000-000000000021";
const TOKEN = "openorb_runner_test-token";
const GIT_AUTHOR = new GitAuthor({ name: "OpenOrb User", email: "user@example.com" });

const decode = Schema.decodeUnknownSync;
const projectId = decode(ProjectId)(PROJECT_ID);

const capacity = decode(RunnerCapacity)({
  activeSessions: 1,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: 50_000,
});

function snapshot(
  id: string,
  activeRunId?: string,
  state: "ready" | "running" | "stopped" = activeRunId ? "running" : "ready",
) {
  return decode(RunnerSessionSnapshot)({
    id,
    projectId: PROJECT_ID,
    createdAt: "2026-08-23T12:00:00Z",
    initialPromptPreview: `Session ${id.slice(-2)}`,
    model: "opencode-go/deepseek-v4-flash",
    orbSize: "small",
    state,
    lastEventCursor: 3,
    ...(activeRunId ? { activeRunId } : {}),
  });
}

interface Probe {
  identity: RunnerIdentity;
  runnerEvents: Queue.Queue<typeof RunnerStateEvent.Type>;
  identifyCalls: number;
  watchCalls: number;
  provisionRequests: unknown[];
  promptRequests: unknown[];
  wakeRequests: unknown[];
  abortRequests: unknown[];
  stopRequests: unknown[];
  deleteRequests: unknown[];
  deleteFailuresRemaining: number;
  gitSnapshotRequests: unknown[];
  gitFileUpdateRequests: unknown[];
  sessionWatches: SessionWatchProbe[];
  provisionBlock: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null;
  promptBlock: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null;
  connectionFinalized: Deferred.Deferred<void>;
  closeCode: Deferred.Deferred<number>;
}

interface SessionWatchProbe {
  request: unknown;
  events: Queue.Queue<typeof WatchSessionEvent.Type>;
  finalized: Deferred.Deferred<void>;
}

interface ReconciliationProbe {
  block: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null;
}

const makeProbe = Effect.fn(function* (token = TOKEN) {
  const probe: Probe = {
    identity: decode(RunnerIdentity)({
      token,
      runnerId: RUNNER_ID,
      runnerVersion: "test-1",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    }),
    runnerEvents: yield* Queue.unbounded<typeof RunnerStateEvent.Type>(),
    identifyCalls: 0,
    watchCalls: 0,
    provisionRequests: [],
    promptRequests: [],
    wakeRequests: [],
    abortRequests: [],
    stopRequests: [],
    deleteRequests: [],
    deleteFailuresRemaining: 0,
    gitSnapshotRequests: [],
    gitFileUpdateRequests: [],
    sessionWatches: [],
    provisionBlock: null,
    promptBlock: null,
    connectionFinalized: yield* Deferred.make<void>(),
    closeCode: yield* Deferred.make<number>(),
  };
  return probe;
});

function fakeRepository(
  tombstonedSessionIds: ReadonlySet<string> = new Set(),
  probe?: ReconciliationProbe,
) {
  return {
    authenticateRunner: (token: string) =>
      Promise.resolve(token === TOKEN ? { id: RUNNER_ID, userId: USER_ID } : null),
    reconcileSessionManifestEntries: (_userId: string, entries: RunnerSessionSnapshot[]) => {
      return Effect.runPromise(Effect.gen(function* () {
        const block = probe?.block;
        if (block) {
          probe.block = null;
          yield* Deferred.succeed(block.started, undefined);
          yield* Deferred.await(block.release);
        }
        const tombstones = entries.filter((entry) => tombstonedSessionIds.has(entry.id)).map((
          entry,
        ) => entry.id);
        const rejected: RejectedSessionManifestEntry[] = [];
        return [{
          acceptedSessionIds: entries.filter((entry) => !tombstonedSessionIds.has(entry.id)).map(
            (entry) => entry.id,
          ),
          tombstonedSessionIds: tombstones,
          rejected,
        }, undefined] as const;
      }));
    },
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

const publishSnapshot = (probe: Probe, sessions: RunnerSessionSnapshot[], revision = 1) =>
  Effect.forEach(
    [
      ...sessions.map((session) => ({ type: "snapshot.session" as const, session })),
      {
        type: "snapshot.complete" as const,
        revision,
        sessionCount: sessions.length,
        observedAt: revision,
        capacity,
      },
    ],
    (event) => Queue.offer(probe.runnerEvents, decode(RunnerStateEvent)(event)),
    { discard: true },
  );

function handlers(probe: Probe) {
  return RunnerApi.toLayer(RunnerApi.of({
    "runner.identify": () => Effect.sync(() => (probe.identifyCalls++, probe.identity)),
    "runner.watch": () => {
      probe.watchCalls++;
      return Stream.fromQueue(probe.runnerEvents);
    },
    "session.provision": (request) =>
      Effect.gen(function* () {
        probe.provisionRequests.push(request);
        if (probe.provisionBlock) {
          yield* Deferred.succeed(probe.provisionBlock.started, undefined);
          yield* Deferred.await(probe.provisionBlock.release);
        }
        return decode(ProvisionSessionSuccess)({
          session: request.mode === "create"
            ? {
              id: request.sessionId,
              projectId: request.projectId,
              createdAt: "2026-08-23T12:00:00Z",
              initialPromptPreview: request.initialPrompt,
              model: request.modelRuntime.model,
              orbSize: request.orbSize,
              state: "created",
              lastEventCursor: 0,
            }
            : snapshot(request.sessionId),
          ref: request.mode === "create" ? request.ref : "main",
          branchName: request.mode === "create" ? request.branchName : "openorb/test",
          checkoutState: "available",
        });
      }),
    "session.prompt": (request) =>
      Effect.gen(function* () {
        probe.promptRequests.push(request);
        if (probe.promptBlock) {
          yield* Deferred.succeed(probe.promptBlock.started, undefined);
          yield* Deferred.await(probe.promptBlock.release);
        }
        return decode(PromptSessionAccepted)({
          clientRequestId: request.clientRequestId,
          runId: "run-prompt",
          mode: "started",
        });
      }),
    "session.wake": (request) =>
      Effect.sync(() => {
        probe.wakeRequests.push(request);
        return new WakeSessionAccepted({});
      }),
    "session.abort": (request) =>
      Effect.sync(() => {
        probe.abortRequests.push(request);
        return decode(AbortSessionAccepted)({ runId: request.runId });
      }),
    "session.stop": (request) =>
      Effect.sync(() => {
        probe.stopRequests.push(request);
        return new StopSessionAccepted({});
      }),
    "session.delete": (request) =>
      Effect.gen(function* () {
        probe.deleteRequests.push(request);
        if (probe.deleteFailuresRemaining > 0) {
          probe.deleteFailuresRemaining--;
          return yield* new DeleteFailed({
            sessionId: request.sessionId,
            message: "Injected cleanup failure.",
          });
        }
        return new DeleteSessionAccepted({});
      }),
    "session.git-snapshot.read": (request) =>
      Effect.sync(() => {
        probe.gitSnapshotRequests.push(request);
        return new SessionGitSnapshot({
          generatedAt: "2026-08-23T12:00:00Z",
          completeness: "complete",
          stale: false,
          truncated: false,
          sections: {
            staged: { files: [], patch: "", truncated: false },
            unstaged: { files: [], patch: "", truncated: false },
          },
        });
      }),
    "session.git-file.update": (request) =>
      Effect.sync(() => {
        probe.gitFileUpdateRequests.push(request);
        return new GitFileUpdateAccepted({});
      }),
    "session.watch": (request) =>
      Stream.unwrap(Effect.gen(function* () {
        const watch: SessionWatchProbe = {
          request,
          events: yield* Queue.unbounded<typeof WatchSessionEvent.Type>(),
          finalized: yield* Deferred.make<void>(),
        };
        probe.sessionWatches.push(watch);
        const initial: typeof WatchSessionEvent.Type = {
          runId: null,
          event: { type: "agent.started" },
        };
        return Stream.make(initial).pipe(
          Stream.concat(Stream.fromQueue(watch.events)),
          Stream.rechunk(1),
          Stream.ensuring(Deferred.succeed(watch.finalized, undefined)),
        );
      })),
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
    runRaw: (handler, options) => observe(socket.runRaw(handler, options)),
    run: (handler, options) => observe(socket.run(handler, options)),
    runString: (handler, options) => observe(socket.runString(handler, options)),
    writer: socket.writer,
  });
}

const connectRunner = Effect.fn(function* (url: string, probe: Probe) {
  const socketLayer = DenoSocket.layerWebSocket(url, { closeCodeIsError: () => true });
  const socketServer = Layer.effect(
    SocketServer.SocketServer,
    Effect.map(Socket.Socket, (socket) =>
      ({
        address: { _tag: "TcpAddress" as const, hostname: "outbound", port: 0 },
        run: (handler) =>
          handler(observeClose(socket, probe)).pipe(
            Effect.ensuring(Deferred.succeed(probe.connectionFinalized, undefined)),
            Effect.exit,
            Effect.andThen(Effect.never),
          ),
      }) satisfies SocketServer.SocketServer["Service"]),
  ).pipe(Layer.provide(socketLayer));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(socketServer),
    Layer.provide(RpcSerialization.layerJson),
  );
  yield* Layer.launch(
    RpcServer.layer(RunnerApi).pipe(
      Layer.provide(handlers(probe)),
      Layer.provide(protocol),
    ),
  ).pipe(Effect.forkScoped);
});

const makeHarness = Effect.fn(function* (
  repository: ReturnType<typeof fakeRepository> = fakeRepository(),
) {
  const gateway = yield* makeRunnerRegistry(repository);
  const gatewayScope = yield* Effect.scope;
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    yield* Effect.forkIn(gateway.accept(socket), gatewayScope);
    return HttpServerResponse.empty();
  });
  const layer = HttpServer.serve(app).pipe(Layer.provideMerge(DenoHttpServer.layer({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  })));
  const context = yield* Layer.build(layer);
  const server = Context.get(context, HttpServer.HttpServer);
  if (server.address._tag !== "TcpAddress") return yield* Effect.die("Expected TCP server");
  return { gateway, url: `ws://127.0.0.1:${server.address.port}/runner` };
});

Deno.test("valid identity and complete snapshot admit; invalid token closes 4401 without watch", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const harness = yield* makeHarness();
    const valid = yield* makeProbe();
    yield* connectRunner(harness.url, valid);
    yield* publishSnapshot(valid, [snapshot(SESSION_1)]);
    yield* waitUntil(
      () =>
        harness.gateway.getSessionRunner(USER_ID, SESSION_1).pipe(
          Effect.map((runnerId) => runnerId === RUNNER_ID),
        ),
      "route not admitted",
    );
    assertEquals(valid.identifyCalls, 1);
    assertEquals(valid.watchCalls, 1);

    const invalid = yield* makeProbe("openorb_runner_invalid");
    yield* connectRunner(harness.url, invalid);
    assertEquals(yield* Deferred.await(invalid.closeCode), PERMANENT_REJECTION_CLOSE_CODE);
    assertEquals(invalid.watchCalls, 0);
  }))));

Deno.test("partial replacement stays hidden until make-before-break admission completes", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const first = yield* makeProbe();
    yield* connectRunner(url, first);
    yield* publishSnapshot(first, [snapshot(SESSION_1)], 1);
    yield* waitUntil(
      () =>
        gateway.getSessionRunner(USER_ID, SESSION_1).pipe(
          Effect.map((runnerId) => runnerId === RUNNER_ID),
        ),
      "first route missing",
    );

    const second = yield* makeProbe();
    yield* connectRunner(url, second);
    yield* waitUntil(
      () => Effect.sync(() => second.watchCalls === 1),
      "replacement did not begin watching",
    );
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), RUNNER_ID);
    yield* publishSnapshot(second, [snapshot(SESSION_2)], 10);
    yield* Deferred.await(first.connectionFinalized);
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_2), RUNNER_ID);

    yield* Queue.offer(
      first.runnerEvents,
      decode(RunnerStateEvent)({
        type: "session.updated",
        revision: 99,
        session: snapshot(SESSION_1),
      }),
    );
    yield* Effect.sleep(30);
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals((yield* gateway.getSessionSnapshot(USER_ID, SESSION_2))?.id, SESSION_2);
  }))));

Deno.test("WatchSession stream cancellation reaches the runner handler finalizer", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1)]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_1).pipe(Effect.map((id) => id !== null)),
      "route missing",
    );
    yield* gateway.watchSession(USER_ID, SESSION_1, 0).pipe(Stream.take(1), Stream.runDrain);
    assertEquals(probe.sessionWatches.length, 1);
    yield* Deferred.await(probe.sessionWatches[0]!.finalized);
    assertEquals(
      probe.sessionWatches[0]!.request,
      decode(WatchSessionPayload)({ sessionId: SESSION_1, afterCursor: 0 }),
    );
  }))));

Deno.test("each browser gets an independent WatchSession RPC and cancellation scope", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1)]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_1).pipe(Effect.map((id) => id !== null)),
      "route missing",
    );

    const firstReceived = yield* Deferred.make<void>();
    const secondContinued = yield* Deferred.make<void>();
    const first = yield* gateway.watchSession(USER_ID, SESSION_1, 3).pipe(
      Stream.tap(() => Deferred.succeed(firstReceived, undefined)),
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(firstReceived);
    const second = yield* gateway.watchSession(USER_ID, SESSION_1, 3).pipe(
      Stream.tap((item) =>
        item.event.type === "assistant.text.delta" && item.event.delta === "second-continues"
          ? Deferred.succeed(secondContinued, undefined)
          : Effect.void
      ),
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* waitUntil(
      () => Effect.sync(() => probe.sessionWatches.length === 2),
      "second watch did not start",
    );
    const third = yield* gateway.watchSession(USER_ID, SESSION_1, 4).pipe(
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* waitUntil(
      () => Effect.sync(() => probe.sessionWatches.length === 3),
      "third watch did not start",
    );

    assertEquals(
      probe.sessionWatches[0]!.request,
      decode(WatchSessionPayload)({ sessionId: SESSION_1, afterCursor: 3 }),
    );
    assertEquals(
      probe.sessionWatches[1]!.request,
      decode(WatchSessionPayload)({ sessionId: SESSION_1, afterCursor: 3 }),
    );
    assertEquals(
      probe.sessionWatches[2]!.request,
      decode(WatchSessionPayload)({ sessionId: SESSION_1, afterCursor: 4 }),
    );
    yield* Fiber.interrupt(first);
    yield* Deferred.await(probe.sessionWatches[0]!.finalized);
    assert(Option.isNone(yield* Deferred.poll(probe.sessionWatches[1]!.finalized)));
    assert(Option.isNone(yield* Deferred.poll(probe.sessionWatches[2]!.finalized)));
    yield* Queue.offer(
      probe.sessionWatches[1]!.events,
      decode(WatchSessionEvent)({
        runId: "run-active",
        event: { type: "assistant.text.delta", delta: "second-continues" },
      }),
    );
    yield* Deferred.await(secondContinued);
    assert(yield* gateway.disconnectRunner(USER_ID, RUNNER_ID));
    yield* Deferred.await(probe.sessionWatches[1]!.finalized);
    yield* Deferred.await(probe.sessionWatches[2]!.finalized);
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    yield* Fiber.interrupt(second);
    yield* Fiber.interrupt(third);
  }))));

Deno.test("Wake routes model and GitHub credentials to a stopped session's runner", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1, undefined, "stopped")]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_1).pipe(Effect.map((id) => id !== null)),
      "route missing",
    );

    const modelRuntime = {
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "high" as const,
      credential: { type: "api_key" as const, value: "secret" },
    };
    const result = yield* gateway.wakeSession({
      userId: USER_ID,
      sessionId: SESSION_1,
      payload: { modelRuntime, githubToken: "github-token" },
    });

    assertEquals(result.status, "accepted");
    assertEquals(
      probe.wakeRequests,
      [
        decode(WakeSessionPayload)({
          sessionId: SESSION_1,
          modelRuntime,
          githubToken: "github-token",
        }),
      ],
    );
  }))));

Deno.test("Stop routes only ready sessions to the pinned runner", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1)]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_1).pipe(Effect.map((id) => id !== null)),
      "route missing",
    );

    const stopped = yield* gateway.stopSession({ userId: USER_ID, sessionId: SESSION_1 });
    assertEquals(stopped.status, "accepted");
    assertEquals(probe.stopRequests, [decode(StopSessionPayload)({ sessionId: SESSION_1 })]);

    yield* Queue.offer(
      probe.runnerEvents,
      decode(RunnerStateEvent)({
        type: "session.updated",
        revision: 2,
        session: snapshot(SESSION_1, "run-active"),
      }),
    );
    yield* waitUntil(
      () =>
        gateway.getSessionSnapshot(USER_ID, SESSION_1).pipe(
          Effect.map((current) => current?.state === "running"),
        ),
      "running snapshot missing",
    );
    const busy = yield* gateway.stopSession({ userId: USER_ID, sessionId: SESSION_1 });
    assertEquals(busy.status, "rejected");
    assertEquals(probe.stopRequests.length, 1);
  }))));

Deno.test("session deletion removes routes and cleans stale updates", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1)]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_1).pipe(Effect.map((id) => id !== null)),
      "route missing",
    );

    yield* gateway.deleteSession({
      userId: "018f47f2-39b1-7b30-8000-000000000099",
      sessionId: SESSION_1,
    });
    assertEquals(probe.deleteRequests, []);

    const provisionBlock = {
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    probe.provisionBlock = provisionBlock;
    const retry = yield* gateway.provisionSession({
      userId: USER_ID,
      runnerId: RUNNER_ID,
      sessionId: SESSION_1,
      payload: {
        mode: "retry",
        modelRuntime: {
          model: "opencode-go/deepseek-v4-flash",
          thinkingLevel: "high",
          credential: { type: "api_key", value: "secret" },
        },
      },
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(provisionBlock.started);
    yield* gateway.deleteSession({
      userId: USER_ID,
      sessionId: SESSION_1,
    });
    yield* Deferred.succeed(provisionBlock.release, undefined);
    assertEquals((yield* Fiber.join(retry)).status, "accepted");
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getSessionSnapshot(USER_ID, SESSION_1), null);
    yield* waitUntil(
      () => Effect.sync(() => probe.deleteRequests.length === 1),
      "runner cleanup was not requested",
    );
    yield* Effect.sleep(20);

    yield* Queue.offer(
      probe.runnerEvents,
      decode(RunnerStateEvent)({
        type: "session.updated",
        revision: 2,
        session: snapshot(SESSION_1),
      }),
    );
    yield* waitUntil(
      () => Effect.sync(() => probe.deleteRequests.length === 2),
      "stale tombstoned update did not request cleanup",
    );
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(probe.deleteRequests, [
      decode(DeleteSessionPayload)({ sessionId: SESSION_1 }),
      decode(DeleteSessionPayload)({ sessionId: SESSION_1 }),
    ]);
  }))));

Deno.test("deletion during reconnect reconciliation blocks stale route publication", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const block = {
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    const reconciliation: ReconciliationProbe = { block };
    const { gateway, url } = yield* makeHarness(fakeRepository(new Set(), reconciliation));
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1)]);
    yield* Deferred.await(block.started);

    yield* gateway.deleteSession({ userId: USER_ID, sessionId: SESSION_1 });
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    yield* Deferred.succeed(block.release, undefined);

    yield* waitUntil(
      () => Effect.sync(() => probe.deleteRequests.length === 1),
      "reconciled deleted session was not cleaned up",
    );
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getSessionSnapshot(USER_ID, SESSION_1), null);
    assertEquals(probe.deleteRequests, [
      decode(DeleteSessionPayload)({ sessionId: SESSION_1 }),
    ]);
  }))));

Deno.test("deletion during unknown-session reconciliation blocks stale update publication", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const reconciliation: ReconciliationProbe = { block: null };
    const { gateway, url } = yield* makeHarness(fakeRepository(new Set(), reconciliation));
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_2)]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_2).pipe(Effect.map((id) => id !== null)),
      "initial route missing",
    );

    const block = {
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    reconciliation.block = block;
    yield* Queue.offer(
      probe.runnerEvents,
      decode(RunnerStateEvent)({
        type: "session.updated",
        revision: 2,
        session: snapshot(SESSION_1),
      }),
    );
    yield* Deferred.await(block.started);

    yield* gateway.deleteSession({ userId: USER_ID, sessionId: SESSION_1 });
    yield* Deferred.succeed(block.release, undefined);

    yield* waitUntil(
      () => Effect.sync(() => probe.deleteRequests.length === 1),
      "deleted late session update was not cleaned up",
    );
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getSessionSnapshot(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_2), RUNNER_ID);
  }))));

Deno.test("deletion during create reconciliation blocks late provisioning publication", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const reconciliation: ReconciliationProbe = { block: null };
    const { gateway, url } = yield* makeHarness(fakeRepository(new Set(), reconciliation));
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, []);
    yield* waitUntil(
      () =>
        gateway.getRunnerLiveState(USER_ID, RUNNER_ID).pipe(Effect.map((live) => live !== null)),
      "runner not admitted",
    );

    const block = {
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    reconciliation.block = block;
    const provision = yield* gateway.provisionSession({
      userId: USER_ID,
      runnerId: RUNNER_ID,
      sessionId: SESSION_1,
      payload: {
        mode: "create",
        projectId,
        repositoryUrl: "https://github.com/openorb/test.git",
        ref: "main",
        branchName: "openorb/test",
        gitAuthor: GIT_AUTHOR,
        orbSize: "small",
        initialPrompt: "Build it",
        modelRuntime: {
          model: "opencode-go/deepseek-v4-flash",
          thinkingLevel: "high",
          credential: { type: "api_key", value: "secret" },
        },
      },
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(block.started);

    yield* gateway.deleteSession({ userId: USER_ID, sessionId: SESSION_1 });
    yield* Deferred.succeed(block.release, undefined);

    assertEquals((yield* Fiber.join(provision)).status, "accepted");
    yield* waitUntil(
      () => Effect.sync(() => probe.deleteRequests.length === 1),
      "deleted provisioned session was not cleaned up",
    );
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getSessionSnapshot(USER_ID, SESSION_1), null);
  }))));

Deno.test("tombstoned reconnect snapshots stay hidden while cleanup retries", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness(fakeRepository(new Set([SESSION_1])));
    const probe = yield* makeProbe();
    probe.deleteFailuresRemaining = 1;
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1), snapshot(SESSION_2)]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_2).pipe(Effect.map((id) => id !== null)),
      "non-tombstoned route missing",
    );

    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getSessionSnapshot(USER_ID, SESSION_1), null);
    yield* waitUntil(
      () => Effect.sync(() => probe.deleteRequests.length === 2),
      "failed runner cleanup was not retried",
    );
    assertEquals(probe.deleteRequests, [
      decode(DeleteSessionPayload)({ sessionId: SESSION_1 }),
      decode(DeleteSessionPayload)({ sessionId: SESSION_1 }),
    ]);
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_2), RUNNER_ID);
  }))));

Deno.test("a tombstoned session first reported after connect is never routed", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness(fakeRepository(new Set([SESSION_1])));
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_2)]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_2).pipe(Effect.map((id) => id !== null)),
      "initial route missing",
    );

    yield* Queue.offer(
      probe.runnerEvents,
      decode(RunnerStateEvent)({
        type: "session.updated",
        revision: 2,
        session: snapshot(SESSION_1),
      }),
    );
    yield* waitUntil(
      () => Effect.sync(() => probe.deleteRequests.length === 1),
      "late tombstoned session was not cleaned up",
    );
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getSessionSnapshot(USER_ID, SESSION_1), null);
    assertEquals(probe.deleteRequests, [
      decode(DeleteSessionPayload)({ sessionId: SESSION_1 }),
    ]);
  }))));

Deno.test("concurrent Prompt and Abort both reach the runner for serialized handling", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    const promptBlock = {
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    probe.promptBlock = promptBlock;
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1, "run-active")]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_1).pipe(Effect.map((id) => id !== null)),
      "route missing",
    );

    const modelRuntime = {
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "high" as const,
      credential: { type: "api_key" as const, value: "secret" },
    };
    const prompt = yield* gateway.promptSession({
      userId: USER_ID,
      sessionId: SESSION_1,
      payload: { prompt: "Continue", modelRuntime },
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(promptBlock.started);

    const abort = yield* gateway.abortSession({ userId: USER_ID, sessionId: SESSION_1 });
    yield* Deferred.succeed(promptBlock.release, undefined);
    const promptResult = yield* Fiber.join(prompt);

    assertEquals(promptResult.status, "accepted");
    assertEquals(abort.status, "accepted");
    assertEquals(probe.promptRequests.length, 1);
    assertEquals(probe.abortRequests.length, 1);
  }))));

Deno.test("disconnect after provisioning dispatch reports uncertain delivery", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    probe.provisionBlock = {
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, []);
    yield* waitUntil(
      () =>
        gateway.getRunnerLiveState(USER_ID, RUNNER_ID).pipe(Effect.map((live) => live !== null)),
      "runner not admitted",
    );

    const provision = yield* gateway.provisionSession({
      userId: USER_ID,
      runnerId: RUNNER_ID,
      sessionId: SESSION_2,
      payload: {
        mode: "create",
        projectId,
        repositoryUrl: "https://github.com/openorb/test.git",
        ref: "main",
        branchName: "openorb/test",
        gitAuthor: GIT_AUTHOR,
        orbSize: "small",
        initialPrompt: "Build it",
        modelRuntime: {
          model: "opencode-go/deepseek-v4-flash",
          thinkingLevel: "high",
          credential: { type: "api_key", value: "secret" },
        },
      },
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(probe.provisionBlock.started);
    assert(yield* gateway.disconnectRunner(USER_ID, RUNNER_ID));

    assertEquals((yield* Fiber.join(provision)).status, "delivery-uncertain");
    assertEquals(probe.provisionRequests.length, 1);
  }))));

Deno.test("ready sessions route typed Git file updates to the pinned runner", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1)]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_1).pipe(Effect.map((id) => id !== null)),
      "route missing",
    );

    const result = yield* gateway.updateSessionGitFile({
      userId: USER_ID,
      sessionId: SESSION_1,
      action: "stage",
      path: "src/main.ts",
    });
    assertEquals(result.status, "accepted");
    assert(
      result.status === "accepted" && result.acknowledgement instanceof GitFileUpdateAccepted,
    );
    assertEquals(probe.gitFileUpdateRequests, [
      Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
        sessionId: SESSION_1,
        action: "stage",
        path: "src/main.ts",
      }),
    ]);
  }))));

Deno.test("typed commands reach handlers during a run and disconnect finalizes the connection", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { gateway, url } = yield* makeHarness();
    const probe = yield* makeProbe();
    yield* connectRunner(url, probe);
    yield* publishSnapshot(probe, [snapshot(SESSION_1, "run-active")]);
    yield* waitUntil(
      () => gateway.getSessionRunner(USER_ID, SESSION_1).pipe(Effect.map((id) => id !== null)),
      "route missing",
    );
    const gitUpdate = yield* gateway.updateSessionGitFile({
      userId: USER_ID,
      sessionId: SESSION_1,
      action: "unstage",
      path: "src/main.ts",
    });
    assertEquals(gitUpdate.status, "accepted");
    assertEquals(probe.gitFileUpdateRequests, [
      Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
        sessionId: SESSION_1,
        action: "unstage",
        path: "src/main.ts",
      }),
    ]);

    const modelRuntime = {
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "high" as const,
      credential: { type: "api_key" as const, value: "secret" },
    };
    assertEquals(
      (yield* gateway.provisionSession({
        userId: USER_ID,
        runnerId: RUNNER_ID,
        sessionId: SESSION_2,
        payload: {
          mode: "create",
          projectId,
          repositoryUrl: "https://github.com/openorb/test.git",
          ref: "main",
          branchName: "openorb/test",
          gitAuthor: GIT_AUTHOR,
          orbSize: "small",
          initialPrompt: "Build it",
          modelRuntime,
        },
      })).status,
      "accepted",
    );
    assertEquals(
      (yield* gateway.promptSession({
        userId: USER_ID,
        sessionId: SESSION_1,
        payload: { prompt: "Continue", modelRuntime },
      })).status,
      "accepted",
    );
    assertEquals(
      (yield* gateway.abortSession({ userId: USER_ID, sessionId: SESSION_1 })).status,
      "accepted",
    );
    const gitSnapshot = yield* gateway.getSessionGitSnapshot(USER_ID, SESSION_1);
    assertEquals(gitSnapshot.status, "accepted");
    assertEquals(probe.provisionRequests.length, 1);
    const provisionRequest = decode(ProvisionSessionPayload)(probe.provisionRequests[0]);
    assertEquals(provisionRequest.mode, "create");
    if (provisionRequest.mode !== "create") throw new Error("Expected a create payload.");
    assertEquals(provisionRequest.userId, USER_ID);
    assertEquals(provisionRequest.gitAuthor, GIT_AUTHOR);
    assertEquals(probe.promptRequests.length, 1);
    assertEquals(probe.abortRequests, [
      decode(AbortSessionPayload)({ sessionId: SESSION_1, runId: "run-active" }),
    ]);
    assertEquals(
      probe.gitSnapshotRequests.map((request) =>
        Schema.decodeUnknownSync(ReadSessionGitSnapshotPayload)(request).sessionId
      ),
      [SESSION_1],
    );
    assert(yield* gateway.disconnectRunner(USER_ID, RUNNER_ID));
    yield* Deferred.await(probe.connectionFinalized);
    assertEquals(yield* gateway.getSessionRunner(USER_ID, SESSION_1), null);
    assertEquals(yield* gateway.getRunnerLiveState(USER_ID, RUNNER_ID), null);
  }))));
