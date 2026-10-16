import { test } from "vite-plus/test";
import { assert, assertEquals } from "@jsr/std__assert";
import { Deferred, Effect, Exit, Fiber } from "effect";
import {
  type AgentEnvironment,
  AgentEnvironmentError,
} from "../../../src/environment/agent-environment.ts";
import { makeEnvironmentLifecycle } from "../../../src/environment/session/lifecycle.ts";

function guest(id: number, calls: string[]): AgentEnvironment {
  return {
    run: (command) =>
      Effect.sync(() => {
        calls.push(`${id}:${command[0]}`);
        return { exitCode: id };
      }),
    startDaemon: Effect.die("unexpected Environment Daemon start"),
    stop: Effect.sync(() => {
      calls.push(`${id}:stop`);
    }),
  };
}

test("a start waits for readiness and a failed or timed-out boot is retried by the next start", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        for (const failure of [
          Effect.fail(new AgentEnvironmentError("failed", undefined)),
          Effect.never,
        ]) {
          const states: string[] = [];
          let boots = 0;
          const lifecycle = yield* makeEnvironmentLifecycle({
            boot: () => (++boots === 1 ? failure : Effect.succeed(guest(0, []))),
            readinessMs: 10,
            changed: (state) =>
              Effect.sync(() => {
                states.push(state);
              }),
            syncDisk: Effect.void,
            warning: () => Effect.void,
          });
          assert(Exit.isFailure(yield* Effect.exit(lifecycle.control("start"))));
          assertEquals(lifecycle.state, "error");
          assert(lifecycle.active, "a failed boot keeps its instance until it is released");
          assertEquals(yield* lifecycle.control("start"), { state: "running", forced: false });
          assertEquals(boots, 2);
          assertEquals(states, ["starting", "error", "stopping", "stopped", "starting", "running"]);
          yield* lifecycle.stop;
        }
      }),
    ),
  ));

test("Stop interrupts startup without a late running transition", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const states: string[] = [];
        const lifecycle = yield* makeEnvironmentLifecycle({
          boot: () => Effect.never,
          changed: (state) =>
            Effect.sync(() => {
              states.push(state);
            }),
          syncDisk: Effect.void,
          warning: () => Effect.void,
        });
        const start = yield* Effect.exit(lifecycle.control("start")).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assertEquals(yield* lifecycle.control("stop"), { state: "stopped", forced: false });
        assert(Exit.isFailure(yield* Fiber.join(start)));
        assertEquals(states, ["starting", "stopping", "stopped"]);
        assertEquals(lifecycle.active, false);
      }),
    ),
  ));

test("restart forces a hung sync and boots a new guest", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const warnings: string[] = [];
        let boots = 0;
        const lifecycle = yield* makeEnvironmentLifecycle({
          boot: (acquired) =>
            Effect.gen(function* () {
              const id = ++boots;
              const environment = {
                ...guest(id, calls),
                run: (command: readonly string[]) =>
                  id === 1
                    ? Effect.never
                    : guest(id, calls)
                        .run(command)
                        .pipe(Effect.as({ exitCode: 0 })),
              };
              yield* acquired(environment);
              return environment;
            }),
          shutdownMs: 10,
          changed: () => Effect.void,
          syncDisk: Effect.sync(() => {
            calls.push("host-sync");
          }),
          warning: (message) =>
            Effect.sync(() => {
              warnings.push(message);
            }),
        });
        yield* lifecycle.control("start");
        assertEquals(yield* lifecycle.control("restart"), { state: "running", forced: true });
        assertEquals(calls, ["1:stop", "host-sync"]);
        assert(warnings[0]?.includes("unsynced"));
        yield* lifecycle.stop;
        assertEquals(calls, ["1:stop", "host-sync", "2:/bin/sync", "2:stop", "host-sync"]);
        assertEquals(boots, 2);
      }),
    ),
  ));

test("concurrent starts share one boot and a failed detach never permits a second attach", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
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
      }),
    ),
  ));

test("a timed-out uninterruptible detach remains owned until it actually completes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
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
      }),
    ),
  ));
