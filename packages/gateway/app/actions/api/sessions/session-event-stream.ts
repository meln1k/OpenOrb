import type { WatchSessionEvent } from "@openorb/protocol/runner-api";
import { type Effect, Result, Schedule, Stream } from "effect";

const encoder = new TextEncoder();
const KEEPALIVE_INTERVAL_MS = 15_000;

export function createSessionEventStream(
  events: Stream.Stream<typeof WatchSessionEvent.Type, unknown>,
): Effect.Effect<ReadableStream<Uint8Array>> {
  const keepalive = Stream.fromSchedule(Schedule.spaced(KEEPALIVE_INTERVAL_MS)).pipe(
    Stream.map(() => encoder.encode(": keepalive\n\n")),
  );
  return events.pipe(
    Stream.filterMap(eventForBrowser),
    Stream.map(encodeEvent),
    Stream.merge(keepalive),
    Stream.toReadableStreamEffect<Uint8Array>(),
  );
}

function eventForBrowser(
  payload: typeof WatchSessionEvent.Type,
): Result.Result<typeof WatchSessionEvent.Type, void> {
  if (payload.event.type === "tool.updated" && payload.event.toolName === "read") {
    return Result.fail(undefined);
  }
  if (
    payload.event.type !== "tool.completed" || payload.event.toolName !== "read" ||
    !("cursor" in payload)
  ) {
    return Result.succeed(payload);
  }
  return Result.succeed({ ...payload, event: { ...payload.event, result: "" } });
}

function encodeEvent(payload: typeof WatchSessionEvent.Type): Uint8Array {
  const event = `event: session\ndata: ${JSON.stringify(payload.event)}\n\n`;
  if ("cursor" in payload) return encoder.encode(`id: ${payload.cursor}\n${event}`);
  return encoder.encode(payload.event.type === "conversation.reset" ? `id:\n${event}` : event);
}
