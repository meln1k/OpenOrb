import type { Conversation, ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect, Queue, Stream } from "effect";
import { AgentHarnessError } from "../agent-harness.ts";

/** Cold stream: each consumer atomically acquires its own initial revision and bounded watch. */
export function conversationViews(
  conversation: Conversation,
): Stream.Stream<ConversationView, AgentHarnessError> {
  return Stream.unwrap(Effect.gen(function* () {
    const queue = yield* Queue.bounded<
      ConversationView,
      AgentHarnessError | import("effect").Cause.Done
    >(1);
    const watch = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => conversation.watch(BACKGROUND_CONTEXT),
        catch: () => new AgentHarnessError("Could not watch the conversation", undefined),
      }),
      (watch) => Effect.promise(() => watch.stop()).pipe(Effect.asVoid),
    );
    yield* Queue.offer(queue, watch.value);
    yield* Effect.sync(() => {
      watch.start(async (value) => {
        await Effect.runPromise(Queue.offer(queue, value));
      });
    });
    yield* Effect.promise(() => watch.closed).pipe(
      Effect.flatMap((end) =>
        end.reason === "listener_error"
          ? Queue.fail(queue, new AgentHarnessError("Conversation watch failed", undefined))
          : Queue.end(queue)
      ),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    return Stream.fromQueue(queue);
  }));
}
