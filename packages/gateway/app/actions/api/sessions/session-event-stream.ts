import type { WatchSessionEvent } from "@openorb/protocol/runner-api";
import { type Effect, Schedule, Stream } from "effect";

const encoder = new TextEncoder();
const KEEPALIVE_INTERVAL_MS = 15_000;

export function createSessionEventStream(
  events: Stream.Stream<typeof WatchSessionEvent.Type, unknown>,
): Effect.Effect<ReadableStream<Uint8Array>> {
  const keepalive = Stream.fromSchedule(Schedule.spaced(KEEPALIVE_INTERVAL_MS)).pipe(
    Stream.map(() => encoder.encode(": keepalive\n\n")),
  );
  return events.pipe(
    Stream.map(encodeEvent),
    Stream.merge(keepalive, { haltStrategy: "left" }),
    Stream.catchCause(() => Stream.empty),
    Stream.toReadableStreamEffect<Uint8Array>(),
  );
}

function encodeEvent(payload: typeof WatchSessionEvent.Type): Uint8Array {
  return encoder.encode(`event: session\ndata: ${JSON.stringify(payload.event)}\n\n`);
}
