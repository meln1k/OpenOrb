import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Data, Effect, Predicate, Queue, Schedule, type Scope } from "effect";
import * as Socket from "effect/socket/Socket";
import type { SessionId } from "@openorb/protocol/runner-api";
import type { EnvironmentLinkEnd } from "./relay.ts";

/** Link liveness: the Session Durable Object answers `ping` with `pong` without waking up. */
const LINK_PING_INTERVAL = "10 seconds";
const LINK_SILENCE_LIMIT_MS = 45_000;
const LINK_OPEN_TIMEOUT = "15 seconds";
const ATTACH_TIMEOUT = "15 seconds";
/** A gateway that falls this far behind is treated as gone rather than buffered without bound. */
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

export class EnvironmentLinkError extends Data.TaggedError("EnvironmentLinkError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface DialEnvironmentLinkOptions {
  readonly gatewayUrl: string;
  readonly sessionId: SessionId;
  readonly runnerToken: string;
  readonly nonce: string;
}

export function environmentLinkUrl(gatewayUrl: string, sessionId: SessionId): string {
  const url = new URL(`/api/runners/environments/${sessionId}/link`, gatewayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Dials one Environment Link and authenticates it in-band with the runner token and the one-time
 * attach nonce, like the control socket's identify step. The returned end is valid for the
 * enclosing scope; closing the scope closes the socket.
 */
export const dialEnvironmentLink = Effect.fn("dialEnvironmentLink")(function* (
  options: DialEnvironmentLinkOptions,
): Effect.fn.Return<EnvironmentLinkEnd, EnvironmentLinkError, Scope.Scope> {
  const linkError = (message: string) => (cause: unknown) =>
    new EnvironmentLinkError({ message, cause });
  const socket = yield* Socket.makeWebSocket(
    environmentLinkUrl(options.gatewayUrl, options.sessionId),
    { openTimeout: LINK_OPEN_TIMEOUT },
  ).pipe(
    // ws, not the native WebSocket, as for the control socket: it sets TCP_NODELAY.
    Effect.provide(NodeSocket.layerWebSocketConstructorWS),
  );
  const reader = yield* socket.reader.pipe(
    Effect.mapError(linkError("The Environment Link could not be opened.")),
  );
  const writer = yield* socket.writer;
  yield* writer
    .write(JSON.stringify({ type: "attach", token: options.runnerToken, nonce: options.nonce }))
    .pipe(Effect.mapError(linkError("The Environment Link could not be authenticated.")));

  // The gateway answers the attach message before any frame.
  const answer = yield* reader.pull.pipe(
    Effect.timeout(ATTACH_TIMEOUT),
    Effect.mapError(linkError("The gateway did not accept the Environment Link.")),
  );
  if (answer[0] !== "attached") {
    return yield* new EnvironmentLinkError({
      message: "The gateway refused the Environment Link.",
      cause: undefined,
    });
  }

  const outgoing = yield* Queue.unbounded<Uint8Array | string>();
  let lastSeen = Date.now();
  let queuedBytes = 0;
  let closed = false;
  let push!: ReadableStreamDefaultController<Uint8Array>;
  const messages = new ReadableStream<Uint8Array>({
    start: (controller) => void (push = controller),
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    push.close();
  };
  const enqueue = (chunk: Uint8Array | string) => {
    if (closed) return;
    queuedBytes += chunkBytes(chunk);
    if (queuedBytes > MAX_QUEUED_BYTES) {
      finish();
      return;
    }
    // Synchronous and unbounded so frames keep the order in which the relay produced them.
    Queue.offerUnsafe(outgoing, chunk);
  };
  for (const message of answer.slice(1)) {
    if (!Predicate.isString(message)) push.enqueue(message);
  }

  yield* reader.pull.pipe(
    Effect.flatMap((batch) =>
      Effect.sync(() => {
        lastSeen = Date.now();
        for (const message of batch) {
          // Text messages are link control (`pong`); binary messages are protocol frames.
          if (!Predicate.isString(message) && !closed) push.enqueue(message);
        }
      }),
    ),
    Effect.forever,
    Effect.ensuring(Effect.sync(finish)),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* Queue.take(outgoing).pipe(
    Effect.tap((chunk) => Effect.sync(() => (queuedBytes -= chunkBytes(chunk)))),
    Effect.flatMap((chunk) => writer.write(chunk)),
    Effect.forever,
    Effect.ensuring(Effect.sync(finish)),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* Effect.sync(() => {
    if (Date.now() - lastSeen > LINK_SILENCE_LIMIT_MS) finish();
    else enqueue("ping");
  }).pipe(Effect.repeat(Schedule.spaced(LINK_PING_INTERVAL)), Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    writer.write(new Socket.CloseEvent(1000, "runner closed the link")).pipe(Effect.ignore),
  );

  return {
    send: enqueue,
    messages,
    close: finish,
  } satisfies EnvironmentLinkEnd;
});

function chunkBytes(chunk: Uint8Array | string): number {
  return Predicate.isString(chunk) ? chunk.length : chunk.byteLength;
}
