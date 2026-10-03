import { Deferred, Effect, Exit, Fiber, Scope, Semaphore, SubscriptionRef } from "effect";
import type { EnvironmentState } from "@openorb/protocol/runner-api";
import {
  type AgentEnvironment,
  AgentEnvironmentError,
} from "../../environment/agent-environment.ts";
import { withDeadline } from "./deadline.ts";

interface Instance {
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<AgentEnvironment, AgentEnvironmentError>;
  readonly cancelled: Deferred.Deferred<never, AgentEnvironmentError>;
  environment?: AgentEnvironment;
  boot?: Fiber.Fiber<void>;
  detaching?: Fiber.Fiber<void, AgentEnvironmentError>;
  closing?: Fiber.Fiber<void>;
  forced?: boolean;
}

interface EnvironmentLifecycleOptions {
  readonly boot: (
    acquired: (environment: AgentEnvironment) => Effect.Effect<void>,
  ) => Effect.Effect<AgentEnvironment, AgentEnvironmentError, Scope.Scope>;
  readonly changed: (
    state: EnvironmentState,
    forced?: boolean,
  ) => Effect.Effect<void, AgentEnvironmentError>;
  readonly snapshot: (environment: AgentEnvironment) => Effect.Effect<void, unknown>;
  readonly syncDisk: Effect.Effect<void, unknown>;
  readonly warning: (message: string) => Effect.Effect<void>;
  readonly readinessMs?: number;
  readonly shutdownMs?: number;
}

/** One attach at a time. Guest waiters never own or cancel the shared boot fiber. */
export const makeEnvironmentLifecycle = Effect.fn("makeEnvironmentLifecycle")(function* (
  options: EnvironmentLifecycleOptions,
) {
  const owner = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const readinessMs = options.readinessMs ?? 120_000;
  const shutdownMs = options.shutdownMs ?? 5_000;
  let instance: Instance | undefined;
  const state = yield* SubscriptionRef.make<EnvironmentState>("stopped");

  const change = (next: EnvironmentState, forced = false) =>
    Effect.gen(function* () {
      yield* SubscriptionRef.set(state, next);
      yield* options.changed(next, forced);
    });
  const stopped = () =>
    new AgentEnvironmentError(
      "The guest environment is stopped. Start it explicitly with the environment tool.",
      undefined,
    );
  const bounded = <A, E>(effect: Effect.Effect<A, E>) =>
    withDeadline(effect, shutdownMs).pipe(
      Effect.mapError(() =>
        new AgentEnvironmentError(
          "Environment durability operation failed or timed out.",
          undefined,
        )
      ),
    );

  const start = Effect.gen(function* () {
    if (instance !== undefined) {
      if (state.value === "error") {
        return yield* new AgentEnvironmentError(
          "The previous environment must be stopped before another disk attach.",
          undefined,
        );
      }
      return instance;
    }
    const next: Instance = {
      scope: yield* Scope.make(),
      ready: yield* Deferred.make<AgentEnvironment, AgentEnvironmentError>(),
      cancelled: yield* Deferred.make<never, AgentEnvironmentError>(),
    };
    instance = next;
    yield* change("starting");
    next.boot = yield* options.boot((environment) =>
      Effect.sync(() => {
        next.environment = environment;
      })
    ).pipe(
      Effect.provideService(Scope.Scope, next.scope),
      Effect.timeout(readinessMs),
      Effect.mapError(() =>
        new AgentEnvironmentError(
          "The guest environment did not become ready before its deadline.",
          undefined,
        )
      ),
      Effect.flatMap((environment) =>
        change("running").pipe(
          Effect.andThen(Deferred.succeed(next.ready, environment)),
        )
      ),
      Effect.catch((error) =>
        Deferred.fail(next.ready, error).pipe(
          Effect.andThen(change("error")),
          Effect.ignore,
        )
      ),
      Effect.asVoid,
      Effect.forkIn(owner),
    );
    return next;
  });

  const stop = (allowForce: boolean) =>
    Effect.gen(function* () {
      const current = instance;
      if (current === undefined) return false;
      yield* change("stopping");
      yield* Deferred.fail(current.cancelled, stopped());
      yield* Deferred.fail(current.ready, stopped());
      if (current.boot) yield* bounded(Fiber.interrupt(current.boot));
      let forced = current.forced ?? false;
      if (current.environment && !current.detaching) {
        const environment = current.environment;
        // A failed Git refresh must not prevent the filesystem durability boundary.
        yield* bounded(options.snapshot(environment)).pipe(Effect.catch(() =>
          options.warning(
            "The final Git snapshot failed; the previous snapshot was retained.",
          )
        ));
        const sync = yield* Effect.result(bounded(
          environment.run(["/bin/sync"]).pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0 ? Effect.void : Effect.fail(stopped())
            ),
          ),
        ));
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
              })
            ),
          ),
        );
      }
      current.closing ??= yield* Scope.close(current.scope, Exit.void).pipe(Effect.forkDetach);
      yield* bounded(Fiber.join(current.closing));
      yield* bounded(options.syncDisk);
      instance = undefined;
      yield* change("stopped", forced);
      return forced;
    }).pipe(Effect.tapError(() => change("error").pipe(Effect.ignore)));

  const wait = (current: Instance) =>
    Deferred.await(current.ready).pipe(
      Effect.timeout(readinessMs),
      Effect.mapError(() =>
        new AgentEnvironmentError("Guest readiness failed or timed out.", undefined)
      ),
    );
  const use = <A>(
    operation: (environment: AgentEnvironment) => Effect.Effect<A, AgentEnvironmentError>,
    signal?: AbortSignal,
  ) =>
    Effect.suspend(() => {
      const current = instance;
      if (
        !current || state.value === "stopped" || state.value === "stopping" ||
        state.value === "error"
      ) {
        return Effect.fail(stopped());
      }
      const operationWithCancellation = Effect.raceFirst(
        wait(current).pipe(Effect.flatMap(operation)),
        Deferred.await(current.cancelled),
      );
      if (!signal) return operationWithCancellation;
      const aborted = Effect.callback<never, AgentEnvironmentError>((resume) => {
        const cancel = () =>
          resume(Effect.fail(new AgentEnvironmentError("Guest operation cancelled.", undefined)));
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", cancel));
      });
      return Effect.raceFirst(operationWithCancellation, aborted);
    });

  const control = (action: "start" | "stop" | "restart") =>
    lock.withPermit(Effect.gen(function* () {
      const forced = action === "start" ? false : yield* stop(action === "restart");
      const current = action === "stop" ? undefined : yield* start;
      return { current, forced };
    })).pipe(Effect.flatMap(({ current, forced }): Effect.Effect<{
      state: "running" | "stopped";
      forced: boolean;
    }, AgentEnvironmentError> =>
      current === undefined
        ? Effect.succeed({ state: "stopped" as const, forced })
        : wait(current).pipe(Effect.as({ state: "running" as const, forced }))
    ));

  const proxy: AgentEnvironment = {
    run: (command, args) => use((environment) => environment.run(command, args), args?.signal),
    runShell: (command, args) =>
      use((environment) => environment.runShell(command, args), args.signal),
    readFile: (path, args) => use((environment) => environment.readFile(path, args), args?.signal),
    access: (path) => use((environment) => environment.access(path)),
    writeFile: (path, content) => use((environment) => environment.writeFile(path, content)),
    makeDirectory: (path, args) => use((environment) => environment.makeDirectory(path, args)),
    stat: (path) => use((environment) => environment.stat(path)),
    listDirectory: (path) => use((environment) => environment.listDirectory(path)),
    renameFile: (source, destination) =>
      use((environment) => environment.renameFile(source, destination)),
    remove: (path, args) => use((environment) => environment.remove(path, args)),
    detectImageMimeType: (path) => use((environment) => environment.detectImageMimeType(path)),
    stop: control("stop").pipe(Effect.asVoid),
  };
  return {
    proxy,
    control,
    states: SubscriptionRef.changes(state),
    begin: lock.withPermit(start).pipe(Effect.asVoid),
    cancelGuests: Effect.suspend(() =>
      instance ? Deferred.fail(instance.cancelled, stopped()).pipe(Effect.asVoid) : Effect.void
    ),
    stop: lock.withPermit(stop(false)),
    forceStop: lock.withPermit(stop(true)),
    get active() {
      return instance !== undefined;
    },
    get state() {
      return state.value;
    },
  };
});
