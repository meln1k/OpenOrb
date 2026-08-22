import { assert, assertEquals } from "@std/assert";

import type { SessionEventPayload } from "@openorb/protocol";
import { createSessionEventStream } from "@/app/actions/api/sessions/session-event-stream.ts";

Deno.test("drops new SSE events after the 128-event buffer fills", async () => {
  const abort = new AbortController();
  const listeners: ((event: SessionEventPayload) => void)[] = [];
  let unsubscribes = 0;
  const subscriptionAbort = new AbortController();
  const stream = createSessionEventStream(abort.signal, (listener) => {
    listeners.push(listener);
    return {
      replay: Promise.resolve(),
      signal: subscriptionAbort.signal,
      unsubscribe() {
        unsubscribes += 1;
      },
    };
  });
  const listener = listeners[0];
  assert(listener);

  const events = Array.from({ length: 129 }, (_, index) => liveEvent(index));
  for (const event of events) listener(event);

  const reader = stream.getReader();
  const received: string[] = [];
  for (let index = 0; index < 128; index++) {
    const result = await reader.read();
    assertEquals(result.done, false);
    assert(result.value);
    received.push(new TextDecoder().decode(result.value));
  }
  assertEquals(received, events.slice(0, 128).map(encodeExpectedEvent));

  const nextEvent = liveEvent(130);
  listener(nextEvent);
  const nextResult = await reader.read();
  assertEquals(nextResult.done, false);
  assert(nextResult.value);
  assertEquals(new TextDecoder().decode(nextResult.value), encodeExpectedEvent(nextEvent));

  abort.abort();
  assertEquals(await reader.read(), { value: undefined, done: true });
  assertEquals(unsubscribes, 1);
});

Deno.test("encodes durable cursors and clears the EventSource cursor on reset", async () => {
  const abort = new AbortController();
  let listener: ((event: SessionEventPayload) => void) | undefined;
  const stream = createSessionEventStream(abort.signal, (publish) => {
    listener = publish;
    return {
      replay: Promise.resolve(),
      signal: new AbortController().signal,
      unsubscribe() {},
    };
  });
  assert(listener);
  listener({ event: { type: "conversation.reset" } });
  listener({
    cursor: 7,
    event: { type: "user.message", messageId: "pi:user:7", text: "Continue" },
  });
  const reader = stream.getReader();

  const reset = await reader.read();
  const resumed = await reader.read();

  assertEquals(
    new TextDecoder().decode(reset.value),
    'id:\nevent: session\ndata: {"type":"conversation.reset"}\n\n',
  );
  assertEquals(
    new TextDecoder().decode(resumed.value),
    'id: 7\nevent: session\ndata: {"type":"user.message","messageId":"pi:user:7","text":"Continue"}\n\n',
  );
  abort.abort();
});

Deno.test("does not send read tool output to the browser", async () => {
  const abort = new AbortController();
  let listener: ((event: SessionEventPayload) => void) | undefined;
  const stream = createSessionEventStream(abort.signal, (publish) => {
    listener = publish;
    return {
      replay: Promise.resolve(),
      signal: new AbortController().signal,
      unsubscribe() {},
    };
  });
  assert(listener);
  listener({
    event: {
      type: "tool.updated",
      toolCallId: "read-1",
      toolName: "read",
      partialResult: "live file contents",
    },
  });
  listener({
    cursor: 8,
    event: {
      type: "tool.completed",
      toolCallId: "read-1",
      toolName: "read",
      result: "durable file contents",
      isError: false,
    },
  });

  const result = await stream.getReader().read();
  assert(result.value);
  const event = new TextDecoder().decode(result.value);

  assertEquals(
    event,
    'id: 8\nevent: session\ndata: {"type":"tool.completed","toolCallId":"read-1","toolName":"read","result":"","isError":false}\n\n',
  );
  assert(!event.includes("live file contents"));
  assert(!event.includes("durable file contents"));
  abort.abort();
});

Deno.test("closes on a dropped durable event so EventSource can resume it", async () => {
  const abort = new AbortController();
  let listener: ((event: SessionEventPayload) => void) | undefined;
  let unsubscribes = 0;
  const stream = createSessionEventStream(abort.signal, (publish) => {
    listener = publish;
    return {
      replay: Promise.resolve(),
      signal: new AbortController().signal,
      unsubscribe() {
        unsubscribes += 1;
      },
    };
  });
  assert(listener);
  for (let index = 0; index < 128; index++) listener(liveEvent(index));

  listener({
    cursor: 1,
    event: { type: "user.message", messageId: "pi:user:1", text: "Durable" },
  });

  const reader = stream.getReader();
  for (let index = 0; index < 128; index++) {
    assertEquals((await reader.read()).done, false);
  }
  assertEquals(await reader.read(), { value: undefined, done: true });
  assertEquals(unsubscribes, 1);
});

Deno.test("closes and unsubscribes when Pi replay fails", async () => {
  const abort = new AbortController();
  let unsubscribes = 0;
  const stream = createSessionEventStream(abort.signal, () => ({
    replay: Promise.reject(new Error("Pi history is unavailable")),
    signal: new AbortController().signal,
    unsubscribe() {
      unsubscribes += 1;
    },
  }));

  assertEquals(await stream.getReader().read(), { value: undefined, done: true });
  assertEquals(unsubscribes, 1);
});

Deno.test("closes and unsubscribes when the runner route disconnects", async () => {
  const requestAbort = new AbortController();
  const routeAbort = new AbortController();
  let unsubscribes = 0;
  const stream = createSessionEventStream(requestAbort.signal, () => ({
    replay: Promise.resolve(),
    signal: routeAbort.signal,
    unsubscribe() {
      unsubscribes += 1;
    },
  }));
  const reader = stream.getReader();

  routeAbort.abort();

  assertEquals(await reader.read(), { value: undefined, done: true });
  assertEquals(unsubscribes, 1);
});

Deno.test("preserves the subscription receiver when the request closes", async () => {
  class ReceiverSensitiveSubscription {
    readonly replay = Promise.resolve();
    readonly signal = new AbortController().signal;
    #active = true;

    unsubscribe() {
      this.#active = false;
    }

    isActive() {
      return this.#active;
    }
  }

  const requestAbort = new AbortController();
  const subscription = new ReceiverSensitiveSubscription();
  const stream = createSessionEventStream(requestAbort.signal, () => subscription);
  const reader = stream.getReader();

  requestAbort.abort();

  assertEquals(await reader.read(), { value: undefined, done: true });
  assertEquals(subscription.isActive(), false);
});

function liveEvent(index: number): SessionEventPayload {
  return {
    event: {
      type: "assistant.text.delta",
      delta: `delta-${index}`,
    },
  };
}

function encodeExpectedEvent(payload: SessionEventPayload): string {
  return `event: session\ndata: ${JSON.stringify(payload.event)}\n\n`;
}
