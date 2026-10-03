import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { HistoryReadError, SessionId, WatchSessionEvent } from "@openorb/protocol/runner-api";
import { Deferred, Effect, Schema, Stream } from "effect";

import { createSessionEventStream } from "@/app/actions/api/sessions/session-event-stream.ts";

const encoder = new TextDecoder();

Deno.test("SSE forwards raw structural frames without cursors or semantic rewriting", async () => {
  const event = Schema.decodeUnknownSync(WatchSessionEvent)({
    event: {
      type: "conversation.ops",
      ops: [["s", ["docs", "pi.live"], { tools: [{ name: "read", output: "raw output" }] }]],
    },
  });
  const body = await Effect.runPromise(createSessionEventStream(Stream.make(event)));
  const chunk = await body.getReader().read();
  assert(!chunk.done);
  const text = encoder.decode(chunk.value);
  assertEquals(text.includes("id:"), false);
  assertStringIncludes(text, '"output":"raw output"');
  assertStringIncludes(text, JSON.stringify(event.event));
});

Deno.test("SSE snapshot is a full replacement with no EventSource id", async () => {
  const event = Schema.decodeUnknownSync(WatchSessionEvent)({
    event: {
      type: "conversation.snapshot",
      view: { conversation: { id: 0 }, entries: [], docs: {} },
    },
  });
  const body = await Effect.runPromise(createSessionEventStream(Stream.make(event)));
  const chunk = await body.getReader().read();
  assert(!chunk.done);
  assertEquals(
    encoder.decode(chunk.value),
    `event: session\ndata: ${JSON.stringify(event.event)}\n\n`,
  );
});

Deno.test("SSE preserves every operation batch for a slow consumer", async () => {
  const events = Array.from(
    { length: 512 },
    (_, index) =>
      Schema.decodeUnknownSync(WatchSessionEvent)({
        event: { type: "conversation.ops", ops: [["s", ["docs", "counter"], { value: index }]] },
      }),
  );
  const stream = await Effect.runPromise(createSessionEventStream(Stream.fromIterable(events)));
  const reader = stream.getReader();
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += encoder.decode(chunk.value);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assertEquals(text.split("event: session").length - 1, events.length);
  for (const event of events) assertStringIncludes(text, JSON.stringify(event.event));
});

Deno.test("SSE closes when the runner watch ends instead of retaining only keepalives", async () => {
  const body = await Effect.runPromise(
    createSessionEventStream(Stream.fromIterable<typeof WatchSessionEvent.Type>([])),
  );

  assertEquals(await body.getReader().read(), { value: undefined, done: true });
});

Deno.test("SSE closes cleanly after a baseline when the runner watch overflows so EventSource can reconnect", async () => {
  const event = Schema.decodeUnknownSync(WatchSessionEvent)({
    event: {
      type: "conversation.snapshot",
      view: { conversation: { id: 0 }, entries: [], docs: {} },
    },
  });
  const body = await Effect.runPromise(
    createSessionEventStream(
      Stream.make(event).pipe(Stream.concat(Stream.fail(
        new HistoryReadError({
          sessionId: SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134c10"),
          message: "Session subscriber fell behind; reconnect for a fresh snapshot.",
        }),
      ))),
    ),
  );

  assertEquals(
    await new Response(body).text(),
    `event: session\ndata: ${JSON.stringify(event.event)}\n\n`,
  );
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
