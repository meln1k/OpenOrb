import { Context, Effect, Layer, PubSub, Schema, type Scope, Semaphore, Stream } from "effect";
import {
  DurableSessionEvent,
  EphemeralSessionEvent,
  HistoryReadError,
  type RunId,
  type SessionId,
  SessionNotFound,
  type WatchSessionEvent,
} from "@openorb/protocol/runner-api";
import { readPiSessionEvents } from "../harness/pi/history.ts";
import { RunnerSessionStore } from "./store.ts";

type EventError = HistoryReadError | SessionNotFound;
type ReadHistory = (
  sessionId: SessionId,
  sessionFile: string,
) => Effect.Effect<Array<typeof DurableSessionEvent.Type>, EventError>;

const SESSION_LIVE_TAIL_CAPACITY = 512;

interface SessionFeed {
  readonly sessionFile: string;
  readonly conversationChanged: PubSub.PubSub<void>;
  readonly liveEvents: PubSub.PubSub<typeof WatchSessionEvent.Type>;
  activeHistory?: {
    events: Array<typeof DurableSessionEvent.Type>;
    valid: boolean;
  };
  latestState: typeof WatchSessionEvent.Type;
}

interface ActiveConversation {
  readonly update: (
    conversation: readonly typeof DurableSessionEvent.Type[] | undefined,
  ) => void;
  readonly dispose: () => void;
}

export interface SessionEvents {
  readonly watch: (
    sessionId: SessionId,
    afterCursor: number,
  ) => Stream.Stream<typeof WatchSessionEvent.Type, EventError>;
  readonly watchStateChanges: () => Stream.Stream<SessionId>;
  readonly activateConversation: (
    sessionId: SessionId,
    initial: readonly typeof DurableSessionEvent.Type[],
  ) => Effect.Effect<ActiveConversation, EventError, Scope.Scope>;
  readonly publishLive: (
    sessionId: SessionId,
    correlationId: string,
    event: unknown,
  ) => Effect.Effect<void, EventError | Schema.SchemaError>;
}

export const SessionEvents: Context.Service<SessionEvents, SessionEvents> = Context.Service(
  "@openorb/runner/SessionEvents",
);

/** Process-wide notification and live-event owner. Pi JSONL is the durable event source. */
export function makeSessionEvents(options: {
  readonly readHistory?: ReadHistory;
} = {}): Effect.Effect<
  SessionEvents,
  never,
  RunnerSessionStore | Scope.Scope
> {
  return Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const stateChanged = yield* PubSub.sliding<SessionId>(64);
    const allocation = yield* Semaphore.make(1);
    const sessions = new Map<SessionId, SessionFeed>();
    const readHistory = options.readHistory ?? readHistoryFile;
    const sessionFeed = (sessionId: SessionId): Effect.Effect<SessionFeed, EventError> =>
      allocation.withPermit(Effect.suspend(() => {
        const existing = sessions.get(sessionId);
        if (existing) return Effect.succeed(existing);
        return Effect.gen(function* () {
          const metadata = yield* store.readMetadata(sessionId).pipe(
            Effect.catch(() => sessionNotFound(sessionId)),
          );
          const paths = yield* store.getSessionPiPaths(sessionId).pipe(
            Effect.catch(() => sessionNotFound(sessionId)),
          );
          const created: SessionFeed = {
            sessionFile: paths.sessionFile,
            conversationChanged: yield* PubSub.sliding<void>(1),
            liveEvents: yield* PubSub.sliding<typeof WatchSessionEvent.Type>(
              SESSION_LIVE_TAIL_CAPACITY,
            ),
            latestState: {
              runId: null,
              event: {
                type: "session.state",
                stage: sessionStage(metadata.state),
                checkoutState: metadata.checkoutState,
              },
            },
          };
          sessions.set(sessionId, created);
          return created;
        });
      }));

    const watch: SessionEvents["watch"] = (sessionId, afterCursor) =>
      Stream.unwrap(Effect.gen(function* () {
        let cursor = afterCursor;
        const session = yield* sessionFeed(sessionId);
        // Both subscriptions exist before the initial read. An append or live state change during
        // replay therefore remains observable after the replay-to-tail handoff.
        const conversationChanges = yield* PubSub.subscribe(session.conversationChanged);
        const liveEvents = yield* PubSub.subscribe(session.liveEvents);
        const loadHistory = (): ReturnType<ReadHistory> => {
          const active = session.activeHistory;
          return active?.valid
            ? Effect.succeed([...active.events])
            : readHistory(sessionId, session.sessionFile);
        };
        const missingHistory = Effect.map(
          Effect.suspend(loadHistory),
          (events): Array<typeof WatchSessionEvent.Type> => {
            const reset = cursor === 0 || cursor > events.length;
            const first = reset ? 0 : cursor;
            cursor = events.length;
            const values: Array<typeof WatchSessionEvent.Type> = [];
            if (reset) values.push({ runId: null, event: { type: "conversation.reset" } });
            for (let index = first; index < events.length; index++) {
              values.push({ runId: null, cursor: index + 1, event: events[index]! });
            }
            return values;
          },
        );
        const replay = Stream.fromEffect(missingHistory).pipe(
          Stream.flatMap(Stream.fromIterable),
        );
        const currentState = Stream.fromEffect(Effect.sync(() => session.latestState));
        const durableTail = Stream.fromSubscription(conversationChanges).pipe(
          Stream.mapEffect(() => missingHistory),
          Stream.flatMap(Stream.fromIterable),
        );
        const liveTail = Stream.fromSubscription(liveEvents);
        return replay.pipe(
          Stream.concat(currentState),
          Stream.concat(Stream.merge(durableTail, liveTail)),
        );
      }));

    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          PubSub.shutdown(stateChanged),
          Effect.forEach(
            sessions.values(),
            (feed) =>
              Effect.all(
                [PubSub.shutdown(feed.conversationChanged), PubSub.shutdown(feed.liveEvents)],
                { discard: true },
              ),
            { discard: true },
          ),
        ],
        { discard: true },
      )
    );

    return SessionEvents.of({
      watch,
      watchStateChanges: () => Stream.fromPubSub(stateChanged),
      activateConversation: (sessionId, initial) =>
        Effect.gen(function* () {
          const feed = yield* sessionFeed(sessionId);
          const active = {
            events: [...initial],
            valid: true,
          };
          feed.activeHistory = active;
          const update = (
            conversation: readonly typeof DurableSessionEvent.Type[] | undefined,
          ): void => {
            if (feed.activeHistory !== active) return;
            if (conversation === undefined) {
              // The JSONL write already succeeded. Fall back to the durable file until recovery.
              active.valid = false;
            } else {
              active.events = [...conversation];
              active.valid = true;
            }
            PubSub.publishUnsafe(feed.conversationChanged, undefined);
          };
          const dispose = (): void => {
            if (feed.activeHistory !== active) return;
            delete feed.activeHistory;
            PubSub.publishUnsafe(feed.conversationChanged, undefined);
          };
          yield* Effect.addFinalizer(() => Effect.sync(dispose));
          return { update, dispose };
        }),
      publishLive: (sessionId, correlationId, event) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(EphemeralSessionEvent)(event);
          const feed = yield* sessionFeed(sessionId);
          // SAFETY: Pi run identifiers are generated UUIDs.
          const runId = correlationId as RunId;
          const item: typeof WatchSessionEvent.Type = { runId, event: decoded };
          if (decoded.type === "session.state") feed.latestState = item;
          yield* PubSub.publish(feed.liveEvents, item);
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

function readHistoryFile(sessionId: SessionId, path: string): ReturnType<ReadHistory> {
  return Effect.tryPromise({
    try: () => readPiSessionEvents(path),
    catch: () => historyReadFailure(sessionId),
  }).pipe(
    Effect.flatMap((events) =>
      Effect.forEach(events, (event) => Schema.decodeUnknownEffect(DurableSessionEvent)(event))
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

function sessionStage(
  state: "created" | "provisioning" | "running" | "ready" | "stopped" | "error",
) {
  switch (state) {
    case "created":
      return "created" as const;
    case "provisioning":
      return "starting-vm" as const;
    case "running":
      return "running" as const;
    case "ready":
      return "ready" as const;
    case "stopped":
      return "stopped" as const;
    case "error":
      return "failed" as const;
  }
}
