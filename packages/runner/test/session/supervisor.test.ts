import { assert, assertEquals } from "@std/assert";
import { Effect, Schema } from "effect";
import { ProvisionSessionPayload } from "@openorb/protocol/runner-api";
import { makeSessionSupervisor } from "../../src/session/supervisor.ts";
import { makeSessionFixture } from "./session-fixture.ts";
import {
  definition,
  eventually,
  metadata,
  MODEL,
  RUNNER_ID,
  SESSION_ID,
  withFixture,
} from "./actor/fixture.ts";

const options = { runnerId: RUNNER_ID, cpuCount: 8, memoryMiB: 16384 };
const provision = Schema.decodeUnknownSync(ProvisionSessionPayload)({
  mode: "create",
  sessionId: SESSION_ID,
  ...definition,
  modelRuntime: MODEL,
});

Deno.test("supervisor counts booting/live compute, not model activity", () =>
  withFixture(
    ({ fake, store }) =>
      Effect.gen(function* () {
        const supervisor = yield* makeSessionSupervisor(options);
        const accepted = yield* supervisor.provision(provision);
        assertEquals(accepted.session.id, SESSION_ID);
        yield* eventually(() => fake.requests.length === 1);
        assertEquals(supervisor.activeSessionCount(), 1);
        const actor = supervisor.findActor(SESSION_ID);
        assert(actor);
        yield* eventually(() => actor.agentState === "running");
        const persisted = yield* store.getSessionSnapshot(SESSION_ID);
        assertEquals(persisted.agentState, "paused", "recovery never assumes a live agent");
        const live = supervisor.withLiveState(persisted);
        assertEquals(live.agentState, "running");
        assertEquals(live.environmentState, "starting");
        assertEquals("activeRunId" in live, false);
        assertEquals(yield* actor.stop({ sessionId: SESSION_ID }), { ok: true });
        assertEquals(supervisor.activeSessionCount(), 0);
        const stopped = supervisor.withLiveState(persisted);
        assertEquals(stopped.agentState, "paused");
        assertEquals(stopped.environmentState, "stopped");
        assertEquals(fake.aborts, 0, "Stop is recoverable pause, not Durable abort");
      }),
    (environment) => {
      environment.setup = Effect.never;
    },
    false,
  ));

Deno.test("startup reconciliation and lazy actor lookup never wake a persisted session", () =>
  withFixture(
    ({ store, journal, fake, environments }) =>
      Effect.gen(function* () {
        const fixture = makeSessionFixture(store, journal, RUNNER_ID);
        yield* fixture.create(SESSION_ID, definition, metadata.createdAt);
        yield* fixture.completeInitialRun(SESSION_ID);
        const supervisor = yield* makeSessionSupervisor(options);
        assertEquals((yield* store.readMetadata(SESSION_ID)).environmentState, "error");
        const actor = yield* supervisor.findOrRestoreActor(SESSION_ID);
        assert(actor);
        assertEquals(actor.active, false);
        assertEquals(environments.length, 0);
        assertEquals(fake.opened.length, 0);
        assertEquals(fake.requests.length, 0);
      }),
  ));

Deno.test("interrupted Stop preserves an error boundary until an explicit wake", () =>
  withFixture(
    ({ store, journal, fake }) =>
      Effect.gen(function* () {
        const fixture = makeSessionFixture(store, journal, RUNNER_ID);
        yield* fixture.create(SESSION_ID, definition, metadata.createdAt);
        yield* fixture.completeInitialRun(SESSION_ID);
        yield* fixture.append(SESSION_ID, { type: "environment.changed", state: "stopping" });
        const supervisor = yield* makeSessionSupervisor(options);
        const recovered = yield* store.readMetadata(SESSION_ID);
        assertEquals(recovered.environmentState, "error");
        assert(recovered.issues.some((issue) => issue.recovery === "restart-environment"));
        assertEquals(fake.opened.length, 0);
        assertEquals(supervisor.activeSessionCount(), 0);
      }),
  ));

Deno.test("provisioning retries use the same stable Durable initial-input request ID", () =>
  withFixture(
    ({ fake, store }) =>
      Effect.gen(function* () {
        const supervisor = yield* makeSessionSupervisor(options);
        yield* supervisor.provision(provision);
        yield* eventually(() => fake.requests.length === 1);
        const actor = supervisor.findActor(SESSION_ID);
        assert(actor);
        yield* actor.stop({ sessionId: SESSION_ID });
        const durable = yield* store.readMetadata(SESSION_ID);
        assertEquals(durable.environmentState, "stopped");
        yield* supervisor.provision(provision);
        assertEquals(
          fake.requests,
          [SESSION_ID],
          "duplicate create must not create or replay another input",
        );
      }),
    undefined,
    false,
  ));
