// deno-lint-ignore-file openorb/no-chained-type-assertions -- boundary-only test doubles intentionally implement only methods reached by the composed RPC scenarios
import { assert, assertEquals } from "@std/assert";
import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import {
  AbortSessionAccepted,
  GitFileUpdateAccepted,
  PromptSessionAccepted,
  RUNNER_PROTOCOL_VERSION,
  RunnerCapacity,
  RunnerId,
  RunnerSessionSnapshot,
  SessionGitSnapshot,
  SessionId,
  SessionModelRuntime,
  StopSessionAccepted,
  UpdateSessionGitFilePayload,
  WakeSessionAccepted,
  WakeSessionPayload,
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
  activeSessions: 1,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: 50_000,
});

function snapshot(state: "ready" | "running", activeRunId?: string) {
  return decode(RunnerSessionSnapshot)({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    createdAt: "2026-08-23T12:00:00Z",
    initialPromptPreview: "handoff regression",
    model: "opencode-go/deepseek-v4-flash",
    orbSize: "small",
    state,
    lastEventCursor: state === "ready" ? 1 : 2,
    ...(activeRunId === undefined ? {} : { activeRunId }),
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

Deno.test("cached Git Snapshots are served without restoring a session VM", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const gitSnapshot = new SessionGitSnapshot({
      generatedAt: "2026-08-25T12:00:00Z",
      completeness: "complete",
      stale: false,
      truncated: false,
      sections: {
        staged: { files: [], patch: "", truncated: false },
        unstaged: {
          files: [{
            kind: "tracked",
            path: "src/main.ts",
            displayPath: "src/main.ts",
            status: "modified",
            diffState: "available",
          }],
          patch: "diff --git a/src/main.ts b/src/main.ts\n",
          truncated: false,
        },
      },
    });
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [snapshot("ready")], errors: [] }),
      readMetadata: () => Effect.succeed({}),
      readGitSnapshot: () => Effect.succeed(gitSnapshot),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: () => Stream.empty,
    } as unknown as SessionEvents;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc(runnerOptions(harness.url, store, events)).pipe(
      Effect.exit,
      Effect.forkScoped,
    );

    yield* pollUntil(
      harness.gateway.getSessionGitSnapshot(USER_ID, SESSION_ID).pipe(
        Effect.map((result) =>
          result.status === "accepted" &&
          result.acknowledgement.sections.unstaged.patch ===
            gitSnapshot.sections.unstaged.patch
        ),
      ),
      "the connected runner did not serve its cached Git Snapshot",
    );
    yield* Fiber.interrupt(launched);
  }))));

Deno.test("Git file update RPC resolves and calls the session actor", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [snapshot("ready")], errors: [] }),
      readMetadata: () => Effect.succeed({}),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: () => Stream.empty,
    } as unknown as SessionEvents;
    const updates: unknown[] = [];
    const actor = {
      updateGitFile: (payload: unknown) =>
        Effect.sync(() => {
          updates.push(payload);
          return { ok: true as const };
        }),
    };
    const supervisor = {
      getActiveRunId: () => undefined,
      findOrRestoreActor: () => Effect.succeed(actor),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc({
      ...runnerOptions(harness.url, store, events),
      supervisor,
    }).pipe(Effect.exit, Effect.forkScoped);

    yield* pollUntil(
      harness.gateway.getSessionRunner(USER_ID, SESSION_ID).pipe(Effect.map((id) => id !== null)),
      "the connected runner did not publish its ready session",
    );
    const result = yield* harness.gateway.updateSessionGitFile({
      userId: USER_ID,
      sessionId: SESSION_ID,
      action: "stage",
      path: "src/main.ts",
    });
    assertEquals(result.status, "accepted");
    assert(
      result.status === "accepted" && result.acknowledgement instanceof GitFileUpdateAccepted,
    );
    assertEquals(updates.length, 1);
    assertEquals(
      updates[0],
      decode(UpdateSessionGitFilePayload)({
        sessionId: SESSION_ID,
        action: "stage",
        path: "src/main.ts",
      }),
    );
    yield* Fiber.interrupt(launched);
  }))));

Deno.test("Wake RPC dispatches model credentials to the resolved session actor", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [snapshot("ready")], errors: [] }),
      readMetadata: () =>
        Effect.succeed({ definition: { model: "opencode-go/deepseek-v4-flash" } }),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: () => Stream.empty,
    } as unknown as SessionEvents;
    const wakes: unknown[] = [];
    const actor = {
      wake: (payload: unknown) =>
        Effect.sync(() => {
          wakes.push(payload);
          return { ok: true as const };
        }),
    };
    const supervisor = {
      getActiveRunId: () => undefined,
      findOrRestoreActor: () => Effect.succeed(actor),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc({
      ...runnerOptions(harness.url, store, events),
      supervisor,
    }).pipe(Effect.exit, Effect.forkScoped);

    yield* pollUntil(
      harness.gateway.getSessionRunner(USER_ID, SESSION_ID).pipe(Effect.map((id) => id !== null)),
      "the connected runner did not publish its ready session",
    );
    const modelRuntime = {
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "high" as const,
      credential: { type: "api_key" as const, value: "model-secret" },
    };
    const result = yield* harness.gateway.wakeSession({
      userId: USER_ID,
      sessionId: SESSION_ID,
      payload: { modelRuntime, githubToken: "github-token" },
    });
    assertEquals(result.status, "accepted");
    assert(result.status === "accepted" && result.acknowledgement instanceof WakeSessionAccepted);
    assertEquals(wakes, [
      new WakeSessionPayload({
        sessionId: Schema.decodeUnknownSync(SessionId)(SESSION_ID),
        modelRuntime: new SessionModelRuntime(modelRuntime),
        githubToken: "github-token",
      }),
    ]);
    yield* Fiber.interrupt(launched);
  }))));

Deno.test("Prompt and Abort RPCs resolve and call the session actor", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const activeRunId = "01989d78-65ee-7f6a-a97e-0f16ad134c30";
    const store = {
      loadSessionManifest: () =>
        Effect.succeed({ sessions: [snapshot("running", activeRunId)], errors: [] }),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: () => Stream.empty,
    } as unknown as SessionEvents;
    const calls: string[] = [];
    const actor = {
      prompt: () =>
        Effect.sync(() => {
          calls.push("prompt");
          return { ok: true as const, runId: activeRunId, mode: "follow-up" as const };
        }),
      abort: () =>
        Effect.sync(() => {
          calls.push("abort");
          return { ok: true as const };
        }),
    };
    const supervisor = {
      getActiveRunId: () => activeRunId,
      findActor: () => actor,
      findOrRestoreActor: () => Effect.succeed(actor),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc({
      ...runnerOptions(harness.url, store, events),
      supervisor,
    }).pipe(Effect.exit, Effect.forkScoped);

    yield* pollUntil(
      harness.gateway.getSessionRunner(USER_ID, SESSION_ID).pipe(Effect.map((id) => id !== null)),
      "the connected runner did not publish its running session",
    );
    const prompted = yield* harness.gateway.promptSession({
      userId: USER_ID,
      sessionId: SESSION_ID,
      payload: {
        prompt: "Continue",
        modelRuntime: {
          model: "opencode-go/deepseek-v4-flash",
          thinkingLevel: "high",
          credential: { type: "api_key", value: "model-secret" },
        },
      },
    });
    assert(prompted.status === "accepted");
    assert(prompted.acknowledgement instanceof PromptSessionAccepted);

    const aborted = yield* harness.gateway.abortSession({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    assert(aborted.status === "accepted");
    assert(aborted.acknowledgement instanceof AbortSessionAccepted);
    assertEquals(calls, ["prompt", "abort"]);
    yield* Fiber.interrupt(launched);
  }))));

Deno.test("Stop RPC lazily restores and calls a cold ready session actor", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [snapshot("ready")], errors: [] }),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: () => Stream.empty,
    } as unknown as SessionEvents;
    let stopCalls = 0;
    const actor = {
      stop: () =>
        Effect.sync(() => {
          stopCalls++;
          return { ok: true as const };
        }),
    };
    const supervisor = {
      getActiveRunId: () => undefined,
      findActor: () => undefined,
      findOrRestoreActor: () => Effect.succeed(actor),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc({
      ...runnerOptions(harness.url, store, events),
      supervisor,
    }).pipe(Effect.exit, Effect.forkScoped);

    yield* pollUntil(
      harness.gateway.getSessionRunner(USER_ID, SESSION_ID).pipe(Effect.map((id) => id !== null)),
      "the connected runner did not publish its ready session",
    );
    const stopped = yield* harness.gateway.stopSession({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    assert(stopped.status === "accepted");
    assert(stopped.acknowledgement instanceof StopSessionAccepted);
    assertEquals(stopCalls, 1);
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
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    getCapacity: () => Promise.resolve(capacity),
    store,
    supervisor: {
      getActiveRunId: () => undefined,
      findActor: () => undefined,
      findOrRestoreActor: () => Effect.die("unexpected actor restore"),
      provision: () => Effect.die("unexpected provision"),
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
