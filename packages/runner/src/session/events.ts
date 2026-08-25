import { Context, Effect, Layer, PubSub, Schema, type Scope, Semaphore, Stream } from "effect";
import {
  HistoryReadError,
  type RunId,
  SessionConversationEvent,
  type SessionId,
  SessionLiveEvent,
  SessionNotFound,
  type WatchSessionEvent,
} from "@openorb/protocol/runner-api";
import { readPiSessionEvents } from "../harness/pi/history.ts";
import { RunnerSessionStore } from "./store.ts";

type EventError = HistoryReadError | SessionNotFound;

const SESSION_DURABLE_TAIL_CAPACITY = 2_048;
const SESSION_LIVE_TAIL_CAPACITY = 512;

interface SessionTailItem {
  readonly conversationCursor: number;
  readonly event: typeof WatchSessionEvent.Type;
}

interface SessionFeed {
  readonly events: PubSub.PubSub<SessionTailItem>;
  readonly publishing: Semaphore.Semaphore;
  readonly seen: Set<string>;
  latestState: SessionTailItem;
  cursor: number;
}

export interface SessionEvents {
  readonly watch: (
    sessionId: SessionId,
    afterCursor: number,
  ) => Stream.Stream<typeof WatchSessionEvent.Type, EventError>;
  readonly watchStateChanges: () => Stream.Stream<SessionId>;
  readonly publishConversation: (
    sessionId: SessionId,
    event: unknown,
  ) => Effect.Effect<void, EventError | Schema.SchemaError>;
  readonly publishLive: (
    sessionId: SessionId,
    correlationId: string,
    event: unknown,
  ) => Effect.Effect<void, EventError | Schema.SchemaError>;
}

export const SessionEvents: Context.Service<SessionEvents, SessionEvents> = Context.Service(
  "@openorb/runner/SessionEvents",
);

/** Process-wide replay and live-tail owner. Pi JSONL remains the durable recovery source. */
export function makeSessionEvents(): Effect.Effect<
  SessionEvents,
  never,
  RunnerSessionStore | Scope.Scope
> {
  return Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const stateChanged = yield* PubSub.sliding<SessionId>(64);
    const allocation = yield* Semaphore.make(1);
    const sessions = new Map<SessionId, SessionFeed>();
    const readHistory = (sessionId: SessionId) =>
      store.getSessionPiPaths(sessionId).pipe(
        Effect.catch(() => sessionNotFound(sessionId)),
        Effect.flatMap((paths) => readHistoryFile(sessionId, paths.sessionFile)),
      );
    const sessionFeed = (sessionId: SessionId): Effect.Effect<SessionFeed, EventError> =>
      allocation.withPermit(Effect.suspend(() => {
        const existing = sessions.get(sessionId);
        if (existing) return Effect.succeed(existing);
        return Effect.gen(function* () {
          const metadata = yield* store.readMetadata(sessionId).pipe(
            Effect.catch(() => sessionNotFound(sessionId)),
          );
          const history = yield* readHistory(sessionId);
          const events = yield* PubSub.sliding<SessionTailItem>(SESSION_DURABLE_TAIL_CAPACITY);
          const publishing = yield* Semaphore.make(1);
          const created: SessionFeed = {
            events,
            publishing,
            seen: new Set(history.map(conversationEventKey)),
            latestState: {
              conversationCursor: history.length,
              event: {
                runId: null,
                event: {
                  type: "session.state",
                  stage: lifecycleStage(metadata.state),
                  checkoutState: metadata.checkoutState,
                },
              },
            },
            cursor: history.length,
          };
          sessions.set(sessionId, created);
          return created;
        });
      }));

    const watch: SessionEvents["watch"] = (sessionId, afterCursor) =>
      Stream.unwrap(Effect.gen(function* () {
        let cursor = afterCursor;
        const session = yield* sessionFeed(sessionId);
        // Subscribe before replay so direct appends during the read remain queued for the live tail.
        const subscription = yield* PubSub.subscribe(session.events);
        const read = Effect.map(readHistory(sessionId), (events) => {
          const reset = cursor === 0 || cursor > events.length;
          const first = reset ? 0 : cursor;
          cursor = events.length;
          const values: Array<typeof WatchSessionEvent.Type> = [];
          if (reset) values.push({ runId: null, event: { type: "conversation.reset" } });
          for (let index = first; index < events.length; index++) {
            values.push({ runId: null, cursor: index + 1, event: events[index]! });
          }
          return values;
        });
        const replay = Stream.fromEffect(read).pipe(
          Stream.flatMap(Stream.fromIterable),
        );
        const currentState = Stream.fromEffect(Effect.sync(() => ({
          ...session.latestState.event,
          conversationCursor: cursor,
        })));
        const tail = Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect((item) =>
            Effect.gen(function* () {
              const values: Array<typeof WatchSessionEvent.Type> = [];
              const durable = "cursor" in item.event;
              if (item.conversationCursor > cursor) {
                if (durable && item.event.cursor === cursor + 1) {
                  cursor = item.event.cursor;
                  values.push(item.event);
                } else {
                  values.push(...yield* read);
                }
              }
              if (item.conversationCursor > cursor) {
                return yield* historyReadFailure(sessionId);
              }
              if (!durable) {
                values.push({
                  ...item.event,
                  conversationCursor: item.conversationCursor,
                });
              }
              return values;
            })
          ),
          Stream.flatMap(Stream.fromIterable),
        );
        return Stream.concat(Stream.concat(replay, currentState), tail);
      }));

    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          PubSub.shutdown(stateChanged),
          Effect.forEach(sessions.values(), (feed) => PubSub.shutdown(feed.events), {
            discard: true,
          }),
        ],
        { discard: true },
      )
    );

    return SessionEvents.of({
      watch,
      watchStateChanges: () => Stream.fromPubSub(stateChanged),
      publishConversation: (sessionId, event) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(SessionConversationEvent)(event);
          const feed = yield* sessionFeed(sessionId);
          yield* feed.publishing.withPermit(Effect.suspend(() => {
            const key = conversationEventKey(decoded);
            if (feed.seen.has(key)) return Effect.void;
            feed.seen.add(key);
            const cursor = ++feed.cursor;
            const appended: SessionTailItem = {
              conversationCursor: cursor,
              event: { runId: null, cursor, event: decoded },
            };
            return PubSub.publish(feed.events, appended).pipe(Effect.asVoid);
          }));
        }),
      publishLive: (sessionId, correlationId, event) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(SessionLiveEvent)(event);
          const feed = yield* sessionFeed(sessionId);
          // SAFETY: Pi run identifiers are generated UUIDs.
          const runId = correlationId as RunId;
          yield* feed.publishing.withPermit(
            Effect.gen(function* () {
              const item: SessionTailItem = {
                conversationCursor: feed.cursor,
                event: { runId, event: decoded },
              };
              if (decoded.type === "session.state") feed.latestState = item;
              // Reserve the large tail for durable recovery. Live deltas are expendable and stop
              // entering the unified lane as soon as a subscriber is 512 items behind.
              if ((yield* PubSub.size(feed.events)) >= SESSION_LIVE_TAIL_CAPACITY) return;
              yield* PubSub.publish(feed.events, item);
            }),
          );
          if (decoded.type === "session.state") yield* PubSub.publish(stateChanged, sessionId);
        }),
    });
  });
}

export const sessionEventsLayer: Layer.Layer<SessionEvents, never, RunnerSessionStore> = Layer
  .effect(
    SessionEvents,
    makeSessionEvents(),
  );

function sessionNotFound(sessionId: SessionId): Effect.Effect<never, SessionNotFound> {
  return new SessionNotFound({ sessionId, message: "Session not found." });
}

function readHistoryFile(sessionId: SessionId, path: string) {
  return Effect.tryPromise({
    try: () => readPiSessionEvents(path),
    catch: () => historyReadFailure(sessionId),
  }).pipe(
    Effect.flatMap((events) =>
      Effect.forEach(events, (event) => Schema.decodeUnknownEffect(SessionConversationEvent)(event))
    ),
    Effect.map((events) => Array.from(events)),
    Effect.mapError(() => historyReadFailure(sessionId)),
  );
}

function historyReadFailure(sessionId: SessionId) {
  return new HistoryReadError({
    sessionId,
    message: "Session history could not be read.",
  });
}

function conversationEventKey(event: typeof SessionConversationEvent.Type): string {
  switch (event.type) {
    case "user.message":
    case "assistant.completed":
      return `${event.type}:${event.messageId}`;
    case "tool.started":
    case "tool.completed":
      return `${event.type}:${event.toolCallId}`;
    case "context.compacted":
      return `${event.type}:${event.compactionId}`;
  }
}

function lifecycleStage(state: "created" | "provisioning" | "running" | "ready" | "error") {
  switch (state) {
    case "created":
      return "created" as const;
    case "provisioning":
      return "starting-vm" as const;
    case "running":
      return "running" as const;
    case "ready":
      return "ready" as const;
    case "error":
      return "failed" as const;
  }
}
