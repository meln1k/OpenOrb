import { assert, assertEquals } from "@std/assert";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { ClientRequestId } from "@openorb/protocol/runner-api";
import { SessionEvents } from "../../../src/session/events.ts";
import { createInput, eventually, MODEL, SESSION_ID, withFixture } from "./fixture.ts";
import { sessionEventCodec } from "../../../src/session/actor/state.ts";
import { AgentEnvironmentError } from "../../../src/environment/agent-environment.ts";

Deno.test("model submission starts before setup readiness; Stop pauses instead of Abort", () =>
  withFixture(
    ({ factory, fake, environments, store }) =>
      Effect.gen(function* () {
        const actor = yield* factory.spawn(createInput);
        yield* eventually(() => fake.requests.length === 1);
        assertEquals(
          fake.requests,
          [SESSION_ID],
          "initial prompt has a stable Durable deduplication key",
        );
        assert(actor.active, "booting consumes capacity before any guest tool runs");
        assertEquals((yield* store.readMetadata(SESSION_ID)).environmentState, "starting");
        const tool = yield* Effect.exit(fake.opened[0]!.environment.readFile("x")).pipe(
          Effect.forkChild,
        );
        assertEquals(yield* actor.stop({ sessionId: SESSION_ID }), { ok: true });
        assert(Exit.isFailure(yield* Fiber.join(tool)));
        assertEquals(fake.closes, 1);
        assertEquals(fake.aborts, 0);
        assertEquals(environments[0]?.stops, 1);
        assertEquals((yield* store.readMetadata(SESSION_ID)).environmentState, "stopped");
        assertEquals(actor.active, false);
      }),
    (environment) => {
      environment.setup = Effect.never;
    },
  ));

Deno.test("harness readiness follows project setup and is replayed after start and restart", () => {
  let ready: Deferred.Deferred<void>;
  return withFixture(({ factory, fake }) =>
    Effect.gen(function* () {
      ready = yield* Deferred.make<void>();
      yield* factory.spawn(createInput);
      yield* eventually(() => fake.requests.length === 1);
      const options = fake.opened[0]!;
      const states: string[] = [];
      const watcher = yield* options.environmentStates.pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            states.push(state);
          })
        ),
        Effect.forkChild,
      );
      yield* eventually(() => states.length === 1);
      assertEquals(states, ["starting"], "no discovery signal until setup finishes");
      yield* Deferred.succeed(ready, undefined);
      yield* eventually(() => states.includes("running"));
      assertEquals(yield* options.environmentStates.pipe(Stream.take(1), Stream.runCollect), [
        "running",
      ]);
      yield* options.controlEnvironment("restart");
      yield* eventually(() => states.filter((state) => state === "running").length === 2);
      assertEquals(states, ["starting", "running", "stopping", "stopped", "starting", "running"]);
      yield* Fiber.interrupt(watcher);
    }), (environment) => {
    environment.setup = Effect.suspend(() => Deferred.await(ready));
  });
});

Deno.test("Abort leaves VM live; host stop and restart do not close or pause the agent", () =>
  withFixture(
    ({ factory, fake, environments, attaches }) =>
      Effect.gen(function* () {
        const actor = yield* factory.spawn(createInput);
        yield* eventually(() =>
          fake.opened.length === 1 &&
          environments[0]?.commands.some((c) => c.some((v) => v.includes(".agents/setup"))) === true
        );
        const control = fake.opened[0]!.controlEnvironment;
        yield* control("start");
        yield* eventually(() => actor.agentState === "running");
        assertEquals(yield* actor.abort({ sessionId: SESSION_ID }), {
          ok: true,
        });
        assertEquals(fake.aborts, 1);
        assertEquals(actor.agentState, "idle");
        assertEquals((yield* actor.abort({ sessionId: SESSION_ID })).ok, false);
        assertEquals(fake.aborts, 1);
        assert(actor.active);
        assertEquals(environments[0]?.stops, 0);
        yield* fake.setBusy(true);
        yield* control("stop");
        assertEquals(fake.closes, 0);
        assertEquals(actor.active, false);
        assert(Exit.isFailure(yield* Effect.exit(fake.opened[0]!.environment.access("x"))));
        yield* control("start");
        assertEquals(environments.length, 2);
        assertEquals(attaches[0]?.rootDiskPath, attaches[1]?.rootDiskPath);
        assert(environments[1]?.commands.some((c) => c.some((v) => v.includes(".agents/resume"))));
        assertEquals(fake.opened.length, 1);
        yield* actor.stop({ sessionId: SESSION_ID });
        yield* actor.wake({ sessionId: SESSION_ID, modelRuntime: MODEL });
        assertEquals(fake.resumes, 1);
        assertEquals(fake.opened.length, 2);
      }),
  ));

Deno.test("restore and observation never boot or resume; unfinished work belongs to Durable", () =>
  withFixture(
    ({ factory, fake, store, environments }) =>
      Effect.gen(function* () {
        const original = yield* factory.spawn(createInput);
        yield* eventually(() => fake.requests.length === 1);
        yield* original.stop({ sessionId: SESSION_ID });
        yield* original.shutdown;
        const actor = yield* factory.spawn({
          ...createInput,
          mode: "restore",
          metadata: yield* store.readMetadata(SESSION_ID),
        });
        const events = yield* SessionEvents;
        yield* events.watch(SESSION_ID).pipe(Stream.take(2), Stream.runCollect);
        assertEquals(actor.active, false);
        assertEquals(environments.length, 1);
        assertEquals(fake.opened.length, 1);
        assertEquals(fake.resumes, 0);
        assertEquals(fake.requests.length, 1);
      }),
  ));

Deno.test("actor returns each Durable submission ID and stable retry identity", () =>
  withFixture(({ factory, fake }) =>
    Effect.gen(function* () {
      const actor = yield* factory.spawn(createInput);
      yield* eventually(() => actor.agentState === "running");
      const payload = {
        sessionId: SESSION_ID,
        clientRequestId: ClientRequestId.make("follow-up"),
        prompt: "Continue",
        modelRuntime: MODEL,
      };
      const first = yield* actor.prompt(payload);
      assertEquals(first, { ok: true, submissionId: 3 });
      assertEquals(yield* actor.prompt(payload), first);
      assertEquals(
        yield* actor.prompt({ ...payload, clientRequestId: ClientRequestId.make("next") }),
        {
          ok: true,
          submissionId: 4,
        },
      );
      assertEquals(fake.requests, [SESSION_ID, "follow-up", "next"]);
    })
  ));

Deno.test("failed setup is a warning and actor facts never duplicate Durable task state", () =>
  withFixture(
    ({ factory, fake, journal, store }) =>
      Effect.gen(function* () {
        yield* factory.spawn(createInput);
        yield* eventually(() => fake.requests.length === 1);
        yield* fake.opened[0]!.controlEnvironment("start");
        const metadata = yield* store.readMetadata(SESSION_ID);
        assert(
          metadata.issues.some((issue) =>
            issue.category === "setup" && issue.severity === "warning"
          ),
        );
        const entries = yield* journal.replay(SESSION_ID, sessionEventCodec);
        assert(!entries.some(({ event }) => /^(run|follow-up|abort)\./.test(event.type)));
        assert(!JSON.stringify(entries).includes(MODEL.credential.value));
      }),
    (environment) => {
      environment.setupExitCode = 1;
    },
  ));

Deno.test("idle stop waits for Durable work to settle, and live state carries independent axes", () =>
  withFixture(({ factory, fake }) =>
    Effect.gen(function* () {
      const actor = yield* factory.spawn({ ...createInput, idleTimeoutMs: 20 });
      yield* eventually(() => fake.requests.length === 1);
      yield* fake.opened[0]!.controlEnvironment("start");
      yield* Effect.sleep(60);
      assert(actor.active, "a quiet model or waiting tool is not idle");
      const events = yield* SessionEvents;
      const baseline = yield* events.watch(SESSION_ID).pipe(Stream.take(2), Stream.runCollect);
      const state = baseline[1]?.event;
      assert(state?.type === "session.state");
      assertEquals(state.agentState, "running");
      assertEquals(state.environmentState, "running");
      yield* fake.setBusy(false);
      yield* eventually(() => !actor.active);
      assertEquals(fake.aborts, 0);
      assertEquals(fake.closes, 1);
    })
  ));

Deno.test("concurrent initial Stop and Stop requests finish without reviving startup", () =>
  withFixture(({ factory, fake, store }) =>
    Effect.gen(function* () {
      const actor = yield* factory.spawn(createInput);
      const results = yield* Effect.all([
        actor.stop({ sessionId: SESSION_ID }),
        actor.stop({ sessionId: SESSION_ID }),
      ], { concurrency: "unbounded" });
      assert(results.every((result) => result.ok));
      assertEquals(actor.active, false);
      assertEquals(fake.aborts, 0);
      assertEquals((yield* store.readMetadata(SESSION_ID)).environmentState, "stopped");
    }), (environment) => {
    environment.setup = Effect.never;
  }));

Deno.test("Stop cancels a harness still opening, without waiting for guest readiness", () =>
  withFixture(({ factory, fake }) =>
    Effect.gen(function* () {
      fake.setOpenGate(Effect.never);
      const actor = yield* factory.spawn(createInput);
      yield* eventually(() => fake.opened.length === 1);
      assertEquals(yield* actor.stop({ sessionId: SESSION_ID }), { ok: true });
      assertEquals(fake.requests, []);
      assertEquals(fake.closes, 1);
      assertEquals(actor.active, false);
    }), (environment) => {
    environment.setup = Effect.never;
  }));

Deno.test("failed restore preserves the same disk, while the resumed model need not await the VM", () => {
  let failResume = false;
  return withFixture(({ factory, fake, attaches }) =>
    Effect.gen(function* () {
      const actor = yield* factory.spawn(createInput);
      yield* eventually(() => fake.requests.length === 1);
      yield* fake.opened[0]!.controlEnvironment("start");
      yield* actor.stop({ sessionId: SESSION_ID });
      const path = attaches[0]!.rootDiskPath;
      yield* Effect.promise(() => Deno.writeTextFile(path, "preserved disk"));
      failResume = true;
      assertEquals(yield* actor.wake({ sessionId: SESSION_ID, modelRuntime: MODEL }), { ok: true });
      assertEquals(fake.resumes, 1);
      assert(Exit.isFailure(yield* Effect.exit(fake.opened[1]!.environment.access("x"))));
      assertEquals(attaches[1]?.rootDiskPath, path);
      assertEquals(yield* Effect.promise(() => Deno.readTextFile(path)), "preserved disk");
    }), (environment) => {
    const run = environment.run;
    environment.run = (command, options) =>
      failResume && command.some((part) => part.includes(".agents/resume"))
        ? Effect.fail(new AgentEnvironmentError("injected restore failure", undefined))
        : run(command, options);
  });
});
