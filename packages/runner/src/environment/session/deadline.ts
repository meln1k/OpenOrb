import { Effect, Fiber } from "effect";

/**
 * Bound the caller even when a provider's release is uninterruptible. The operation retains its
 * ownership until it really exits: callers must not discard its resource handle after timeout.
 */
export function withDeadline<A, E>(operation: Effect.Effect<A, E>, milliseconds: number) {
  return Effect.gen(function* () {
    const fiber = yield* operation.pipe(Effect.interruptible, Effect.forkDetach);
    return yield* Fiber.join(fiber).pipe(
      Effect.timeout(milliseconds),
      Effect.onError(() => Fiber.interrupt(fiber).pipe(Effect.forkDetach, Effect.asVoid)),
      Effect.interruptible,
    );
  });
}
