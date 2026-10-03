import { assert, assertEquals } from "@std/assert";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  type ConversationView,
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { Effect, Stream } from "effect";
import { conversationViews } from "../../../src/harness/durable/events.ts";
import { until } from "./helpers.ts";

Deno.test("full views, reconnect, and bounded slow consumer coalescing", async () => {
  const harness = await Harness.open(new MemoryStorage(), {
    models: createModels(),
    registry: createRegistry(),
  }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT);
  const state = await conversation.viewState(BACKGROUND_CONTEXT);
  const views: ConversationView[] = [];
  let replica: ConversationView | undefined;
  const gate = Promise.withResolvers<void>();
  const controller = new AbortController();
  await conversation.configure(
    { instructions: "initial instructions" },
    BACKGROUND_CONTEXT,
  );
  const consumer = Effect.runPromiseExit(
    conversationViews(conversation).pipe(
      Stream.runForEach((view) =>
        Effect.promise(async () => {
          views.push(view);
          replica = view;
          if (views.length === 1) await gate.promise;
        })
      ),
    ),
    { signal: controller.signal },
  );
  try {
    await until(() => views.length === 1);
    assertEquals(replica, state.value);
    for (let n = 0; n < 140; n++) {
      await conversation.configure({ instructions: `instruction-${n}` }, BACKGROUND_CONTEXT);
    }
    gate.resolve();
    await until(() => JSON.stringify(replica) === JSON.stringify(state.value));
    assert(views.length < 110, "slow consumers should coalesce views, not buffer indefinitely");
    assert(views.length > 1);
    const reconnect = await Effect.runPromise(
      conversationViews(conversation).pipe(Stream.take(1), Stream.runCollect),
    );
    assertEquals(reconnect, [state.value]);
  } finally {
    gate.resolve();
    controller.abort();
    await consumer;
    state.dispose();
    await harness.close(BACKGROUND_CONTEXT);
  }
});
