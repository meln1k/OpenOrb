// deno-lint-ignore-file openorb/no-chained-type-assertions -- boundary-only test doubles intentionally implement only methods reached by the composed RPC scenarios
import { assert, assertEquals } from "@std/assert";
import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import {
  RunnerCapacity,
  RunnerId,
  RunnerSessionSnapshot,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Context, Deferred, Effect, Exit, Fiber, Layer, PubSub, Schema, Stream } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

import { makeRunnerRegistry } from "../../../gateway/app/runner-registry.ts";
import type { RejectedSessionManifestEntry } from "../../../gateway/app/data/session-catalog-repository.ts";
import {
  makeOutboundSocketServer,
  PERMANENT_REJECTION_CLOSE_CODE,
  type RunnerRpcStartupError,
  runRunnerRpc,
} from "@/src/connection/rpc.ts";
import type { SessionEvents } from "@/src/session/events.ts";
import type { RunnerSessionStore } from "@/src/session/store.ts";
import type { SessionSupervisor } from "@/src/session/supervisor.ts";

const RUNNER_ID = "018f47f2-39b1-7b30-8000-000000000001";
const SESSION_ID = "018f47f2-39b1-7b30-8000-000000000011";
const PROJECT_ID = "018f47f2-39b1-7b30-8000-000000000021";
const USER_ID = "user-1";
const TOKEN = "openorb_runner_test-token";
const decode = Schema.decodeUnknownSync;
const runnerId = decode(RunnerId)(RUNNER_ID);

const capacity = decode(RunnerCapacity)({
  maxConcurrentSessions: 4,
  activeSessions: 1,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: 50_000,
});

function snapshot(state: "ready" | "running") {
  return decode(RunnerSessionSnapshot)({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    createdAt: "2026-08-23T12:00:00Z",
    initialPromptPreview: "handoff regression",
    model: "opencode-go/deepseek-v4-flash",
    orbSize: "small",
    state,
    lastEventCursor: state === "ready" ? 1 : 2,
  });
}

Deno.test("outbound adapter propagates permanent gateway rejection", async () => {
  const program = Effect.gen(function* () {
    const closeObserved = yield* Deferred.make<void>();
    const socket = Socket.make({
      runRaw: (_handler, options) =>
        (options?.onOpen ?? Effect.void).pipe(
          Effect.andThen(Deferred.succeed(closeObserved, undefined)),
          Effect.andThen(Effect.fail(closeError(PERMANENT_REJECTION_CLOSE_CODE))),
        ),
      writer: Effect.succeed(() => Effect.void),
    });
    const terminal = yield* Deferred.make<never, RunnerRpcStartupError>();
    const running = yield* makeOutboundSocketServer(socket, terminal).run((decorated) =>
      decorated.runRaw(() => Effect.void)
    ).pipe(Effect.exit, Effect.forkChild);

    yield* Deferred.await(closeObserved);
    yield* Effect.yieldNow;
    const result = running.pollUnsafe();
    assert(result !== undefined, "permanent rejection did not terminate the outbound adapter");
    assert(Exit.isSuccess(result));
    assertEquals(result.value._tag, "Failure");
  });

  // SAFETY: The socket test double supplies every service used by the adapter invocation.
  await Effect.runPromise(program as Effect.Effect<void>);
});

Deno.test("WatchRunner observes a state change during manifest-to-live handoff", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const manifestStarted = yield* Deferred.make<void>();
    const releaseManifest = yield* Deferred.make<void>();
    const stateChanges = yield* PubSub.unbounded<typeof SessionId.Type>();
    let current = snapshot("ready");
    const store = {
      loadSessionManifest: () =>
        Effect.gen(function* () {
          const manifestSnapshot = current;
          yield* Deferred.succeed(manifestStarted, undefined);
          yield* Deferred.await(releaseManifest);
          return { sessions: [manifestSnapshot], errors: [] };
        }),
      getSessionSnapshot: () => Effect.succeed(current),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.fromPubSub(stateChanges),
      watch: () => Stream.empty,
    } as unknown as SessionEvents;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc(runnerOptions(harness.url, store, events)).pipe(
      Effect.exit,
      Effect.forkScoped,
    );

    yield* Deferred.await(manifestStarted);
    current = snapshot("running");
    yield* PubSub.publish(stateChanges, decode(SessionId)(SESSION_ID));
    yield* Deferred.succeed(releaseManifest, undefined);

    yield* pollUntil(
      harness.gateway.getSessionSnapshot(USER_ID, SESSION_ID).pipe(
        Effect.map((value) => value?.state === "running"),
      ),
      "state change published during the WatchRunner handoff was not observed",
    );
    yield* Fiber.interrupt(launched);
  }))));

Deno.test("launched runner RPC layer terminates after the adapter receives permanent close 4401", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const harness = yield* makeGatewayHarness(TOKEN);
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [], errors: [] }),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: () => Stream.empty,
    } as unknown as SessionEvents;
    const launched = yield* runRunnerRpc(
      runnerOptions(harness.url, store, events, "openorb_runner_rejected"),
    ).pipe(Effect.exit, Effect.forkScoped);

    const exit = yield* pollFiber(launched, "Layer.launch remained running after close 4401");
    assert(Exit.isSuccess(exit), "the Effect.exit wrapper must expose RPC-layer termination");
    assert(Exit.isFailure(exit.value), "the launched RPC layer must terminate with failure");
  }))));

function runnerOptions(
  gatewayUrl: string,
  store: RunnerSessionStore,
  events: SessionEvents,
  runnerToken = TOKEN,
) {
  return {
    gatewayUrl,
    runnerId,
    runnerToken,
    runnerVersion: "test-1",
    protocolVersion: 2,
    getCapacity: () => Promise.resolve(capacity),
    store,
    supervisor: {
      getActiveRunId: () => undefined,
      provision: () => Effect.die("unexpected provision"),
      prompt: () => Effect.die("unexpected prompt"),
      abort: () => Effect.die("unexpected abort"),
    } as unknown as SessionSupervisor,
    events,
  };
}

const pollUntil = (predicate: Effect.Effect<boolean>, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt++) {
      if (yield* predicate) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(message);
  });

const pollFiber = <A, E>(fiber: Fiber.Fiber<A, E>, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt++) {
      const exit = fiber.pollUnsafe();
      if (exit !== undefined) return exit;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(message);
  });

const makeGatewayHarness = Effect.fn(function* (validToken: string) {
  const gateway = yield* makeRunnerRegistry({
    authenticateRunner: (token: string) =>
      Promise.resolve(token === validToken ? { id: RUNNER_ID, userId: USER_ID } : null),
    reconcileSessionManifestEntries: (_userId: string, entries: RunnerSessionSnapshot[]) => {
      const rejected: RejectedSessionManifestEntry[] = [];
      return Promise.resolve(
        [{
          acceptedSessionIds: entries.map((entry) => entry.id),
          tombstonedSessionIds: [],
          rejected,
        }, undefined] as const,
      );
    },
  });
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    yield* gateway.accept(socket);
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
  return { gateway, url: `http://127.0.0.1:${server.address.port}` };
});

function closeError(code: number) {
  return new Socket.SocketError({
    reason: new Socket.SocketCloseError({ code, closeReason: "rejected" }),
  });
}
