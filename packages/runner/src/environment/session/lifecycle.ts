import { Effect, Exit, Fiber, Option, Scope, Semaphore } from "effect";
import type { EnvironmentState } from "@openorb/protocol/runner-api";
import { type AgentEnvironment, AgentEnvironmentError } from "../agent-environment.ts";
import { withDeadline } from "./deadline.ts";

interface Instance {
  readonly scope: Scope.Closeable;
  boot?: Fiber.Fiber<AgentEnvironment, AgentEnvironmentError>;
  /** Acquired before it is ready, so a stop can release it. */
  environment?: AgentEnvironment;
  detaching?: Fiber.Fiber<void, AgentEnvironmentError>;
  closing?: Fiber.Fiber<void>;
  forced?: boolean;
}

interface EnvironmentLifecycleOptions {
  readonly boot: (
    acquired: (environment: AgentEnvironment) => Effect.Effect<void>,
  ) => Effect.Effect<AgentEnvironment, AgentEnvironmentError, Scope.Scope>;
  /** Reports each state, with the ready guest while it runs. */
  readonly changed: (
    state: EnvironmentState,
    running: AgentEnvironment | undefined,
  ) => Effect.Effect<void>;
  readonly syncDisk: Effect.Effect<void, unknown>;
  readonly warning: (message: string) => Effect.Effect<void>;
  readonly readinessMs?: number;
  readonly shutdownMs?: number;
}

export interface ControlOutcome {
  readonly state: "running" | "stopped";
  /** Stopping forced termination and may have lost unsynced writes. */
  readonly forced: boolean;
}

/**
 * At most one VM per environment, started and stopped under one lock. A start resolves once the
 * guest runs commands; a stop interrupts a boot still in progress.
 */
export const makeEnvironmentLifecycle = Effect.fn("makeEnvironmentLifecycle")(function* (
  options: EnvironmentLifecycleOptions,
) {
  const owner = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const readinessMs = options.readinessMs ?? 120_000;
  const shutdownMs = options.shutdownMs ?? 5_000;
  let instance: Instance | undefined;
  let state: EnvironmentState = "stopped";

  const change = (next: EnvironmentState, running?: AgentEnvironment) =>
    Effect.suspend(() => {
      state = next;
      return options.changed(next, running);
    });
  const stopped = () =>
    new AgentEnvironmentError(
      "The guest environment is stopped. Start it explicitly with the environment tool.",
      undefined,
    );
  const bounded = <A, E>(effect: Effect.Effect<A, E>) =>
    withDeadline(effect, shutdownMs).pipe(
      Effect.mapError(
        () =>
          new AgentEnvironmentError(
            "Environment durability operation failed or timed out.",
            undefined,
          ),
      ),
    );

  const stop = (allowForce: boolean) =>
    Effect.gen(function* () {
      const current = instance;
      if (current === undefined) return false;
      yield* change("stopping");
      if (current.boot) yield* bounded(Fiber.interrupt(current.boot));
      let forced = current.forced ?? false;
      if (current.environment && !current.detaching) {
        const environment = current.environment;
        const sync = yield* Effect.result(
          bounded(
            environment
              .run(["/bin/sync"])
              .pipe(
                Effect.flatMap((result) =>
                  result.exitCode === 0 ? Effect.void : Effect.fail(stopped()),
                ),
              ),
          ),
        );
        if (sync._tag === "Failure") {
          if (!allowForce) return yield* sync.failure;
          forced = true;
          current.forced = true;
          yield* options.warning(
            "Forced environment stop: unsynced guest data may have been lost.",
          );
        }
        // Gondolin stop closes QEMU and releases its disk attachment. Never attach on failure.
        current.detaching = yield* environment.stop.pipe(Effect.uninterruptible, Effect.forkDetach);
      }
      if (current.detaching) {
        // Only a completed failure may be retried. A timed-out detach still owns the disk.
        yield* bounded(
          Fiber.join(current.detaching).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                delete current.detaching;
              }),
            ),
          ),
        );
      }
      current.closing ??= yield* Scope.close(current.scope, Exit.void).pipe(Effect.forkDetach);
      yield* bounded(Fiber.join(current.closing));
      yield* bounded(options.syncDisk);
      instance = undefined;
      yield* change("stopped");
      return forced;
    }).pipe(Effect.tapError(() => change("error")));

  const start = Effect.gen(function* () {
    // A failed boot or stop leaves an instance that may still own the disk: release it first.
    const forced = instance !== undefined && state === "error" ? yield* stop(true) : false;
    if (instance?.boot !== undefined) return { boot: instance.boot, forced };
    const next: Instance = { scope: yield* Scope.make() };
    instance = next;
    yield* change("starting");
    const boot = yield* options
      .boot((environment) =>
        Effect.sync(() => {
          next.environment = environment;
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, next.scope),
        Effect.timeoutOrElse({
          duration: readinessMs,
          orElse: () =>
            Effect.fail(
              new AgentEnvironmentError(
                "The guest environment did not become ready before its deadline.",
                undefined,
              ),
            ),
        }),
        Effect.tap((environment) => change("running", environment)),
        Effect.tapError(() => change("error")),
        Effect.forkIn(owner),
      );
    next.boot = boot;
    return { boot, forced };
  });

  // A boot interrupted by a stop has no error of its own.
  const ready = (boot: Fiber.Fiber<AgentEnvironment, AgentEnvironmentError>) =>
    Fiber.await(boot).pipe(
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.fail(Option.getOrElse(Exit.findErrorOption(exit), stopped)),
      ),
    );

  const control = (action: "start" | "stop" | "restart") =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const stopForced = action === "start" ? false : yield* stop(action === "restart");
          if (action === "stop") return { boot: undefined, forced: stopForced };
          const started = yield* start;
          return { boot: started.boot, forced: stopForced || started.forced };
        }),
      )
      .pipe(
        Effect.flatMap(({ boot, forced }): Effect.Effect<ControlOutcome, AgentEnvironmentError> =>
          boot === undefined
            ? Effect.succeed({ state: "stopped", forced })
            : ready(boot).pipe(Effect.as({ state: "running" as const, forced })),
        ),
      );

  return {
    control,
    stop: lock.withPermit(stop(false)),
    forceStop: lock.withPermit(stop(true)),
    get active() {
      return instance !== undefined;
    },
    get state() {
      return state;
    },
  };
});
