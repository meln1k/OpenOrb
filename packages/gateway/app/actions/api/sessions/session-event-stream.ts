import { Channel } from "@std/async";

import type { SessionEventPayload } from "@openorb/protocol";
import { tryAsync, trySync } from "@openorb/result";
import type { SessionEventSubscription } from "@/app/runner-connection-gateway.ts";

const EVENT_BUFFER_CAPACITY = 128;
const KEEPALIVE_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();
const keepalive = encoder.encode(": keepalive\n\n");

export function createSessionEventStream(
  signal: AbortSignal,
  subscribe: (
    listener: (event: SessionEventPayload) => void,
  ) => SessionEventSubscription,
): ReadableStream<Uint8Array> {
  const buffer = new Channel<Uint8Array>({ capacity: EVENT_BUFFER_CAPACITY });
  const cleanup = new DisposableStack();
  cleanup.defer(() => buffer.close());
  let closed = false;
  let drainBuffered = false;
  const close = (drain = false) => {
    if (closed) {
      if (!drain) drainBuffered = false;
      return;
    }
    closed = true;
    drainBuffered = drain;
    cleanup.dispose();
  };
  const abort = () => close();
  cleanup.defer(() => signal.removeEventListener("abort", abort));
  const subscription = subscribe((event) => {
    const browserEvent = eventForBrowser(event);
    if (browserEvent === null || closed || buffer.trySend(encodeEvent(browserEvent))) return;
    // Live deltas are best-effort under backpressure. A dropped durable event or reset would leave
    // a cursor gap, so drain accepted events and let EventSource resume from the last delivered ID.
    if ("cursor" in browserEvent || browserEvent.event.type === "conversation.reset") close(true);
  });
  cleanup.defer(() => subscription.unsubscribe());
  void subscription.replay.catch(() => close());
  const subscriptionClosed = () => close();
  cleanup.defer(() => subscription.signal.removeEventListener("abort", subscriptionClosed));
  subscription.signal.addEventListener("abort", subscriptionClosed, { once: true });
  if (subscription.signal.aborted) close();

  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) close();
  if (!closed) {
    const keepaliveTimer = setInterval(
      () => buffer.trySend(keepalive),
      KEEPALIVE_INTERVAL_MS,
    );
    cleanup.defer(() => clearInterval(keepaliveTimer));
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed && !drainBuffered) {
        trySync(() => controller.close(), () => undefined);
        return;
      }
      const [chunk, receiveError] = await tryAsync(buffer.receive(), () => true);
      if (receiveError !== undefined) {
        trySync(() => controller.close(), () => undefined);
        return;
      }
      if (closed && !drainBuffered) {
        trySync(() => controller.close(), () => undefined);
        return;
      }
      const [, enqueueError] = trySync(
        () => controller.enqueue(chunk),
        () => true,
      );
      if (enqueueError !== undefined) {
        close();
        return;
      }
    },
    cancel() {
      close();
    },
  }, { highWaterMark: 0 });
}

function eventForBrowser(payload: SessionEventPayload): SessionEventPayload | null {
  if (payload.event.type === "tool.updated" && payload.event.toolName === "read") return null;
  if (payload.event.type !== "tool.completed" || payload.event.toolName !== "read") return payload;
  if (!("cursor" in payload)) return payload;
  return { cursor: payload.cursor, event: { ...payload.event, result: "" } };
}

function encodeEvent(payload: SessionEventPayload): Uint8Array {
  const event = `event: session\ndata: ${JSON.stringify(payload.event)}\n\n`;
  if ("cursor" in payload) return encoder.encode(`id: ${payload.cursor}\n${event}`);
  if (payload.event.type === "conversation.reset") return encoder.encode(`id:\n${event}`);
  return encoder.encode(event);
}
