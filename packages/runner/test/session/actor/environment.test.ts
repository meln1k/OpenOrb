import { assert, assertEquals } from "@std/assert";
import { Deferred, Effect, Exit, Fiber } from "effect";
import {
  type AgentEnvironment,
  AgentEnvironmentError,
} from "../../../src/environment/agent-environment.ts";
import { makeEnvironmentLifecycle } from "../../../src/session/actor/environment.ts";

function guest(id: number, calls: string[]): AgentEnvironment {
  return {
    run: (command) =>
      Effect.sync(() => {
        calls.push(`${id}:${command[0]}`);
        return { exitCode: id };
      }),
    runShell: () => Effect.succeed({ exitCode: id }),
    readFile: () => Effect.succeed(new Uint8Array([id])),
    access: () => Effect.void,
    writeFile: () => Effect.void,
    makeDirectory: () => Effect.void,
    stat: () => Effect.die("unexpected stat"),
    listDirectory: () => Effect.succeed([String(id)]),
    renameFile: () => Effect.die("unexpected rename"),
    remove: () => Effect.die("unexpected remove"),
    detectImageMimeType: () => Effect.succeed(null),
    stop: Effect.sync(() => {
      calls.push(`${id}:stop`);
    }),
  };
}

Deno.test("lazy guest waiters are cancellable without cancelling shared boot", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const calls: string[] = [];
    const lifecycle = yield* makeEnvironmentLifecycle({
      boot: () => Deferred.await(ready).pipe(Effect.as(guest(0, calls))),
      changed: () => Effect.void,
      snapshot: () => Effect.void,
      syncDisk: Effect.void,
      warning: () => Effect.void,
    });
    yield* lifecycle.begin;
    assert(lifecycle.active);
    const cancelled = yield* lifecycle.proxy.listDirectory("directory").pipe(Effect.forkChild);
    const survivor = yield* lifecycle.proxy.readFile("file").pipe(Effect.forkChild);
    yield* Fiber.interrupt(cancelled);
    yield* Deferred.succeed(ready, undefined);
    assertEquals(Array.from(yield* Fiber.join(survivor)), [0]);
    assertEquals(yield* lifecycle.proxy.listDirectory("directory"), ["0"]);
    yield* lifecycle.stop;
    assert(Exit.isFailure(yield* Effect.exit(lifecycle.proxy.listDirectory("directory"))));
  }))));

Deno.test("failed and timed-out readiness fail tools finitely", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    for (
      const boot of [Effect.fail(new AgentEnvironmentError("failed", undefined)), Effect.never]
    ) {
      const lifecycle = yield* makeEnvironmentLifecycle({
        boot: () => boot,
        readinessMs: 10,
        changed: () => Effect.void,
        snapshot: () => Effect.void,
        syncDisk: Effect.void,
        warning: () => Effect.void,
      });
      yield* lifecycle.begin;
      assert(Exit.isFailure(yield* Effect.exit(lifecycle.proxy.access("x"))));
      yield* lifecycle.stop;
    }
  }))));

Deno.test("Stop interrupts startup and all guest waiters, without a late running transition", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const states: string[] = [];
    const lifecycle = yield* makeEnvironmentLifecycle({
      boot: () => Effect.never,
      changed: (state) =>
        Effect.sync(() => {
          states.push(state);
        }),
      snapshot: () => Effect.void,
      syncDisk: Effect.void,
      warning: () => Effect.void,
    });
    yield* lifecycle.begin;
    const waiter = yield* Effect.exit(lifecycle.proxy.access("x")).pipe(Effect.forkChild);
    yield* lifecycle.stop;
    assert(Exit.isFailure(yield* Fiber.join(waiter)));
    assertEquals(states, ["starting", "stopping", "stopped"]);
    assertEquals(lifecycle.active, false);
  }))));

Deno.test("host restart bypasses a hung guest tool, forces hung sync, and binds new handles", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const calls: string[] = [];
    const warnings: string[] = [];
    let boots = 0;
    const lifecycle = yield* makeEnvironmentLifecycle({
      boot: (acquired) =>
        Effect.gen(function* () {
          const id = ++boots;
          const environment = {
            ...guest(id, calls),
            run: () => id === 1 ? Effect.never : Effect.succeed({ exitCode: 0 }),
          };
          yield* acquired(environment);
          return environment;
        }),
      shutdownMs: 10,
      changed: () => Effect.void,
      snapshot: () => Effect.void,
      syncDisk: Effect.sync(() => {
        calls.push("host-sync");
      }),
      warning: (message) =>
        Effect.sync(() => {
          warnings.push(message);
        }),
    });
    yield* lifecycle.control("start");
    const tool = yield* Effect.exit(lifecycle.proxy.run(["hung"])).pipe(Effect.forkChild);
    assertEquals(yield* lifecycle.control("restart"), { state: "running", forced: true });
    assert(Exit.isFailure(yield* Fiber.join(tool)));
    assertEquals(Array.from(yield* lifecycle.proxy.readFile("x")), [2]);
    assertEquals(calls, ["1:stop", "host-sync"]);
    assert(warnings[0]?.includes("unsynced"));
    yield* lifecycle.stop;
    assert(Exit.isFailure(yield* Effect.exit(lifecycle.proxy.access("x"))));
    assertEquals(boots, 2, "ordinary tools never implicitly boot a stopped VM");
  }))));

Deno.test("concurrent starts share one boot and a failed detach never permits a second attach", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let boots = 0;
    const lifecycle = yield* makeEnvironmentLifecycle({
      boot: (acquired) =>
        Effect.gen(function* () {
          boots++;
          const environment = {
            ...guest(0, []),
            stop: Effect.fail(new AgentEnvironmentError("detach failed", undefined)),
          };
          yield* acquired(environment);
          return environment;
        }),
      changed: () => Effect.void,
      snapshot: () => Effect.void,
      syncDisk: Effect.void,
      warning: () => Effect.void,
    });
    yield* Effect.all([lifecycle.control("start"), lifecycle.control("start")], {
      concurrency: "unbounded",
    });
    assertEquals(boots, 1);
    assert(Exit.isFailure(yield* Effect.exit(lifecycle.control("restart"))));
    assert(Exit.isFailure(yield* Effect.exit(lifecycle.control("start"))));
    assertEquals(boots, 1);
    assert(lifecycle.active, "unconfirmed detach continues consuming capacity");
  }))));

Deno.test("a timed-out uninterruptible detach remains owned until it actually completes", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const detached = yield* Deferred.make<void>();
    let boots = 0;
    let stops = 0;
    const lifecycle = yield* makeEnvironmentLifecycle({
      boot: (acquired) =>
        Effect.gen(function* () {
          const id = ++boots;
          const environment = {
            ...guest(0, []),
            stop: Effect.sync(() => {
              stops++;
            }).pipe(
              Effect.andThen(id === 1 ? Deferred.await(detached) : Effect.void),
              Effect.uninterruptible,
            ),
          };
          yield* acquired(environment);
          return environment;
        }),
      shutdownMs: 10,
      changed: () => Effect.void,
      snapshot: () => Effect.void,
      syncDisk: Effect.void,
      warning: () => Effect.void,
    });
    yield* lifecycle.control("start");
    assert(Exit.isFailure(yield* Effect.exit(lifecycle.control("restart"))));
    assert(Exit.isFailure(yield* Effect.exit(lifecycle.control("restart"))));
    assertEquals(boots, 1);
    assertEquals(
      stops,
      1,
      "retry waits on the original detach rather than trusting a second stop call",
    );
    yield* Deferred.succeed(detached, undefined);
    yield* lifecycle.control("restart");
    assertEquals(boots, 2);
    yield* lifecycle.stop;
  }))));

Deno.test("AbortSignal cancels one readiness waiter, not boot or other guest operations", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const lifecycle = yield* makeEnvironmentLifecycle({
      boot: () => Deferred.await(ready).pipe(Effect.as(guest(0, []))),
      changed: () => Effect.void,
      snapshot: () => Effect.void,
      syncDisk: Effect.void,
      warning: () => Effect.void,
    });
    yield* lifecycle.begin;
    const controller = new AbortController();
    const waiter = yield* Effect.exit(lifecycle.proxy.readFile("x", { signal: controller.signal }))
      .pipe(Effect.forkChild);
    controller.abort();
    assert(Exit.isFailure(yield* Fiber.join(waiter)));
    assertEquals(lifecycle.state, "starting");
    yield* Deferred.succeed(ready, undefined);
    yield* lifecycle.proxy.access("x");
    yield* lifecycle.stop;
  }))));
