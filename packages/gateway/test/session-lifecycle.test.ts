import { test } from "vite-plus/test";
import { assert, assertEquals, assertRejects } from "@jsr/std__assert";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import type { EnvironmentAction } from "@openorb/protocol/runner-api";
import type { EnvironmentProvider, EnvironmentProviders } from "@openorb/environments";
import { nextAlarm, Session } from "../app/cells/session/session.ts";
import type { Env } from "../app/env.ts";
import { MemoryStorage } from "./workspace/storage.ts";

const MINUTE = 60_000;

/** An environment whose control actions and setup can be held, recorded, and released. */
function fakeEnvironment({ failSetup = false } = {}) {
  const actions: EnvironmentAction[] = [];
  const held = new Map<string, { entered: () => void; finish: Promise<void> }>();
  let releases = 0;
  const hold = (name: EnvironmentAction | "createDir") => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    held.set(name, { entered: entered.resolve, finish: finish.promise });
    return { entered: entered.promise, finish: finish.resolve };
  };
  const pass = async (name: EnvironmentAction | "createDir") => {
    const gate = held.get(name);
    if (gate === undefined) return;
    held.delete(name);
    gate.entered();
    await gate.finish;
  };
  const env: Partial<ExecutionEnv> = {
    id: "fake",
    cwd: "/workspace",
    createDir: async () => {
      await pass("createDir");
      return failSetup ? err(new FileError("unknown", "The disk is full.")) : ok(undefined);
    },
  };
  const provider: EnvironmentProvider = {
    capabilities: { credentials: "none", git: false },
    guestPrompt: [],
    open: (host) => ({
      // SAFETY: a Session without a project and a model without tools only creates /workspace.
      env: env as ExecutionEnv,
      create: () => Promise.resolve(),
      control: async (action) => {
        actions.push(action);
        await pass(action);
        const state = action === "stop" ? "stopped" : "running";
        host.report({ state, reachable: true });
        return { state, forced: false };
      },
      delete: () => Promise.resolve(),
      release: () => releases++,
    }),
  };
  return { provider, actions, hold, releases: () => releases };
}

/**
 * A Session whose model answers without tools, on the given environment providers; `storage`
 * reopens an earlier Session as after an eviction.
 */
function sessionFixture(
  providers: EnvironmentProviders,
  storage = Object.assign(new MemoryStorage(), { deleteAll: () => Promise.resolve() }),
) {
  class TestSession extends Session {
    protected override agentModels(): Models {
      const faux = fauxProvider({ models: [{ id: "demo" }], tokensPerSecond: 1_000_000 });
      faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Answered.")));
      const models = createModels();
      models.setProvider(faux.provider);
      return models;
    }

    protected override environmentProviders(): EnvironmentProviders {
      return providers;
    }
  }
  const open = Harness.open;
  const opened = Promise.withResolvers<Harness>();
  Harness.open = async (storage, options, context) => {
    try {
      const harness = await open(storage, options, context);
      opened.resolve(harness);
      return harness;
    } finally {
      Harness.open = open;
    }
  };
  const pending = new Set<Promise<unknown>>();
  // SAFETY: these Sessions use no Workspace credentials, media, or Worker bindings.
  // oxlint-disable-next-line openorb/no-chained-type-assertions
  const env = { WORKSPACE: { getByName: () => ({}) }, MEDIA: {} } as unknown as Env;
  const session = new TestSession(
    {
      storage,
      // SAFETY: the fake environment uses no facets.
      facets: {} as DurableObjectFacets,
      blockConcurrencyWhile: (callback) => callback(),
      acceptWebSocket: () => {},
      getWebSockets: () => [],
      waitUntil: (promise) => {
        pending.add(promise);
        void promise.finally(() => pending.delete(promise));
      },
    },
    env,
  );
  const submissions = (status?: string) =>
    storage.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM submissions${status ? " WHERE status = ?" : ""}`,
      ...(status ? [status] : []),
    )[0]!.count;
  return {
    session,
    storage,
    harness: opened.promise,
    submissions,
    create: (provider = "fake") =>
      session.create({
        workspaceId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        placement: { provider },
        orbSize: "tiny",
        model: "faux/demo",
        thinkingLevel: "off",
        initialPrompt: "Answer without guest tools.",
        origin: { kind: "user" },
      }),
    drain: async () => {
      while (pending.size !== 0) await Promise.all([...pending]);
    },
  };
}

/** Gives a run that is not held time to reach the model, so its absence is meaningful. */
function scheduled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** Moves the clock past the idle period until disposed. */
function afterIdlePeriod(): Disposable {
  const now = Date.now;
  Date.now = () => now() + 16 * MINUTE;
  return { [Symbol.dispose]: () => (Date.now = now) };
}

test("prompts admitted during setup run once it settles", async () => {
  const environment = fakeEnvironment();
  const setup = environment.hold("createDir");
  const test = sessionFixture({ fake: environment.provider });
  await test.create();
  await setup.entered;
  await test.session.submit({
    origin: { kind: "user" },
    prompt: "Follow up",
    requestId: "follow-up",
  });
  await scheduled();
  // Pi holds both prompts; neither reaches the model before setup settles.
  assertEquals(test.submissions(), 2);
  assertEquals(test.submissions("done"), 0);
  assertEquals(test.session.view()?.state, "provisioning");
  // Setup holds the environment, so the idle agent leaves it alone.
  assertEquals(environment.releases(), 0);
  setup.finish();
  await test.drain();
  assertEquals(test.submissions("done"), 2);
  assertEquals(test.session.view()?.state, "ready");
  assert(environment.releases() > 0, "the settled agent kept its environment's memory");
});

test("abort cancels every prompt admitted during setup", async () => {
  const environment = fakeEnvironment();
  const setup = environment.hold("createDir");
  const test = sessionFixture({ fake: environment.provider });
  await test.create();
  await setup.entered;
  await test.session.submit({ origin: { kind: "user" }, prompt: "Second", requestId: "second" });
  await test.session.submit({ origin: { kind: "user" }, prompt: "Third", requestId: "third" });
  await scheduled();
  assertEquals(test.submissions("done"), 0);
  await test.session.abort();
  setup.finish();
  await test.drain();
  assertEquals(test.submissions("done"), 0);
  assertEquals(test.submissions(), 3);
  // Abort leaves the environment running.
  assertEquals(test.session.view()?.environmentState, "running");
});

test("a failed setup still runs the agent on the running environment", async () => {
  const environment = fakeEnvironment({ failSetup: true });
  const test = sessionFixture({ fake: environment.provider });
  await test.create();
  await test.drain();
  assertEquals(test.session.view()?.state, "error");
  assertEquals(test.session.view()?.environmentState, "running");
  assertEquals(test.submissions("done"), 1);
});

test("Stop Session aborts queued prompts, and the next prompt starts compute", async () => {
  const environment = fakeEnvironment();
  const setup = environment.hold("createDir");
  const test = sessionFixture({ fake: environment.provider });
  await test.create();
  await setup.entered;
  const stopped = test.session.stop();
  setup.finish();
  assertEquals((await stopped).state, "stopped");
  await test.drain();
  assertEquals(test.submissions("done"), 0);
  assertEquals(test.session.view()?.state, "stopped");
  assertEquals(environment.actions, ["start", "stop"]);

  await test.session.submit({
    origin: { kind: "user" },
    prompt: "Start again",
    requestId: "start-again",
  });
  await test.drain();
  assertEquals(environment.actions, ["start", "stop", "start"]);
  assertEquals(test.submissions("done"), 1);
  assertEquals(test.session.view()?.environmentState, "running");
});

test("a prompt admitted during Stop runs after it, on started compute", async () => {
  const environment = fakeEnvironment();
  const test = sessionFixture({ fake: environment.provider });
  await test.create();
  await test.drain();
  const stop = environment.hold("stop");
  const stopped = test.session.stop();
  await stop.entered;
  await test.session.submit({
    origin: { kind: "user" },
    prompt: "After stop",
    requestId: "after-stop",
  });
  await scheduled();
  // It waits for the stop and the start queued behind it.
  assertEquals(test.submissions("done"), 1);
  stop.finish();
  await stopped;
  await test.drain();
  assertEquals(environment.actions, ["start", "stop", "start"]);
  assertEquals(test.submissions("done"), 2);
  assertEquals(test.session.view()?.environmentState, "running");
});

test("a prompt during an idle stop starts compute only after the stop", async () => {
  const environment = fakeEnvironment();
  const test = sessionFixture({ fake: environment.provider });
  await test.create();
  await test.drain();
  const stop = environment.hold("stop");
  let alarm: Promise<void>;
  {
    using _later = afterIdlePeriod();
    alarm = test.session.alarm();
    await stop.entered;
  }
  await test.session.submit({
    origin: { kind: "user" },
    prompt: "Resume",
    requestId: "resume-during-stop",
  });
  assertEquals(environment.actions, ["start", "stop"]);
  stop.finish();
  await alarm;
  await test.drain();
  assertEquals(environment.actions, ["start", "stop", "start"]);
  assertEquals(test.submissions("done"), 2);
  assertEquals(test.session.view()?.environmentState, "running");
});

test("idle stop rechecks setup that starts during its inspection", async () => {
  const environment = fakeEnvironment();
  const test = sessionFixture({ fake: environment.provider });
  await test.create();
  await test.drain();
  const harness = await test.harness;
  const inspect = harness.inspect.bind(harness);
  const inspected = Promise.withResolvers<void>();
  const finishInspection = Promise.withResolvers<void>();
  harness.inspect = async (context) => {
    const snapshot = await inspect(context);
    inspected.resolve();
    await finishInspection.promise;
    return snapshot;
  };
  using _later = afterIdlePeriod();
  using _restore = {
    [Symbol.dispose]: () => {
      harness.inspect = inspect;
      finishInspection.resolve();
    },
  };
  const alarm = test.session.alarm();
  await inspected.promise;
  const setup = environment.hold("createDir");
  await test.session.retry("retry-provisioning");
  await setup.entered;
  finishInspection.resolve();
  await alarm;
  assert(!environment.actions.includes("stop"), "idle stop raced active setup");
  setup.finish();
  await test.drain();
  assertEquals(test.session.view()?.environmentState, "running");
});

test("concurrent admission persists recovery despite a held decision", async () => {
  const environment = fakeEnvironment();
  const test = sessionFixture({ fake: environment.provider });
  await test.create();
  await test.drain();
  const harness = await test.harness;
  const inspect = harness.inspect.bind(harness);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let held = false;
  harness.inspect = async (context) => {
    const snapshot = await inspect(context);
    if (!held) {
      held = true;
      entered.resolve();
      await finish.promise;
    }
    return snapshot;
  };
  using _restore = {
    [Symbol.dispose]: () => {
      harness.inspect = inspect;
      finish.resolve();
    },
  };
  const alarm = test.session.alarm();
  await entered.promise;
  // Alarm delivery consumes the old alarm; every newly accepted input needs another one.
  test.storage.alarm = null;
  const exec = test.storage.sql.exec;
  test.storage.sql.exec = (query, ...bindings) => {
    if (query.includes("INSERT INTO submissions")) {
      assert(test.storage.alarm !== null, "input accepted without a persisted recovery alarm");
    }
    return exec(query, ...bindings);
  };
  const first = test.session.submit({
    origin: { kind: "user" },
    prompt: "First",
    requestId: "first",
  });
  const second = test.session.submit({
    origin: { kind: "user" },
    prompt: "Second",
    requestId: "second",
  });
  // Let both RPCs reach admission while the earlier decision is still held.
  await new Promise((resolve) => setTimeout(resolve, 0));
  finish.resolve();
  await Promise.all([alarm, first, second]);
  await test.drain();
  assertEquals(test.submissions("done"), 3);
});

test("a placement its provider cannot open is rejected at creation", async () => {
  const test = sessionFixture({
    fake: fakeEnvironment().provider,
    broken: {
      ...fakeEnvironment().provider,
      open: () => {
        throw new Error("The placement names no runner.");
      },
    },
  });
  await assertRejects(() => test.create("boat"), Error, 'There is no "boat" environment provider');
  assertEquals(test.session.view(), null);
  await assertRejects(() => test.create("broken"), Error, "The placement names no runner.");
  assertEquals(test.session.view(), null);
  // Nothing was recorded, so the Session can still be created on a working placement.
  assertEquals((await test.create("fake")).created, true);
});

test("the next alarm follows unfinished work, distant retries, and idle compute", () => {
  const now = 1_000 * MINUTE;
  const running = {
    environment: { state: "running", reachable: true },
    lastActivityAt: now - MINUTE,
    deleting: false,
  } as const;
  const stopped = { ...running, environment: { state: "stopped", reachable: true } } as const;
  const base = { now, resumeAt: undefined, hostWait: false };
  // Work sleeps until a distant retry, unless this object already waits for it.
  const retry = now + 5 * MINUTE;
  assertEquals(nextAlarm({ ...base, record: stopped, tasks: 1, resumeAt: retry }), retry);
  assertEquals(
    nextAlarm({ ...base, record: stopped, tasks: 1, resumeAt: retry, hostWait: true }),
    now + 30_000,
  );
  assertEquals(
    nextAlarm({ ...base, record: stopped, tasks: 1, resumeAt: now + 45_000 }),
    now + 30_000,
  );
  // Idle compute wakes the Session to stop it once the idle period has passed.
  assertEquals(nextAlarm({ ...base, record: running, tasks: 0 }), now + 14 * MINUTE);
  assertEquals(
    nextAlarm({ ...base, record: { ...running, lastActivityAt: now - 20 * MINUTE }, tasks: 0 }),
    now + 30_000,
  );
  // Setup and deletion recover after an eviction; idle stopped compute needs no alarm.
  assertEquals(
    nextAlarm({ ...base, record: { ...stopped, operation: "provisioning" }, tasks: 0 }),
    now + 30_000,
  );
  assertEquals(
    nextAlarm({ ...base, record: { ...stopped, deleting: true }, tasks: 0 }),
    now + 30_000,
  );
  assertEquals(nextAlarm({ ...base, record: stopped, tasks: 0 }), undefined);
});
