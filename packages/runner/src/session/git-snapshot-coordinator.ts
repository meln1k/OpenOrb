import { Effect, type Exit, Queue, Schedule, type Scope, Semaphore, Stream } from "effect";

export interface GitSnapshotCoordinator<E> {
  readonly trigger: Effect.Effect<void>;
  readonly flush: Effect.Effect<Exit.Exit<void, E>>;
}

export const makeGitSnapshotCoordinator = Effect.fn("makeGitSnapshotCoordinator")(
  function* <E>(
    inspect: Effect.Effect<void, E>,
  ): Effect.fn.Return<
    GitSnapshotCoordinator<E>,
    never,
    Scope.Scope
  > {
    const inspections = yield* Queue.sliding<void>(1);
    const inspectionPermit = yield* Semaphore.make(1);
    const runInspection = inspectionPermit.withPermit(inspect);
    yield* Stream.fromQueue(inspections).pipe(
      Stream.runForEach(() => Effect.exit(runInspection).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
    yield* Stream.fromSchedule(Schedule.spaced("15 seconds")).pipe(
      Stream.runForEach(() => Queue.offer(inspections, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
    return {
      trigger: Queue.offer(inspections, undefined).pipe(Effect.asVoid),
      flush: Effect.exit(runInspection),
    };
  },
);
