import { diffRevisions, type JsonValue } from "@earendil-works/chord/delta";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import {
  HistoryReadError,
  RunnerWatchError,
  SessionEvent,
  type SessionId,
  SessionNotFound,
  type WatchSessionEvent,
} from "@openorb/protocol/runner-api";
import type {
  AgentHarnessError,
  AgentHarnessSession,
  ConversationView,
} from "../harness/agent-harness.ts";
import { readDurableView } from "../harness/durable/storage.ts";
import { SessionArtifactStore } from "./artifact-store.ts";
import { conversationMedia } from "./conversation-media.ts";
import { RunnerSessionStore } from "./store.ts";

type EventError = HistoryReadError | SessionNotFound;
type Item = typeof WatchSessionEvent.Type;
interface Subscriber {
  readonly events: Queue.Queue<Item, EventError | Cause.Done>;
  readonly changed: Queue.Queue<void, EventError | Cause.Done>;
}
const SESSION_TAIL_CAPACITY = 64;

interface ActiveConversation {
  readonly session: AgentHarnessSession;
  readonly scope: Scope.Closeable;
  readonly closed: Deferred.Deferred<void>;
  failed: boolean;
}

interface SessionFeed {
  readonly sessionId: SessionId;
  readonly directory: string;
  readonly mutex: Semaphore.Semaphore;
  readonly subscribers: Set<Subscriber>;
  readonly project: (view: ConversationView) => Effect.Effect<ConversationView>;
  active: ActiveConversation | undefined;
  view: ConversationView | undefined;
  latestState: Item;
  removed: boolean;
}

export type SessionStateChange =
  | { readonly type: "updated"; readonly sessionId: SessionId }
  | { readonly type: "removed"; readonly sessionId: SessionId };

export interface SessionEvents {
  readonly watch: (sessionId: SessionId) => Stream.Stream<Item, EventError>;
  readonly watchStateChanges: () => Stream.Stream<SessionStateChange, RunnerWatchError>;
  readonly openConversation: (
    sessionId: SessionId,
    acquire: Effect.Effect<AgentHarnessSession, AgentHarnessError, Scope.Scope>,
  ) => Effect.Effect<AgentHarnessSession, AgentHarnessError | EventError, Scope.Scope>;
  readonly publishLive: (
    sessionId: SessionId,
    event: unknown,
  ) => Effect.Effect<void, EventError | Schema.SchemaError>;
  readonly publishRemoved: <E = never>(
    sessionId: SessionId,
    removeStorage?: Effect.Effect<void, E>,
  ) => Effect.Effect<void, E>;
}

export const SessionEvents: Context.Service<SessionEvents, SessionEvents> = Context.Service(
  "@openorb/runner/SessionEvents",
);

/** One live owner or one unscheduled offline reader per session; never a second durable log. */
export function makeSessionEvents(options: {
  readonly readView?: (directory: string) => Promise<ConversationView>;
} = {}): Effect.Effect<
  SessionEvents,
  never,
  RunnerSessionStore | SessionArtifactStore | Scope.Scope
> {
  return Effect.gen(function* () {
    const store = yield* RunnerSessionStore;
    const artifacts = yield* SessionArtifactStore;
    const stateSubscribers = new Set<
      Queue.Queue<SessionStateChange, RunnerWatchError | Cause.Done>
    >();
    const publishStateChange = (change: SessionStateChange): void => {
      for (const queue of stateSubscribers) {
        if (Queue.offerUnsafe(queue, change)) continue;
        // A registry must reconnect for a fresh manifest instead of silently losing removals.
        Queue.failCauseUnsafe(
          queue,
          Cause.fail(
            new RunnerWatchError({
              message: "Runner state subscriber fell behind; reconnect for a fresh snapshot.",
            }),
          ),
        );
        stateSubscribers.delete(queue);
      }
    };
    const allocation = yield* Semaphore.make(1);
    const sessions = new Map<SessionId, SessionFeed>();
    let stopped = false;
    const readView = options.readView ?? readDurableView;
    const sessionFeed = (sessionId: SessionId): Effect.Effect<SessionFeed, EventError> =>
      Effect.suspend(() => {
        if (stopped) return sessionNotFound(sessionId);
        const existing = sessions.get(sessionId);
        if (existing) return Effect.succeed(existing);
        return allocation.withPermit(Effect.gen(function* () {
          if (stopped) return yield* sessionNotFound(sessionId);
          const existing = sessions.get(sessionId);
          if (existing) return existing;
          const metadata = yield* store.readMetadata(sessionId).pipe(
            Effect.catch(() => sessionNotFound(sessionId)),
          );
          const directory = yield* store.getSessionHarnessDirectory(sessionId).pipe(
            Effect.catch(() => sessionNotFound(sessionId)),
          );
          const feed: SessionFeed = {
            sessionId,
            directory,
            mutex: yield* Semaphore.make(1),
            subscribers: new Set(),
            project: conversationMedia(sessionId, artifacts),
            active: undefined,
            view: undefined,
            removed: false,
            latestState: {
              event: {
                type: "session.state",
                stage: sessionStage(metadata.state),
                agentState: metadata.agentState,
                environmentState: metadata.environmentState,
                checkoutState: metadata.checkoutState,
                issues: metadata.issues,
              },
            },
          };
          sessions.set(sessionId, feed);
          return feed;
        }));
      });

    const readProjectedView = (feed: SessionFeed) =>
      Effect.tryPromise({
        try: () => readView(feed.directory),
        catch: () => historyReadFailure(feed.sessionId),
      }).pipe(Effect.flatMap(feed.project));

    const releaseOwner = (feed: SessionFeed, owner: ActiveConversation) =>
      Effect.gen(function* () {
        if (feed.active !== owner) return;
        // Keep ownership until every harness finalizer (including its reads/watch) has completed.
        yield* Scope.close(owner.scope, Exit.void);
        if (!feed.removed && feed.subscribers.size > 0) {
          // Pausing may itself commit changes after the live watch closes. Existing watchers
          // receive that final durable state without scheduling work or waking the guest.
          const finalView = yield* readProjectedView(feed).pipe(Effect.result);
          if (finalView._tag === "Success") {
            publishView(feed, finalView.success);
          } else {
            failSubscribers(feed);
          }
        }
        feed.active = undefined;
        yield* Deferred.succeed(owner.closed, undefined);
      });
    const closeOwner = (feed: SessionFeed, owner: ActiveConversation) =>
      feed.mutex.withPermit(releaseOwner(feed, owner));

    const retireFeed = (
      feed: SessionFeed,
      end: <A>(queue: Queue.Queue<A, EventError | Cause.Done>) => void,
    ) =>
      Effect.gen(function* () {
        feed.removed = true;
        if (feed.active) yield* releaseOwner(feed, feed.active);
        for (const subscriber of feed.subscribers) {
          end(subscriber.events);
          end(subscriber.changed);
        }
        feed.subscribers.clear();
        feed.view = undefined;
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        stopped = true;
        yield* allocation.withPermit(Effect.gen(function* () {
          for (const feed of sessions.values()) {
            yield* feed.mutex.withPermit(retireFeed(feed, Queue.shutdownUnsafe));
          }
          sessions.clear();
        }));
        for (const queue of stateSubscribers) Queue.shutdownUnsafe(queue);
        stateSubscribers.clear();
      })
    );

    return SessionEvents.of({
      watch: (sessionId) =>
        Stream.unwrap(Effect.gen(function* () {
          const feed = yield* sessionFeed(sessionId);
          const subscriber: Subscriber = {
            events: yield* Queue.bounded<Item, EventError | Cause.Done>(SESSION_TAIL_CAPACITY),
            changed: yield* Queue.sliding<void, EventError | Cause.Done>(1),
          };
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              feed.subscribers.delete(subscriber);
              Queue.shutdownUnsafe(subscriber.events);
              Queue.shutdownUnsafe(subscriber.changed);
            })
          );
          return yield* feed.mutex.withPermit(Effect.gen(function* () {
            if (feed.removed) return yield* sessionNotFound(sessionId);
            if (feed.active?.failed) return yield* historyReadFailure(sessionId);
            if (!feed.active) {
              // The Promise is deliberately uninterruptible: cancellation must wait for SQLite
              // and the unscheduled harness to close before handing ownership to a live opener.
              feed.view = yield* readProjectedView(feed).pipe(Effect.uninterruptible);
            }
            // Capture and subscribe atomically; later updates cannot slip past the baseline.
            let delivered = feed.view!;
            feed.subscribers.add(subscriber);
            return Stream.concat(
              Stream.make<[Item, Item]>(
                { event: { type: "conversation.snapshot", view: delivered } },
                feed.latestState,
              ),
              Stream.merge(
                Stream.fromQueue(subscriber.events),
                Stream.fromQueue(subscriber.changed),
              ).pipe(
                Stream.filterMap((item): Result.Result<Item, void> => {
                  if (item) return Result.succeed(item);
                  // Read the latest view after the merge: prefetched notifications retain no
                  // stale views or deltas. Each viewer diffs only what it actually consumes.
                  const latest = feed.view;
                  if (!latest) return Result.fail(undefined);
                  // SAFETY: diffRevisions only reads; Durable marks entries readonly.
                  const ops = diffRevisions(
                    // deno-lint-ignore openorb/no-chained-type-assertions -- Adapt readonly Durable JSON without mutation.
                    delivered as unknown as JsonValue,
                    // deno-lint-ignore openorb/no-chained-type-assertions -- Adapt readonly Durable JSON without mutation.
                    latest as unknown as JsonValue,
                  );
                  delivered = latest;
                  return ops.length > 0
                    ? Result.succeed({ event: { type: "conversation.ops", ops } })
                    : Result.fail(undefined);
                }),
              ),
            );
          }));
        })),
      watchStateChanges: () =>
        Stream.unwrap(Effect.gen(function* () {
          const queue = yield* Queue.bounded<SessionStateChange, RunnerWatchError | Cause.Done>(64);
          if (stopped) {
            yield* Queue.end(queue);
            return Stream.fromQueue(queue);
          }
          stateSubscribers.add(queue);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stateSubscribers.delete(queue);
              Queue.shutdownUnsafe(queue);
            })
          );
          return Stream.fromQueue(queue);
        })),
      openConversation: (sessionId, acquire) =>
        Effect.gen(function* () {
          const feed = yield* sessionFeed(sessionId);
          const open: Effect.Effect<ActiveConversation, AgentHarnessError | EventError> = Effect
            .suspend(() =>
              feed.mutex.withPermit(Effect.gen(function* () {
                if (feed.removed) return yield* sessionNotFound(sessionId);
                if (feed.active) return { waiting: feed.active.closed } as const;
                const scope = yield* Scope.make();
                const owner = yield* Effect.gen(function* () {
                  const session = yield* acquire.pipe(Effect.provideService(Scope.Scope, scope));
                  const owner: ActiveConversation = {
                    session,
                    scope,
                    closed: yield* Deferred.make<void>(),
                    failed: false,
                  };
                  const initial = yield* feed.project(session.view);
                  feed.active = owner;
                  publishView(feed, initial);
                  yield* session.views.pipe(
                    Stream.runForEach((view) =>
                      Effect.gen(function* () {
                        if (feed.active !== owner || feed.removed) return;
                        publishView(feed, yield* feed.project(view));
                      })
                    ),
                    Effect.catch(() =>
                      Effect.sync(() => {
                        owner.failed = true;
                        failSubscribers(feed);
                      })
                    ),
                    Effect.forkIn(scope),
                  );
                  return owner;
                }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
                return { owner } as const;
              })).pipe(Effect.flatMap((result) =>
                "waiting" in result
                  ? Deferred.await(result.waiting).pipe(Effect.interruptible, Effect.andThen(open))
                  : Effect.succeed(result.owner)
              ))
            );
          const owner = yield* Effect.acquireRelease(open, (owner) => closeOwner(feed, owner));
          return owner.session;
        }),
      publishLive: (sessionId, event) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(SessionEvent)(event);
          const feed = yield* sessionFeed(sessionId);
          if (feed.removed) return yield* sessionNotFound(sessionId);
          // Structural conversation frames have one authority: the registered harness stream.
          if (decoded.type === "conversation.snapshot" || decoded.type === "conversation.ops") {
            return;
          }
          const item: Item = { event: decoded };
          if (decoded.type === "session.state") feed.latestState = item;
          broadcast(feed, item);
          if (decoded.type === "session.state") {
            publishStateChange({ type: "updated", sessionId });
          }
        }),
      publishRemoved: (sessionId, removeStorage = Effect.void) =>
        allocation.withPermit(Effect.gen(function* () {
          const feed = sessions.get(sessionId);
          if (feed) {
            yield* feed.mutex.withPermit(Effect.gen(function* () {
              yield* retireFeed(feed, Queue.endUnsafe);
              // Readers and openers cannot pass the deletion boundary. On failure the feed
              // stays tombstoned, but a later cleanup attempt may retry the storage operation.
              yield* removeStorage;
              sessions.delete(sessionId);
            }));
          } else {
            yield* removeStorage;
          }
          publishStateChange({ type: "removed", sessionId });
        })),
    });
  });
}

function publishView(feed: SessionFeed, view: ConversationView): void {
  feed.view = view;
  for (const subscriber of feed.subscribers) {
    Queue.offerUnsafe(subscriber.changed, undefined);
  }
}

function failSubscribers(feed: SessionFeed): void {
  for (const subscriber of feed.subscribers) {
    const cause = Cause.fail(historyReadFailure(feed.sessionId));
    Queue.failCauseUnsafe(subscriber.events, cause);
    Queue.failCauseUnsafe(subscriber.changed, cause);
  }
  feed.subscribers.clear();
}

/** Infrastructure events cannot be coalesced; overflow requires a fresh baseline. */
function broadcast(feed: SessionFeed, item: Item): void {
  for (const subscriber of feed.subscribers) {
    if (Queue.offerUnsafe(subscriber.events, item)) continue;
    const cause = Cause.fail(
      new HistoryReadError({
        sessionId: feed.sessionId,
        message: "Session subscriber fell behind; reconnect for a fresh snapshot.",
      }),
    );
    Queue.failCauseUnsafe(subscriber.events, cause);
    Queue.failCauseUnsafe(subscriber.changed, cause);
    feed.subscribers.delete(subscriber);
  }
}

export const sessionEventsLayer: Layer.Layer<
  SessionEvents,
  never,
  RunnerSessionStore | SessionArtifactStore
> = Layer
  .effect(
    SessionEvents,
    makeSessionEvents(),
  );

function sessionNotFound(sessionId: SessionId): Effect.Effect<never, SessionNotFound> {
  return new SessionNotFound({ sessionId, message: "Session not found." });
}

function historyReadFailure(sessionId: SessionId) {
  return new HistoryReadError({ sessionId, message: "Session history could not be read." });
}

function sessionStage(
  state: "created" | "provisioning" | "running" | "ready" | "stopped" | "error",
) {
  switch (state) {
    case "provisioning":
      return "starting-vm" as const;
    case "error":
      return "failed" as const;
    default:
      return state;
  }
}
