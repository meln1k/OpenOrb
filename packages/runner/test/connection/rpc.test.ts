// deno-lint-ignore-file openorb/no-chained-type-assertions -- boundary-only test doubles intentionally implement only methods reached by the composed RPC scenarios
import { Socket as NetSocket } from "node:net";
import { assert, assertEquals } from "@std/assert";
import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import {
  AbortSessionAccepted,
  AbortSessionPayload,
  GitFileUpdateAccepted,
  GitMutationRevision,
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
  WatchSessionEvent,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import {
  SessionArtifact,
  SessionArtifactId,
  SessionGitSnapshotId,
} from "@openorb/protocol/runner-bulk-api";
import {
  MAX_RUNNER_BULK_CHUNK_BYTES,
  MAX_RUNNER_BULK_RPC_FRAME_BYTES,
} from "@openorb/protocol/runner-api-limits";
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

import { makeRunnerRegistry } from "../../../gateway/app/cells/runners/runner-registry.ts";
import type { RejectedSessionManifestEntry } from "../../../gateway/app/cells/workspace/api.ts";
import {
  makeOutboundSocketServer,
  PERMANENT_REJECTION_CLOSE_CODE,
  type RunnerRpcStartupError,
  runRunnerRpc,
} from "../../src/connection/rpc.ts";
import { runnerBulkWebSocket, runRunnerBulkRpc } from "../../src/connection/bulk-rpc.ts";
import { SessionArtifactStore } from "../../src/session/artifact-store.ts";
import { SessionEvents, type SessionStateChange } from "../../src/session/events.ts";
import { RunnerSessionStore } from "../../src/session/store.ts";
import { SessionSupervisor } from "../../src/session/supervisor.ts";

const RUNNER_ID = "018f47f2-39b1-7b30-8000-000000000001";
const SESSION_ID = "018f47f2-39b1-7b30-8000-000000000011";
const READY_SESSION_ID = "018f47f2-39b1-7b30-8000-000000000012";
const STOPPED_SESSION_ID = "018f47f2-39b1-7b30-8000-000000000013";
const TOMBSTONED_SESSION_ID = "018f47f2-39b1-7b30-8000-000000000014";
const PROJECT_ID = "018f47f2-39b1-7b30-8000-000000000021";
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

function snapshot(
  state: "ready" | "running" | "stopped",
  sessionId = SESSION_ID,
) {
  return decode(RunnerSessionSnapshot)({
    id: sessionId,
    projectId: PROJECT_ID,
    createdAt: "2026-08-23T12:00:00Z",
    initialPromptPreview: "handoff regression",
    model: "opencode-go/deepseek-v4-flash",
    initialThinkingLevel: "high",
    orbSize: "small",
    state,
    agentState: state === "running" ? "running" : state === "stopped" ? "paused" : "idle",
    environmentState: state === "stopped" ? "stopped" : "running",
    issues: [],
  });
}

Deno.test("runner requests TCP_NODELAY and streams large Unicode deltas through gateway RPC", async () => {
  using cleanup = new DisposableStack();
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
  const original = NetSocket.prototype.setNoDelay;
  const noDelayCalls: boolean[] = [];
  NetSocket.prototype.setNoDelay = function (noDelay = true) {
    noDelayCalls.push(noDelay);
    return original.call(this, noDelay);
  };
  cleanup.defer(() => {
    NetSocket.prototype.setNoDelay = original;
  });

  await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const expected = Array.from({ length: 64 }, (_, index) =>
        decode(WatchSessionEvent)({
          event: index === 0
            ? {
              type: "conversation.snapshot",
              view: {
                conversation: { id: 1 },
                entries: [],
                docs: {
                  "pi.live": {
                    text: "large snapshot 🌍漢字\n".repeat(400_000),
                    numbers: [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1790938800000],
                  },
                },
              },
            }
            : {
              type: "conversation.ops",
              ops: [[
                "a",
                ["docs", "pi.live", "text"],
                `${index}: ${"🌍漢字 streaming\n".repeat(index === 1 ? 400_000 : 256)}`,
              ]],
            },
        }));
      // SAFETY: This watch-only RPC scenario reaches only manifest loading on the store.
      const store = {
        loadSessionManifest: () =>
          Effect.succeed({
            sessions: [snapshot("running")],
            errors: [],
          }),
      } as unknown as RunnerSessionStore;
      // SAFETY: The runner and session watches use only these two event service methods.
      const events = {
        watchStateChanges: () => Stream.empty,
        // One source batch exceeds 16 MiB; production RPC must rechunk before serialization.
        watch: () => Stream.fromIterable(expected),
      } as unknown as SessionEvents;
      const harness = yield* makeGatewayHarness(TOKEN);
      yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
        provideRunnerServices(store, events),
        Effect.forkScoped,
      );
      yield* pollEventually(
        harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
          Effect.map((id) => id !== null),
        ),
        "runner did not publish its session",
      );
      const received = yield* harness.gateway.watchSession(WORKSPACE_ID, SESSION_ID).pipe(
        Stream.runCollect,
        Effect.timeout("10 seconds"),
      );
      assertEquals(Array.from(received), expected);
      // A typed reply from another RPC proves the same control connection is still usable.
      assertEquals(
        yield* harness.gateway.abortSession({
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
        }),
        { status: "rejected", message: "The agent is not running." },
      );
      // The gateway uses native Deno sockets; this observes the outbound ws TCP socket only.
      assert(
        noDelayCalls.includes(true),
        "runner must enable TCP_NODELAY, not use native WebSocket",
      );
    })).pipe(Effect.provide(Logger.layer([logger]))),
  );
  const snapshots = logs.filter((log) => log.message === "snapshot.sent");
  assertEquals(snapshots.length, 1);
  assertEquals(snapshots[0]?.annotations, {
    component: "openorb-runner",
    runnerId: RUNNER_ID,
    sessionCount: 1,
  });
  assert(!JSON.stringify(logs).includes(TOKEN));
  assert(!JSON.stringify(logs).includes("🌍漢字"));
});

Deno.test("bulk Git patches and multi-chunk images cross the separate SchemaBinary channel as native bytes", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const snapshotId = decode(SessionGitSnapshotId)("a".repeat(64));
    const bytes = new TextEncoder().encode("full patch 🌍");
    const image = new Uint8Array(MAX_RUNNER_BULK_CHUNK_BYTES + 19).map((_, i) => i % 251);
    const artifact = new SessionArtifact({
      id: SessionArtifactId.make("01989d78-65ee-8f6a-a97e-0f16ad134c10"),
      fileName: "image.png",
      mediaType: "image/png",
      byteLength: image.length,
    });
    const reads: number[] = [];
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [snapshot("ready")], errors: [] }),
      readGitSnapshotPatchChunk: () =>
        Effect.succeed({ bytes, nextOffset: bytes.byteLength, done: true }),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: () => Stream.empty,
    } as unknown as SessionEvents;
    const harness = yield* makeGatewayHarness(TOKEN);
    const options = runnerOptions(harness.url);
    const control = yield* runRunnerRpc(options).pipe(
      provideRunnerServices(store, events),
      Effect.exit,
      Effect.forkScoped,
    );
    const bulk = yield* runRunnerBulkRpc(options).pipe(
      Effect.provideService(RunnerSessionStore, store),
      Effect.provideService(SessionArtifactStore, {
        publish: unexpectedArtifactStore.publish,
        readChunk: (sessionId, artifactId, offset, maxBytes) =>
          Effect.sync(() => {
            assertEquals(sessionId, SESSION_ID);
            assertEquals(artifactId, artifact.id);
            assertEquals(maxBytes, MAX_RUNNER_BULK_CHUNK_BYTES);
            reads.push(offset);
            return { artifact, bytes: image.slice(offset, offset + maxBytes) };
          }),
      }),
      Effect.exit,
      Effect.forkScoped,
    );
    yield* pollEventually(
      harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
        Effect.map((id) => id !== null),
      ),
      "runner did not publish its session",
    );
    let chunk: { readonly bytes: Uint8Array } | undefined;
    yield* pollEventually(
      harness.gateway.readSessionGitPatchChunk({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        snapshotId,
        section: "unstaged",
        offset: 0,
      }).pipe(Effect.map((result) => {
        if (result.status !== "accepted") return false;
        chunk = result.acknowledgement;
        return true;
      })),
      "runner bulk channel was not admitted",
    );
    assert(chunk !== undefined);
    assertEquals(new TextDecoder().decode(chunk.bytes), "full patch 🌍");

    const received = new Uint8Array(image.length);
    for (const offset of [0, MAX_RUNNER_BULK_CHUNK_BYTES]) {
      const result = yield* harness.gateway.readSessionArtifactChunk({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        artifactId: artifact.id,
        offset,
      });
      assert(result.status === "accepted");
      assertEquals(result.acknowledgement.artifact, artifact);
      assertEquals(result.acknowledgement.offset, offset);
      received.set(result.acknowledgement.bytes, offset);
    }
    assertEquals(received, image);
    assertEquals(reads, [0, MAX_RUNNER_BULK_CHUNK_BYTES]);
    assertEquals(yield* harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID), RUNNER_ID);

    assert(yield* harness.gateway.disconnectRunner(WORKSPACE_ID, RUNNER_ID));
    const [controlExit, bulkExit] = yield* Effect.all([
      Fiber.await(control),
      Fiber.await(bulk),
    ], { concurrency: "unbounded" }).pipe(Effect.timeout("5 seconds"));
    assert(Exit.isSuccess(controlExit) && Exit.isFailure(controlExit.value));
    assert(Exit.isSuccess(bulkExit) && Exit.isFailure(bulkExit.value));
  }))));

Deno.test("outbound adapter propagates permanent gateway rejection", async () => {
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
      Effect.scoped(Effect.flatMap(decorated.reader, (reader) => reader.pull))
    );
    const result = yield* Effect.raceFirst(running, Deferred.await(terminal)).pipe(Effect.result);
    assert(result._tag === "Failure");
    assert(result.failure._tag === "RunnerRpcStartupError");
    assertEquals(result.failure.code, PERMANENT_REJECTION_CLOSE_CODE);
  });

  await Effect.runPromise(program.pipe(Effect.provide(Logger.layer([logger]))));
  assertEquals(logs.map((log) => log.message), [
    "connection.connecting",
    "connection.connected",
    "connection.disconnected",
    "connection.auth-rejected",
  ]);
  assertEquals(logs.at(-1)?.annotations, {
    component: "openorb-runner",
    attempt: 1,
    closeCode: 4401,
  });
  assertEquals(logs.at(-1)?.level, "ERROR");
  assert(logs.every((log) => log.cause === undefined));
});

Deno.test("bulk socket limits every frame in read and write batches by UTF-8 bytes", () =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
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
      yield* makeOutboundSocketServer(runnerBulkWebSocket(underlying), terminal).run((socket) =>
        Deferred.succeed(captured, socket).pipe(Effect.andThen(Effect.never))
      ).pipe(Effect.forkScoped);
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
    })).pipe(Effect.timeout("5 seconds")),
  ));

Deno.test("outbound reconnect logs the actual jittered delay and next attempt without close reasons", async () => {
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
      Effect.scoped(Effect.flatMap(decorated.reader, (reader) => reader.pull))
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
    logs.filter((log) => log.message === "connection.connecting").map((log) =>
      log.annotations.attempt
    ),
    [1, 2],
  );
  assert(!JSON.stringify(logs).includes("secret-close-reason"));
});

Deno.test("transient gateway restart preserves runner work and reconnects from durable state", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const submissionId = 42;
    const catalogSessionIds = new Set<string>();
    const promptWorkStarted = yield* Deferred.make<void>();
    const releasePromptWork = yield* Deferred.make<void>();
    const promptWorkCompleted = yield* Deferred.make<void>();
    const promptAcknowledgement = yield* Deferred.make<{
      readonly ok: true;
      readonly submissionId: number;
    }>();
    const firstWatchStarted = yield* Deferred.make<void>();
    const firstWatchFinalized = yield* Deferred.make<void>();
    const durableWorkScope = yield* Effect.scope;
    const replayedEvent = decode(WatchSessionEvent)({
      event: {
        type: "conversation.snapshot",
        view: {
          conversation: { id: 1 },
          entries: [],
          docs: { "pi.live": { text: "Continued while disconnected" } },
        },
      },
    });
    let promptCalls = 0;
    let watchCalls = 0;
    let tombstoneCleanupCalls = 0;
    let manifestSnapshots = [
      snapshot("running"),
      snapshot("ready", READY_SESSION_ID),
      snapshot("stopped", STOPPED_SESSION_ID),
      snapshot("ready", TOMBSTONED_SESSION_ID),
    ];
    const tombstonedSessionIds = new Set([TOMBSTONED_SESSION_ID]);
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [...manifestSnapshots], errors: [] }),
    } as unknown as RunnerSessionStore;
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: (_sessionId: string) => {
        watchCalls++;
        if (watchCalls === 1) {
          return Stream.unwrap(
            Deferred.succeed(firstWatchStarted, undefined).pipe(Effect.as(Stream.never)),
          ).pipe(Stream.ensuring(Deferred.succeed(firstWatchFinalized, undefined)));
        }
        return Stream.make(replayedEvent);
      },
      publishRemoved: () => Effect.void,
    } as unknown as SessionEvents;
    const actor = {
      prompt: () =>
        Effect.gen(function* () {
          promptCalls++;
          yield* Effect.forkIn(
            Effect.gen(function* () {
              yield* Deferred.succeed(promptWorkStarted, undefined);
              yield* Deferred.await(releasePromptWork);
              yield* Deferred.succeed(promptWorkCompleted, undefined);
              yield* Deferred.succeed(
                promptAcknowledgement,
                {
                  ok: true,
                  submissionId,
                } as const,
              );
            }),
            durableWorkScope,
          );
          return yield* Deferred.await(promptAcknowledgement);
        }),
    };
    const supervisor = {
      findActor: () => actor,
      findOrRestoreActor: () => Effect.succeed(actor),
      deleteSession: (sessionId: string) =>
        Effect.sync(() => {
          assertEquals(sessionId, TOMBSTONED_SESSION_ID);
          tombstoneCleanupCalls++;
          manifestSnapshots = manifestSnapshots.filter((item) => item.id !== sessionId);
          return { ok: true as const };
        }),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(
      TOKEN,
      catalogSessionIds,
      tombstonedSessionIds,
    );
    const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
      provideRunnerServices(store, events, supervisor),
      Effect.exit,
      Effect.forkScoped,
    );

    const originalGateway = harness.gateway;
    yield* pollEventually(
      originalGateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
        Effect.map((id) => id !== null),
      ),
      "the connected runner did not publish its running session",
    );
    assertEquals(
      yield* originalGateway.getSessionRunner(WORKSPACE_ID, READY_SESSION_ID),
      RUNNER_ID,
    );
    assertEquals(
      yield* originalGateway.getSessionRunner(WORKSPACE_ID, STOPPED_SESSION_ID),
      RUNNER_ID,
    );
    assertEquals(
      yield* originalGateway.getSessionRunner(WORKSPACE_ID, TOMBSTONED_SESSION_ID),
      null,
    );
    yield* pollUntil(
      Effect.sync(() => tombstoneCleanupCalls === 1),
      "the runner did not clean up its tombstoned session",
    );
    assert(catalogSessionIds.has(SESSION_ID));
    assert(catalogSessionIds.has(READY_SESSION_ID));
    assert(catalogSessionIds.has(STOPPED_SESSION_ID));
    assert(!catalogSessionIds.has(TOMBSTONED_SESSION_ID));
    catalogSessionIds.delete(READY_SESSION_ID);

    const prompted = yield* originalGateway.promptSession({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      payload: {
        prompt: "Continue through the restart",
        modelRuntime: {
          model: "opencode-go/deepseek-v4-flash",
          thinkingLevel: "high",
          credential: { type: "api_key", value: "model-secret" },
        },
      },
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(promptWorkStarted);
    const watching = yield* originalGateway.watchSession(WORKSPACE_ID, SESSION_ID).pipe(
      Stream.runDrain,
      Effect.exit,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(firstWatchStarted);

    const restartedGateway = yield* harness.restart();
    assertEquals((yield* Fiber.join(prompted)).status, "delivery-uncertain");
    yield* Deferred.await(firstWatchFinalized);
    yield* Fiber.join(watching);
    assertEquals(promptCalls, 1);

    yield* Deferred.succeed(releasePromptWork, undefined);
    yield* Deferred.await(promptWorkCompleted);
    yield* pollEventually(
      restartedGateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
        Effect.map((id) => id === RUNNER_ID),
      ),
      "the runner did not reconnect and republish its session after a transient restart",
    );
    assertEquals(
      yield* restartedGateway.getSessionRunner(WORKSPACE_ID, READY_SESSION_ID),
      RUNNER_ID,
    );
    assertEquals(
      yield* restartedGateway.getSessionRunner(WORKSPACE_ID, STOPPED_SESSION_ID),
      RUNNER_ID,
    );
    assertEquals(
      yield* restartedGateway.getSessionRunner(WORKSPACE_ID, TOMBSTONED_SESSION_ID),
      null,
    );
    assert(
      catalogSessionIds.has(READY_SESSION_ID),
      "the reconnect snapshot did not repair the catalog",
    );
    assertEquals(
      launched.pollUnsafe(),
      undefined,
      "a transient restart terminated the runner layer",
    );

    const replayed = yield* restartedGateway.watchSession(WORKSPACE_ID, SESSION_ID).pipe(
      Stream.take(1),
      Stream.runCollect,
    );
    assertEquals(Array.from(replayed), [replayedEvent]);
    assertEquals(watchCalls, 2);
    assertEquals(promptCalls, 1);
    yield* Fiber.interrupt(launched);
  }))));

Deno.test("WatchRunner observes a state change during manifest-to-live handoff", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const manifestStarted = yield* Deferred.make<void>();
    const releaseManifest = yield* Deferred.make<void>();
    const stateChanges = yield* PubSub.unbounded<SessionStateChange>();
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
    const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
      provideRunnerServices(store, events),
      Effect.exit,
      Effect.forkScoped,
    );

    yield* Deferred.await(manifestStarted);
    current = snapshot("running");
    yield* PubSub.publish(stateChanges, {
      type: "updated" as const,
      sessionId: decode(SessionId)(SESSION_ID),
    });
    yield* Deferred.succeed(releaseManifest, undefined);

    yield* pollUntil(
      harness.gateway.getSessionSnapshot(WORKSPACE_ID, SESSION_ID).pipe(
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
    const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
      provideRunnerServices(store, events),
      Effect.exit,
      Effect.forkScoped,
    );

    yield* pollUntil(
      harness.gateway.getSessionGitSnapshot(WORKSPACE_ID, SESSION_ID).pipe(
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
          return {
            ok: true as const,
            mutationRevision: GitMutationRevision.make(7),
          };
        }),
    };
    const supervisor = {
      findOrRestoreActor: () => Effect.succeed(actor),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
      provideRunnerServices(store, events, supervisor),
      Effect.exit,
      Effect.forkScoped,
    );

    yield* pollUntil(
      harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
        Effect.map((id) => id !== null),
      ),
      "the connected runner did not publish its ready session",
    );
    const result = yield* harness.gateway.updateSessionGitFile({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      action: "stage",
      path: "src/main.ts",
    });
    assertEquals(result.status, "accepted");
    assert(
      result.status === "accepted" && result.acknowledgement instanceof GitFileUpdateAccepted,
    );
    if (result.status === "accepted") {
      assertEquals(result.acknowledgement.mutationRevision, GitMutationRevision.make(7));
    }
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
      findOrRestoreActor: () => Effect.succeed(actor),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
      provideRunnerServices(store, events, supervisor),
      Effect.exit,
      Effect.forkScoped,
    );

    yield* pollUntil(
      harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
        Effect.map((id) => id !== null),
      ),
      "the connected runner did not publish its ready session",
    );
    const modelRuntime = {
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "high" as const,
      credential: { type: "api_key" as const, value: "model-secret" },
    };
    const result = yield* harness.gateway.wakeSession({
      workspaceId: WORKSPACE_ID,
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

Deno.test("Prompt, thinking-level, and Abort RPCs resolve and call the session actor", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const submissionId = 42;
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [snapshot("running")], errors: [] }),
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
          return { ok: true as const, submissionId };
        }),
      setThinkingLevel: () =>
        Effect.sync(() => {
          calls.push("thinking-level");
          return { ok: true as const, level: "xhigh" as const };
        }),
      abort: (payload: unknown) =>
        Effect.sync(() => {
          assertEquals(payload, decode(AbortSessionPayload)({ sessionId: SESSION_ID }));
          calls.push("abort");
          return { ok: true as const };
        }),
    };
    const supervisor = {
      findActor: () => actor,
      findOrRestoreActor: () => Effect.succeed(actor),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
      provideRunnerServices(store, events, supervisor),
      Effect.exit,
      Effect.forkScoped,
    );

    yield* pollUntil(
      harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
        Effect.map((id) => id !== null),
      ),
      "the connected runner did not publish its running session",
    );
    const prompted = yield* harness.gateway.promptSession({
      workspaceId: WORKSPACE_ID,
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
    assertEquals(prompted.acknowledgement.submissionId, submissionId);

    const changed = yield* harness.gateway.setSessionThinkingLevel({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      level: "xhigh",
    });
    assertEquals(changed, { status: "accepted", acknowledgement: "xhigh" });

    const aborted = yield* harness.gateway.abortSession({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    });
    assert(aborted.status === "accepted");
    assert(aborted.acknowledgement instanceof AbortSessionAccepted);
    assertEquals(calls, ["prompt", "thinking-level", "abort"]);
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
      findActor: () => undefined,
      findOrRestoreActor: () => Effect.succeed(actor),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
      provideRunnerServices(store, events, supervisor),
      Effect.exit,
      Effect.forkScoped,
    );

    yield* pollUntil(
      harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
        Effect.map((id) => id !== null),
      ),
      "the connected runner did not publish its ready session",
    );
    const stopped = yield* harness.gateway.stopSession({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    });
    assert(stopped.status === "accepted");
    assert(stopped.acknowledgement instanceof StopSessionAccepted);
    assertEquals(stopCalls, 1);
    yield* Fiber.interrupt(launched);
  }))));

Deno.test("Delete RPC rejects busy work, cleans an idle session, and publishes removal", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = {
      loadSessionManifest: () => Effect.succeed({ sessions: [snapshot("ready")], errors: [] }),
    } as unknown as RunnerSessionStore;
    const removed: string[] = [];
    const events = {
      watchStateChanges: () => Stream.empty,
      watch: () => Stream.empty,
      publishRemoved: (sessionId: string) =>
        Effect.sync(() => {
          removed.push(sessionId);
        }),
    } as unknown as SessionEvents;
    let busy = true;
    let deleteCalls = 0;
    const supervisor = {
      deleteSession: () =>
        Effect.gen(function* () {
          deleteCalls++;
          if (busy) {
            return { ok: false as const, message: "Wait for active session work to finish." };
          }
          yield* events.publishRemoved(decode(SessionId)(SESSION_ID));
          return { ok: true as const };
        }),
      findActor: () => undefined,
      findOrRestoreActor: () => Effect.die("unexpected actor restore"),
      provision: () => Effect.die("unexpected provision"),
    } as unknown as SessionSupervisor;
    const harness = yield* makeGatewayHarness(TOKEN);
    const launched = yield* runRunnerRpc(runnerOptions(harness.url)).pipe(
      provideRunnerServices(store, events, supervisor),
      Effect.exit,
      Effect.forkScoped,
    );
    yield* pollUntil(
      harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID).pipe(
        Effect.map((id) => id !== null),
      ),
      "the connected runner did not publish its ready session",
    );

    yield* harness.gateway.deleteSession({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
    yield* pollUntil(
      Effect.sync(() => deleteCalls === 1),
      "runner deletion was not requested",
    );
    assertEquals(removed, []);
    busy = false;
    yield* Effect.sleep(1_100);
    yield* pollUntil(
      Effect.sync(() => deleteCalls === 2 && removed.length === 1),
      "runner deletion did not publish session removal",
    );
    assertEquals(removed, [SESSION_ID]);
    assertEquals(yield* harness.gateway.getSessionRunner(WORKSPACE_ID, SESSION_ID), null);
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
      runnerOptions(harness.url, "openorb_runner_rejected"),
    ).pipe(
      provideRunnerServices(store, events),
      Effect.exit,
      Effect.forkScoped,
    );

    const exit = yield* pollFiber(launched, "Layer.launch remained running after close 4401");
    assert(Exit.isSuccess(exit), "the Effect.exit wrapper must expose RPC-layer termination");
    assert(Exit.isFailure(exit.value), "the launched RPC layer must terminate with failure");
  }))));

Deno.test("launched runner bulk RPC layer terminates after permanent close 4401", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const harness = yield* makeGatewayHarness(TOKEN);
    const store = {
      readGitSnapshotPatchChunk: () => Effect.die("unexpected patch read"),
    } as unknown as RunnerSessionStore;
    const launched = yield* runRunnerBulkRpc(
      runnerOptions(harness.url, "openorb_runner_rejected"),
    ).pipe(
      Effect.provideService(RunnerSessionStore, store),
      Effect.provideService(SessionArtifactStore, unexpectedArtifactStore),
      Effect.exit,
      Effect.forkScoped,
    );

    const exit = yield* pollFiber(launched, "bulk Layer.launch remained running after close 4401");
    assert(Exit.isSuccess(exit), "the Effect.exit wrapper must expose bulk RPC-layer termination");
    assert(Exit.isFailure(exit.value), "the launched bulk RPC layer must terminate with failure");
  }))));

function runnerOptions(
  gatewayUrl: string,
  runnerToken = TOKEN,
) {
  return {
    gatewayUrl,
    runnerId,
    runnerToken,
    runnerVersion: "test-1",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    getCapacity: () => Promise.resolve(capacity),
  };
}

function provideRunnerServices(
  store: RunnerSessionStore,
  events: SessionEvents,
  supervisor: SessionSupervisor = {
    findActor: () => undefined,
    findOrRestoreActor: () => Effect.die("unexpected actor restore"),
    provision: () => Effect.die("unexpected provision"),
  } as unknown as SessionSupervisor,
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(RunnerSessionStore, store),
      Effect.provideService(
        SessionSupervisor,
        Object.assign(
          { withLiveState: (snapshot: RunnerSessionSnapshot) => snapshot },
          supervisor,
        ),
      ),
      Effect.provideService(SessionEvents, events),
    );
}

const unexpectedArtifactStore = SessionArtifactStore.of({
  publish: () => Effect.die("unexpected artifact publish"),
  readChunk: () => Effect.die("unexpected artifact read"),
});

const pollUntil = (predicate: Effect.Effect<boolean>, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt++) {
      if (yield* predicate) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(message);
  });

const pollEventually = (predicate: Effect.Effect<boolean>, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (yield* predicate) return;
      yield* Effect.sleep(25);
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

const makeGatewayHarness = Effect.fn(function* (
  validToken: string,
  catalogSessionIds: Set<string> = new Set(),
  tombstonedSessionIds: ReadonlySet<string> = new Set(),
) {
  const repository: Parameters<typeof makeRunnerRegistry>[0] = {
    authenticateRunner: (token: string) =>
      Promise.resolve(token === validToken ? { id: RUNNER_ID, workspaceId: WORKSPACE_ID } : null),
    reconcileSessionManifestEntries: (
      _workspaceId: WorkspaceId,
      entries: RunnerSessionSnapshot[],
    ) => {
      const rejected: RejectedSessionManifestEntry[] = [];
      const tombstones = entries.filter((entry) => tombstonedSessionIds.has(entry.id)).map((
        entry,
      ) => entry.id);
      const accepted = entries.filter((entry) => !tombstonedSessionIds.has(entry.id)).map((
        entry,
      ) => entry.id);
      for (const sessionId of accepted) catalogSessionIds.add(sessionId);
      return Promise.resolve(
        [{
          acceptedSessionIds: accepted,
          tombstonedSessionIds: tombstones,
          rejected,
        }, undefined] as const,
      );
    },
  };
  let gateway = yield* makeRunnerRegistry(repository);
  const gatewayScope = yield* Effect.scope;
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const connection = request.url.includes("/bulk")
      ? gateway.acceptBulk(socket)
      : gateway.accept(socket);
    yield* Effect.forkIn(
      connection,
      gatewayScope,
    );
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
  return {
    get gateway() {
      return gateway;
    },
    restart: Effect.fn(function* () {
      const previousGateway = gateway;
      gateway = yield* makeRunnerRegistry(repository);
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
