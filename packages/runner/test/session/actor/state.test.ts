import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { Effect, Schema } from "effect";
import { SessionEvent } from "../../../src/session/actor/events.ts";
import {
  applySessionEvent,
  publicSessionState,
  replaySessionState,
} from "../../../src/session/actor/state.ts";
import {
  Journal,
  JournalFailure,
  JournalNotFound,
} from "../../../src/session/persistent-actor/journal.ts";
import { definition, metadata, RUNNER_ID, SESSION_ID } from "./fixture.ts";

Deno.test("infrastructure journal has independent metadata states, no run or abort substates", () => {
  const created = applySessionEvent(undefined, {
    type: "session.provisioning-started",
    id: SESSION_ID,
    runnerId: RUNNER_ID,
    definition,
    createdAt: "2026-08-17T12:00:00Z",
  });
  assert(created);
  const running = applySessionEvent(created, { type: "environment.changed", state: "running" });
  assert(running);
  assertEquals(running.metadata.environmentState, "running");
  assertEquals(
    running.metadata.agentState,
    "paused",
    "agent work is recovered by Durable, not replayed from actor facts",
  );
  const stopping = applySessionEvent(running, { type: "environment.changed", state: "stopping" });
  assert(stopping);
  assertEquals(stopping.metadata.environmentState, "stopping");
  assertEquals(
    applySessionEvent(stopping, { type: "stop.completed" })?.metadata.environmentState,
    "stopped",
  );
  assert(!Schema.is(SessionEvent)({ type: "run.started", runId: "1" }));
  assert(!Schema.is(SessionEvent)({ type: "abort.requested", runId: "1" }));
});

Deno.test("legacy navigation summary does not couple agent and environment lifecycles", () => {
  assertEquals(publicSessionState("running", "stopped"), "running");
  assertEquals(publicSessionState("paused", "running"), "ready");
  assertEquals(publicSessionState("idle", "starting"), "provisioning");
});

Deno.test("session replay uses journal order and the last stored sequence, not event count", async () => {
  const journal: Journal = {
    replay: (id, codec) =>
      Effect.gen(function* () {
        assertEquals(id, SESSION_ID);
        return [
          {
            sequence: 4,
            event: yield* codec.decode({
              type: "session.provisioning-started",
              id: SESSION_ID,
              runnerId: RUNNER_ID,
              definition,
              createdAt: metadata.createdAt,
            }).pipe(Effect.orDie),
          },
          {
            sequence: 9,
            event: yield* codec.decode({ type: "environment.changed", state: "running" }).pipe(
              Effect.orDie,
            ),
          },
          {
            sequence: 17,
            event: yield* codec.decode({ type: "stop.completed" }).pipe(Effect.orDie),
          },
        ];
      }),
    append: () => Effect.die("Recovery must not append"),
  };
  const recovered = await Effect.runPromise(
    replaySessionState(SESSION_ID).pipe(Effect.provideService(Journal, journal)),
  );
  assertEquals(recovered, {
    state: {
      diskInitialized: false,
      metadata: { ...metadata, environmentState: "stopped", state: "stopped" },
    },
    sequence: 17,
  });
});

for (const missing of [false, true]) {
  Deno.test(`${missing ? "missing" : "empty"} journal replays as uninitialized state`, async () => {
    const journal: Journal = {
      replay: () =>
        missing
          ? new JournalNotFound({ persistenceId: SESSION_ID, message: "Missing" })
          : Effect.succeed([]),
      append: () => Effect.die("Recovery must not append"),
    };
    assertEquals(
      await Effect.runPromise(
        replaySessionState(SESSION_ID).pipe(Effect.provideService(Journal, journal)),
      ),
      { state: undefined, sequence: 0 },
    );
  });
}

Deno.test("session recovery preserves journal failures instead of treating them as empty state", async () => {
  const failure = new JournalFailure({
    persistenceId: SESSION_ID,
    operation: "replay",
    message: "Corrupt journal",
    cause: new Error("Invalid event"),
  });
  const journal: Journal = {
    replay: () => failure,
    append: () => Effect.die("Recovery must not append"),
  };
  const error = await Effect.runPromise(
    replaySessionState(SESSION_ID).pipe(Effect.provideService(Journal, journal), Effect.flip),
  );
  assertStrictEquals(error, failure);
});
