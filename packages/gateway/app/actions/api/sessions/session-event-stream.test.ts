import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { WatchSessionEvent } from "@openorb/protocol/runner-api";
import { Deferred, Effect, Schema, Stream } from "effect";

import { createSessionEventStream } from "@/app/actions/api/sessions/session-event-stream.ts";

const encoder = new TextDecoder();

Deno.test("SSE encodes durable cursors and redacts read results", async () => {
  const event = Schema.decodeUnknownSync(WatchSessionEvent)({
    runId: null,
    cursor: 7,
    event: {
      type: "tool.completed",
      toolCallId: "tool-1",
      toolName: "read",
      result: "secret",
      isError: false,
    },
  });
  const body = await Effect.runPromise(createSessionEventStream(Stream.make(event)));
  const chunk = await body.getReader().read();
  assert(!chunk.done);
  const text = encoder.decode(chunk.value);
  assertStringIncludes(text, "id: 7");
  assertStringIncludes(text, '"result":""');
  assertEquals(text.includes("secret"), false);
});

Deno.test("SSE reset clears the EventSource cursor with an empty id", async () => {
  const event = Schema.decodeUnknownSync(WatchSessionEvent)({
    runId: null,
    event: { type: "conversation.reset" },
  });
  const body = await Effect.runPromise(createSessionEventStream(Stream.make(event)));
  const chunk = await body.getReader().read();
  assert(!chunk.done);
  assertEquals(
    encoder.decode(chunk.value),
    'id:\nevent: session\ndata: {"type":"conversation.reset"}\n\n',
  );
});

Deno.test("SSE closes when the runner watch ends instead of retaining only keepalives", async () => {
  const body = await Effect.runPromise(
    createSessionEventStream(Stream.fromIterable<typeof WatchSessionEvent.Type>([])),
  );

  assertEquals(await body.getReader().read(), { value: undefined, done: true });
});

Deno.test("SSE closes cleanly when the runner watch fails so EventSource can reconnect", async () => {
  const body = await Effect.runPromise(
    createSessionEventStream(Stream.fail(new Error("Runner disconnected."))),
  );

  assertEquals(await body.getReader().read(), { value: undefined, done: true });
});

Deno.test("cancelling SSE interrupts the matching Effect stream", async () => {
  const finalized = await Effect.runPromise(Deferred.make<void>());
  const started = await Effect.runPromise(Deferred.make<void>());
  const events = Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
    Stream.flatMap(() => Stream.never),
    Stream.ensuring(Deferred.succeed(finalized, undefined)),
    Stream.concat(Stream.fromIterable<typeof WatchSessionEvent.Type>([])),
  );
  const body = await Effect.runPromise(createSessionEventStream(events));
  const reader = body.getReader();
  const pending = reader.read();
  await Effect.runPromise(Deferred.await(started));
  await reader.cancel();
  await Effect.runPromise(Deferred.await(finalized));
  assertEquals((await pending).done, true);
});
