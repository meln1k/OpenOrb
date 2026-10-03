// deno-lint-ignore-file openorb/no-chained-type-assertions -- event-service tests supply only the two store reads they exercise
import { assert, assertEquals } from "@std/assert";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { JsonObject } from "@earendil-works/pi-durable";
import { type ConversationFrame, SessionEvent, SessionId } from "@openorb/protocol/runner-api";
import { MAX_RUNNER_RPC_FRAME_BYTES } from "@openorb/protocol/runner-api-limits";
import { SessionArtifactId } from "@openorb/protocol/runner-bulk-api";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import { Buffer } from "node:buffer";
import { Effect, Exit, Fiber, Layer, PubSub, Schema, Scope, Stream } from "effect";
import {
  AgentHarnessError,
  type AgentHarnessSession,
  type ConversationView,
} from "@/src/harness/agent-harness.ts";
import { makeSessionEvents, type SessionEvents } from "@/src/session/events.ts";
import {
  makeSessionArtifactStore,
  SessionArtifactStore,
  SessionArtifactStoreError,
} from "@/src/session/artifact-store.ts";
import { RunnerSessionStore } from "@/src/session/store.ts";

const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134c10");
const INITIAL = view({ "pi.live": { text: "" } });
const STATE = {
  type: "session.state",
  stage: "stopped",
  agentState: "paused",
  environmentState: "stopped",
  checkoutState: "available",
  issues: [],
} as const;

Deno.test("offline watch opens only unscheduled private Durable storage and reconnects with a baseline", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await withEvents(async (events) => {
      const first = await collectBaseline(events);
      const second = await collectBaseline(events);
      assertEquals(first, second);
      assertEquals(first.map((item) => item.event.type), [
        "conversation.snapshot",
        "session.state",
      ]);
      assertEquals(first[1]?.event, STATE);
      assertEquals((await Deno.stat(`${directory}/harness.sqlite`)).mode! & 0o777, 0o600);
      assertEquals((await Deno.stat(directory)).mode! & 0o777, 0o700);
    }, { directory });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("live reconnect gets a replacement snapshot and latest independent lifecycle states", async () => {
  let reads = 0;
  await withEvents(async (events, scope) => {
    const harness = await fakeHarness();
    await open(events, scope, harness.acquire);
    await Effect.runPromise(events.publishLive(SESSION_ID, {
      ...STATE,
      stage: "running",
      agentState: "running",
      environmentState: "running",
    }));
    for (let n = 0; n < 3; n++) {
      const baseline = await collectBaseline(events);
      assertEquals(baseline[0], {
        event: { type: "conversation.snapshot", view: INITIAL },
      });
      assertEquals(baseline[1]?.event, {
        ...STATE,
        stage: "running",
        agentState: "running",
        environmentState: "running",
      });
    }
    assertEquals(reads, 0);
  }, {
    readView: () => {
      reads++;
      return Promise.resolve(INITIAL);
    },
  });
});

Deno.test("skipped full views reconstruct the latest browser replica without intermediate deltas", async () => {
  const revisions = Array.from(
    { length: 6 },
    (_, n) => view({ "pi.live": { text: `output ${"x".repeat(n + 1)}` } }),
  );
  const final = revisions[5]!;
  await withEvents(async (events, scope) => {
    const harness = await fakeHarness();
    await open(events, scope, harness.acquire);
    const started = Promise.withResolvers<void>();
    let replica = INITIAL;
    const frames: ConversationFrame[] = [];
    const watching = Effect.runFork(
      events.watch(SESSION_ID).pipe(
        Stream.tap((item) =>
          Effect.sync(() => {
            const frame = item.event;
            if (frame.type !== "conversation.snapshot" && frame.type !== "conversation.ops") return;
            frames.push(frame);
            replica = frame.type === "conversation.snapshot"
              ? frame.view
              : applyImmutable(replica, frame.ops);
            started.resolve();
          })
        ),
        Stream.takeUntil(() => replica.docs["pi.live"]?.text === final.docs["pi.live"]?.text),
        Stream.runDrain,
      ),
    );
    try {
      await started.promise;
      // A repeated initial value is a no-op; upstream may coalesce all other omitted revisions.
      await harness.emit(structuredClone(INITIAL));
      await harness.emit(revisions[1]!);
      await harness.emit(final);
      await Effect.runPromise(Fiber.join(watching).pipe(Effect.timeout("5 seconds")));
      assertEquals(replica, final);
      assertEquals(frames.map((frame) => frame.type), [
        "conversation.snapshot",
        "conversation.ops",
        "conversation.ops",
      ]);
      assertEquals((await collectBaseline(events))[0]?.event, {
        type: "conversation.snapshot",
        view: final,
      });
    } finally {
      await Effect.runPromise(Fiber.interrupt(watching));
    }
  });
});

Deno.test("slow conversation watchers coalesce before and after the baseline without losing infrastructure events", async () => {
  await withEvents(async (events, scope) => {
    const harness = await fakeHarness();
    await open(events, scope, harness.acquire);
    const blocked = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const healthyReady = Promise.withResolvers<void>();
    const healthyUpdated = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const finals = [
      view({}, [{ id: 1, conversationId: 1, kind: "message", text: "complete" }]),
      view({ "pi.live": { text: "next turn" } }),
    ];
    let replica = INITIAL;
    let healthyReplica = INITIAL;
    const frames: ConversationFrame[] = [];
    const infrastructure: typeof SessionEvent.Type[] = [];
    const watching = Effect.runFork(
      events.watch(SESSION_ID).pipe(
        Stream.tap((item) =>
          Effect.promise(async () => {
            const frame = item.event;
            if (frame.type !== "conversation.snapshot" && frame.type !== "conversation.ops") {
              infrastructure.push(frame);
              return;
            }
            replica = frame.type === "conversation.snapshot"
              ? frame.view
              : applyImmutable(replica, frame.ops);
            frames.push(frame);
            const index = frames.length - 1;
            if (index < 2) {
              blocked[index]!.resolve();
              await release[index]!.promise;
            }
          })
        ),
        Stream.takeUntil(() => frames.length === 3 && infrastructure.length === 9),
        Stream.runDrain,
      ),
    );
    const healthy = Effect.runFork(
      events.watch(SESSION_ID).pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            const frame = item.event;
            if (frame.type === "session.state") healthyReady.resolve();
            if (frame.type === "conversation.snapshot") healthyReplica = frame.view;
            if (frame.type === "conversation.ops") {
              healthyReplica = applyImmutable(healthyReplica, frame.ops);
            }
            if (healthyReplica.entries.length === 1) healthyUpdated[0]!.resolve();
            if (healthyReplica.docs["pi.live"]?.text === "next turn") healthyUpdated[1]!.resolve();
          })
        ),
      ),
    );
    const infra = [
      { ...STATE, agentState: "running" },
      { type: "provisioning.log", stream: "stdout", text: "booting" },
      { type: "git.snapshot.updated" },
      { ...STATE, agentState: "idle" },
    ] as const;
    try {
      await healthyReady.promise;
      for (let round = 0; round < 2; round++) {
        await blocked[round]!.promise;
        for (let n = 0; n < 200; n++) {
          await harness.emit(view({ "pi.live": { text: `${round}:${n}` } }));
          if (n < infra.length) await Effect.runPromise(events.publishLive(SESSION_ID, infra[n]));
        }
        await harness.emit(finals[round]!);
        await Effect.runPromise(
          Effect.promise(() => healthyUpdated[round]!.promise).pipe(Effect.timeout("5 seconds")),
        );
        assertEquals(healthyReplica, finals[round]);
        assertEquals(frames.length, round + 1);
        release[round]!.resolve();
        if (round === 0) {
          await blocked[1]!.promise;
          assertEquals(replica, finals[0]);
        }
      }
      await Effect.runPromise(Fiber.join(watching).pipe(Effect.timeout("5 seconds")));
      assertEquals(replica, finals[1]);
      assertEquals(frames.map((frame) => frame.type), [
        "conversation.snapshot",
        "conversation.ops",
        "conversation.ops",
      ]);
      assertEquals(infrastructure, [STATE, ...infra, ...infra]);
      assertEquals(harness.closed(), 0);
      assertEquals(harness.watchers(), 1);
    } finally {
      for (const gate of release) gate.resolve();
      await Effect.runPromise(Fiber.interrupt(watching));
      await Effect.runPromise(Fiber.interrupt(healthy));
    }
  });
});

for (const pending of [64, 65]) {
  Deno.test(`slow watcher with ${pending} pending infrastructure events preserves the capacity boundary and isolates overflow`, async () => {
    await withEvents(async (events, scope) => {
      const harness = await fakeHarness();
      await open(events, scope, harness.acquire);
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const healthyReady = Promise.withResolvers<void>();
      const received = Array.from({ length: pending }, () => Promise.withResolvers<void>());
      let healthyCount = 0;
      const watching = Effect.runFork(
        events.watch(SESSION_ID).pipe(
          Stream.tap((item) =>
            Effect.promise(async () => {
              // Consume the whole baseline before blocking, leaving exactly 64 queue slots.
              if (item.event.type === "session.state") {
                blocked.resolve();
                await release.promise;
              }
            })
          ),
          Stream.take(pending + 2),
          Stream.runCollect,
          Effect.result,
        ),
      );
      const healthy = Effect.runFork(
        events.watch(SESSION_ID).pipe(
          Stream.tap((item) =>
            Effect.sync(() => {
              const frame = item.event;
              if (frame.type === "session.state") healthyReady.resolve();
              if (frame.type === "git.snapshot.updated") received[healthyCount++]!.resolve();
            })
          ),
          Stream.take(pending + 2),
          Stream.runCollect,
        ),
      );
      try {
        await Promise.all([blocked.promise, healthyReady.promise]);
        for (let n = 0; n < pending; n++) {
          await Effect.runPromise(events.publishLive(SESSION_ID, { type: "git.snapshot.updated" }));
          await Effect.runPromise(
            Effect.promise(() => received[n]!.promise).pipe(Effect.timeout("5 seconds")),
          );
        }
        const delivered = await Effect.runPromise(
          Fiber.join(healthy).pipe(Effect.timeout("5 seconds")),
        );
        assertEquals(
          delivered.filter((item) => item.event.type === "git.snapshot.updated").length,
          pending,
        );
        assertEquals(harness.closed(), 0);
        assertEquals(harness.watchers(), 1);

        release.resolve();
        const result = await Effect.runPromise(
          Fiber.join(watching).pipe(Effect.timeout("5 seconds")),
        );
        if (pending === 64) {
          assert(result._tag === "Success");
          assertEquals(result.success, delivered);
        } else {
          assert(result._tag === "Failure");
          assertEquals(result.failure._tag, "HistoryReadError");
          assertEquals(
            result.failure.message,
            "Session subscriber fell behind; reconnect for a fresh snapshot.",
          );
        }
        await Effect.runPromise(events.publishLive(SESSION_ID, {
          ...STATE,
          agentState: "idle",
        }));
        assertEquals(await collectBaseline(events), [
          { event: { type: "conversation.snapshot", view: INITIAL } },
          { event: { ...STATE, agentState: "idle" } },
        ]);
      } finally {
        release.resolve();
        await Effect.runPromise(Fiber.interrupt(watching));
        await Effect.runPromise(Fiber.interrupt(healthy));
      }
    });
  });
}

Deno.test("watch survives pause and reopen; the old owner's stream is finalized", async () => {
  const paused = view({ "pi.live": { text: "committed during pause" } });
  let stored = INITIAL;
  await withEvents(async (events) => {
    const firstScope = await Effect.runPromise(Scope.make());
    const secondScope = await Effect.runPromise(Scope.make());
    const first = await fakeHarness(INITIAL, () => {
      stored = paused;
      return Promise.resolve();
    });
    const next = view({ "pi.live": { text: "reopened" } });
    const second = await fakeHarness(next);
    await open(events, firstScope, first.acquire);
    const initial = Promise.withResolvers<void>();
    const pauseDelivered = Promise.withResolvers<void>();
    let replica = INITIAL;
    const revisions: ConversationView[] = [];
    const watching = Effect.runFork(
      events.watch(SESSION_ID).pipe(
        Stream.tap((item) =>
          Effect.sync(() => {
            const frame = item.event;
            if (frame.type !== "conversation.snapshot" && frame.type !== "conversation.ops") return;
            replica = frame.type === "conversation.snapshot"
              ? frame.view
              : applyImmutable(replica, frame.ops);
            revisions.push(replica);
            initial.resolve();
            if (replica.docs["pi.live"]?.text === "committed during pause") {
              pauseDelivered.resolve();
            }
          })
        ),
        Stream.takeUntil(() => replica.docs["pi.live"]?.text === "reopened"),
        Stream.runDrain,
      ),
    );
    try {
      await initial.promise;
      await Effect.runPromise(Scope.close(firstScope, Exit.void));
      assertEquals(first.closed(), 1);
      assertEquals(first.watchers(), 0);
      await Effect.runPromise(
        Effect.promise(() => pauseDelivered.promise).pipe(Effect.timeout("5 seconds")),
      );
      await open(events, secondScope, second.acquire);
      await Effect.runPromise(Fiber.join(watching).pipe(Effect.timeout("5 seconds")));
      assertEquals(revisions, [INITIAL, paused, next]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(watching));
      await Effect.runPromise(Scope.close(firstScope, Exit.void));
      await Effect.runPromise(Scope.close(secondScope, Exit.void));
    }
    assertEquals(second.watchers(), 0);
  }, { readView: () => Promise.resolve(stored) });
});

Deno.test("cancelled offline reads retain ownership until their read handles close", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reading = false;
  await withEvents(async (events, scope) => {
    const watching = Effect.runFork(events.watch(SESSION_ID).pipe(Stream.take(1), Stream.runDrain));
    await started.promise;
    const interrupted = Effect.runPromise(Fiber.interrupt(watching));
    let opened = false;
    const harness = await fakeHarness();
    const opening = open(
      events,
      scope,
      Effect.sync(() => {
        assertEquals(reading, false);
        opened = true;
      }).pipe(Effect.andThen(harness.acquire)),
    );
    await Effect.runPromise(Effect.yieldNow);
    assertEquals(opened, false);
    release.resolve();
    await interrupted;
    await opening;
    assertEquals(opened, true);
  }, {
    readView: async () => {
      reading = true;
      started.resolve();
      await release.promise;
      reading = false;
      return INITIAL;
    },
  });
});

Deno.test("replacement acquisition waits for prior owner close and permits cancelled waiters", async () => {
  await withEvents(async (events) => {
    const firstScope = await Effect.runPromise(Scope.make());
    const nextScope = await Effect.runPromise(Scope.make());
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = await fakeHarness(INITIAL, async () => {
      closing.resolve();
      await release.promise;
    });
    const next = await fakeHarness();
    await open(events, firstScope, first.acquire);
    const cancelled = Effect.runFork(
      events.openConversation(SESSION_ID, next.acquire).pipe(Effect.scoped),
    );
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Fiber.interrupt(cancelled).pipe(Effect.timeout("2 seconds")));
    let opened = false;
    const opening = open(events, nextScope, next.acquire).then(() => {
      opened = true;
    });
    const close = Effect.runPromise(Scope.close(firstScope, Exit.void));
    await closing.promise;
    assertEquals(opened, false);
    release.resolve();
    await close;
    await opening;
    assertEquals(opened, true);
    await Effect.runPromise(Scope.close(nextScope, Exit.void));
  });
});

Deno.test("failed acquisition rolls back its scope and releases ownership for offline reads", async () => {
  let closed = false;
  let reads = 0;
  await withEvents(async (events, scope) => {
    const failure = await Effect.runPromiseExit(
      events.openConversation(
        SESSION_ID,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            })
          );
          return yield* new AgentHarnessError("failed open", undefined);
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    assert(Exit.isFailure(failure));
    assert(closed);
    await collectBaseline(events);
    assertEquals(reads, 1);
  }, {
    readView: () => {
      reads++;
      return Promise.resolve(INITIAL);
    },
  });
});

Deno.test("removal closes owners and watchers and emits a typed registry notification", async () => {
  await withEvents(async (events, scope) => {
    const harness = await fakeHarness();
    await open(events, scope, harness.acquire);
    const stateWatch = Effect.runFork(
      events.watchStateChanges().pipe(Stream.take(1), Stream.runCollect),
    );
    const sessionWatch = Effect.runFork(events.watch(SESSION_ID).pipe(Stream.runDrain));
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(events.publishRemoved(SESSION_ID));
    assertEquals(await Effect.runPromise(Fiber.join(stateWatch)), [{
      type: "removed",
      sessionId: SESSION_ID,
    }]);
    await Effect.runPromise(Fiber.join(sessionWatch).pipe(Effect.timeout("2 seconds")));
    assertEquals(harness.closed(), 1);
    assertEquals(harness.watchers(), 0);
  });
});

Deno.test("service scope cleanup closes separately scoped owners and all subscriptions", async () => {
  await withEvents(async (events, serviceScope) => {
    const ownerScope = await Effect.runPromise(Scope.make());
    const harness = await fakeHarness();
    try {
      await open(events, ownerScope, harness.acquire);
      const sessionWatch = Effect.runFork(
        events.watch(SESSION_ID).pipe(Stream.runDrain, Effect.exit),
      );
      const stateWatch = Effect.runFork(
        events.watchStateChanges().pipe(Stream.runDrain, Effect.exit),
      );
      await Effect.runPromise(Effect.yieldNow);
      await Effect.runPromise(Scope.close(serviceScope, Exit.void));
      await Effect.runPromise(Fiber.join(sessionWatch).pipe(Effect.timeout("2 seconds")));
      await Effect.runPromise(Fiber.join(stateWatch).pipe(Effect.timeout("2 seconds")));
      assertEquals(harness.closed(), 1);
      assertEquals(harness.watchers(), 0);
      const reopened = await Effect.runPromise(
        events.openConversation(SESSION_ID, harness.acquire).pipe(
          Effect.provideService(Scope.Scope, ownerScope),
          Effect.result,
        ),
      );
      assert(reopened._tag === "Failure");
      assertEquals(reopened.failure._tag, "SessionNotFound");
    } finally {
      await Effect.runPromise(Scope.close(ownerScope, Exit.void));
    }
    assertEquals(harness.closed(), 1);
  });
});

Deno.test("deletion waits for offline reads and cleanup failure preserves a closed retryable boundary", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reading = false;
  await withEvents(async (events) => {
    const watching = Effect.runFork(events.watch(SESSION_ID).pipe(Stream.runDrain));
    await started.promise;
    let deleting = false;
    const cleanup = Effect.sync(() => {
      assertEquals(reading, false);
      deleting = true;
    }).pipe(Effect.andThen(Effect.fail("cleanup failed")));
    const deletingSession = Effect.runPromise(
      events.publishRemoved(SESSION_ID, cleanup).pipe(Effect.result),
    );
    await Effect.runPromise(Effect.yieldNow);
    assertEquals(deleting, false);
    release.resolve();
    assertEquals((await deletingSession)._tag, "Failure");
    await Effect.runPromise(Fiber.join(watching));
    const watchAgain = await Effect.runPromise(
      events.watch(SESSION_ID).pipe(Stream.runDrain, Effect.result),
    );
    assert(watchAgain._tag === "Failure");
    assertEquals(watchAgain.failure._tag, "SessionNotFound");
    let retried = false;
    await Effect.runPromise(events.publishRemoved(
      SESSION_ID,
      Effect.sync(() => {
        retried = true;
      }),
    ));
    assert(retried);
  }, {
    readView: async () => {
      reading = true;
      started.resolve();
      await release.promise;
      reading = false;
      return INITIAL;
    },
  });
});

Deno.test("registry overflow fails explicitly rather than dropping state changes or blocking publishers", async () => {
  await withEvents(async (events) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    const watching = Effect.runFork(
      events.watchStateChanges().pipe(
        Stream.tap(() =>
          Effect.promise(async () => {
            if (++count === 1) {
              started.resolve();
              await release.promise;
            }
          })
        ),
        Stream.runDrain,
        Effect.result,
      ),
    );
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(events.publishLive(SESSION_ID, STATE));
    await started.promise;
    for (let n = 0; n < 130; n++) {
      await Effect.runPromise(events.publishLive(SESSION_ID, STATE));
    }
    release.resolve();
    const result = await Effect.runPromise(Fiber.join(watching).pipe(Effect.timeout("2 seconds")));
    assert(result._tag === "Failure");
    assertEquals(result.failure._tag, "RunnerWatchError");
    assert(count <= 65);
  });
});

Deno.test("infra state requires both lifecycle fields and offline read failures stay typed", async () => {
  await withEvents(async (events) => {
    const invalid = await Effect.runPromise(
      events.publishLive(SESSION_ID, {
        type: "session.state",
        stage: "stopped",
        checkoutState: "available",
        issues: [],
      }).pipe(Effect.result),
    );
    assert(invalid._tag === "Failure");
    const unreadable = await Effect.runPromise(
      events.watch(SESSION_ID).pipe(Stream.runDrain, Effect.result),
    );
    assert(unreadable._tag === "Failure");
    assertEquals(unreadable.failure._tag, "HistoryReadError");
  }, { readView: () => Promise.reject(new Error("private storage error")) });
});

Deno.test("large images leave control snapshots and deltas; offline reconnect reuses persistent bulk media", async () => {
  const directory = await Deno.makeTempDir();
  const bytes = new Uint8Array(1024 * 1024 + 2).fill(93);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = {
    type: "image",
    // Deliberately differs from the PNG header: projection trusts Pi's declared MIME type.
    mimeType: "image/jpeg",
    data: Buffer.from(bytes).toString("base64"),
  };
  const original = view({}, [{
    id: 1,
    conversationId: 1,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolName: "read", toolCallId: "read-1", content: [image] }],
  }]);
  const next = applyImmutable(original, [[
    "a",
    ["entries", 0, "model", 0, "content", 0, "data"],
    "AQID",
  ]]);
  const makeArtifacts = () =>
    Effect.runPromise(
      makeSessionArtifactStore({ workingDirectory: directory }).pipe(
        Effect.provide(Layer.merge(DenoFileSystem.layer, DenoPath.layer)),
      ),
    );
  try {
    await Deno.mkdir(`${directory}/sessions/${SESSION_ID}`, { recursive: true });
    const artifacts = await makeArtifacts();
    let projected: ConversationView | undefined;
    let reads = 0;
    await withEvents(async (events) => {
      const scope = await Effect.runPromise(Scope.make());
      const harness = await fakeHarness(original);
      const session = await open(events, scope, harness.acquire);
      let replica = INITIAL;
      const started = Promise.withResolvers<void>();
      const updated = Promise.withResolvers<void>();
      const frames: ConversationFrame[] = [];
      const watching = Effect.runFork(
        events.watch(SESSION_ID).pipe(
          Stream.runForEach((item) =>
            Effect.sync(() => {
              assert(JSON.stringify(item).length < MAX_RUNNER_RPC_FRAME_BYTES);
              assert(!JSON.stringify(item).includes('"data"'));
              const frame = item.event;
              if (frame.type !== "conversation.snapshot" && frame.type !== "conversation.ops") {
                return;
              }
              replica = frame.type === "conversation.snapshot"
                ? frame.view
                : applyImmutable(replica, frame.ops);
              assert(!JSON.stringify(replica).includes('"data"'));
              frames.push(frame);
              if (frames.length === 1) started.resolve();
              if (frame.type === "conversation.ops") updated.resolve();
            })
          ),
        ),
      );
      try {
        await Effect.runPromise(
          Effect.promise(() => started.promise).pipe(Effect.timeout("5 seconds")),
        );
        await harness.emit(next);
        await Effect.runPromise(
          Effect.promise(() => updated.promise).pipe(Effect.timeout("5 seconds")),
        );
        assertEquals(session.view, next); // Model-facing image data was not rewritten.
        const baseline = (await collectBaseline(events))[0]!.event;
        assert(baseline.type === "conversation.snapshot");
        assertEquals(replica, baseline.view);
        projected = replica;
        await Effect.runPromise(Scope.close(scope, Exit.void));
        assertEquals(reads, 1);
        assertEquals(replica, projected);
        assertEquals(frames.map((frame) => frame.type), [
          "conversation.snapshot",
          "conversation.ops",
        ]);
      } finally {
        await Effect.runPromise(Fiber.interrupt(watching));
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    }, {
      artifacts,
      readView: () => {
        reads++;
        return Promise.resolve(next);
      },
    });

    const restarted = await makeArtifacts();
    await withEvents(async (events) => {
      for (let n = 0; n < 35; n++) {
        const baseline = (await collectBaseline(events))[0]!.event;
        assert(baseline.type === "conversation.snapshot");
        assertEquals(baseline.view, projected);
      }
    }, { artifacts: restarted, readView: () => Promise.resolve(structuredClone(next)) });
    const reference = JSON.stringify(projected).match(/"artifactId":"([^"]+)"/)![1];
    const id = Schema.decodeUnknownSync(SessionArtifactId)(reference);
    const first = await Effect.runPromise(restarted.readChunk(SESSION_ID, id, 0, 1024 * 1024));
    assertEquals(first.artifact.mediaType, "image/jpeg");
    assertEquals(first.artifact.fileName, "image.jpeg");
    const last = await Effect.runPromise(
      restarted.readChunk(SESSION_ID, id, first.bytes.length, 1024 * 1024),
    );
    assertEquals(
      new Uint8Array([...first.bytes, ...last.bytes]),
      new Uint8Array([...bytes, 1, 2, 3]),
    );
    assertEquals(image.data, Buffer.from(bytes).toString("base64"));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("unpublishable images become small placeholders, never inline control payloads", async () => {
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  let publications = 0;
  const original = view({}, [{
    id: 1,
    conversationId: 1,
    kind: "pi.tool-result",
    model: [{
      role: "toolResult",
      content: [
        { type: "image", mimeType: "image/png", data },
        ...["image/svg+xml", "image/unknown", "video/mp4", null, 123].map((mimeType) => ({
          type: "image",
          mimeType,
          data,
        })),
        { type: "image", data },
      ],
    }],
  }]);
  await withEvents(async (events) => {
    const result = JSON.stringify(await collectBaseline(events));
    assert(result.includes("media could not be stored"));
    assertEquals(result.match(/unsupported format/g)?.length, 6);
    assert(!result.includes('"data"'));
    assertEquals(publications, 1);
  }, {
    readView: () => Promise.resolve(original),
    artifacts: {
      publish: () => {
        publications++;
        return new SessionArtifactStoreError("quota exceeded");
      },
      readChunk: () => Effect.die("unexpected read"),
    },
  });
});

function view(
  docs: Record<string, JsonObject>,
  entries: readonly JsonObject[] = [],
): ConversationView {
  const frame = Schema.decodeUnknownSync(SessionEvent)({
    type: "conversation.snapshot",
    view: { conversation: { id: 1 }, docs, entries },
  });
  assert(frame.type === "conversation.snapshot");
  return frame.view;
}

async function fakeHarness(
  initial = INITIAL,
  onClose: () => Promise<void> = () => Promise.resolve(),
) {
  const pubsub = await Effect.runPromise(PubSub.bounded<ConversationView>(1));
  let current = initial;
  let watchers = 0;
  let closed = 0;
  const session: AgentHarnessSession = {
    get view() {
      return current;
    },
    views: Stream.unwrap(Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(pubsub);
      watchers++;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          watchers--;
        })
      );
      return Stream.concat(Stream.succeed(current), Stream.fromSubscription(subscription));
    })),
    updateModelRuntime: () => Effect.void,
    setThinkingLevel: (level) => Effect.succeed(level),
    submit: () => Effect.die("unexpected scheduling"),
    resume: Effect.die("unexpected scheduling"),
    abort: Effect.void,
  };
  return {
    acquire: Effect.acquireRelease(Effect.succeed(session), () =>
      Effect.promise(async () => {
        await onClose();
        closed++;
        await Effect.runPromise(PubSub.shutdown(pubsub));
      })),
    closed: () => closed,
    watchers: () => watchers,
    emit: async (view: ConversationView) => {
      current = view;
      await Effect.runPromise(PubSub.publish(pubsub, view));
      await Effect.runPromise(Effect.yieldNow);
    },
  };
}

async function open(
  events: SessionEvents,
  scope: Scope.Scope,
  acquire: Effect.Effect<AgentHarnessSession, AgentHarnessError, Scope.Scope>,
) {
  const session = await Effect.runPromise(
    events.openConversation(SESSION_ID, acquire).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  await Effect.runPromise(Effect.yieldNow);
  return session;
}

function collectBaseline(events: SessionEvents) {
  return Effect.runPromise(events.watch(SESSION_ID).pipe(Stream.take(2), Stream.runCollect));
}

async function withEvents(
  use: (events: SessionEvents, scope: Scope.Closeable) => Promise<void>,
  options: {
    directory?: string;
    readView?: (directory: string) => Promise<ConversationView>;
    artifacts?: SessionArtifactStore;
  } = {},
) {
  const scope = await Effect.runPromise(Scope.make());
  // SAFETY: This service boundary test reaches only metadata and the harness directory lookup.
  const store = {
    readMetadata: () => Effect.succeed({ state: "stopped", ...STATE }),
    getSessionHarnessDirectory: () => Effect.succeed(options.directory ?? "/unused-harness"),
  } as unknown as RunnerSessionStore;
  try {
    const events = await Effect.runPromise(
      makeSessionEvents({
        ...(options.readView
          ? { readView: options.readView }
          : options.directory
          ? {}
          : { readView: () => Promise.resolve(INITIAL) }),
      }).pipe(
        Effect.provideService(RunnerSessionStore, store),
        Effect.provideService(
          SessionArtifactStore,
          options.artifacts ?? {
            publish: () => Effect.die("unexpected image publication"),
            readChunk: () => Effect.die("unexpected image read"),
          },
        ),
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    await use(events, scope);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}
