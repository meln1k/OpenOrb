import type {
  RunnerCheckoutState,
  RunnerId,
  RunnerSessionCreatedAt,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Effect } from "effect";

import { Journal, type JournalError } from "@/src/session/persistent-actor/journal.ts";
import type { RunnerSessionDefinition } from "@/src/session/definition.ts";
import type { SessionEvent } from "@/src/session/actor/events.ts";
import type { RunnerSessionStore, RunnerSessionStoreError } from "@/src/session/store.ts";
import {
  applySessionEvent,
  replaySessionState,
  sessionEventCodec,
  type SessionState,
} from "@/src/session/actor/state.ts";

export interface SessionFixture {
  readonly create: (
    sessionId: SessionId,
    definition: RunnerSessionDefinition,
    createdAt: typeof RunnerSessionCreatedAt.Type,
  ) => Effect.Effect<
    SessionState,
    JournalError | RunnerSessionStoreError
  >;
  readonly append: (
    sessionId: SessionId,
    event: SessionEvent,
  ) => Effect.Effect<SessionState, JournalError>;
  readonly appendAll: (
    sessionId: SessionId,
    events: readonly SessionEvent[],
  ) => Effect.Effect<SessionState, JournalError>;
  readonly startInitialRun: (
    sessionId: SessionId,
    checkoutState?: RunnerCheckoutState,
    baseCommit?: string,
  ) => Effect.Effect<SessionState, JournalError>;
  readonly completeInitialRun: (
    sessionId: SessionId,
    checkoutState?: RunnerCheckoutState,
    baseCommit?: string,
  ) => Effect.Effect<SessionState, JournalError>;
}

export function makeSessionFixture(
  store: RunnerSessionStore,
  journal: Journal,
  runnerId: typeof RunnerId.Type,
): SessionFixture {
  const requireState = (
    state: SessionState | undefined,
  ): Effect.Effect<SessionState> =>
    state === undefined
      ? Effect.die("The session fixture did not recover state.")
      : Effect.succeed(state);

  const create: SessionFixture["create"] = (sessionId, definition, createdAt) =>
    Effect.gen(
      function* (): Effect.fn.Return<SessionState, JournalError | RunnerSessionStoreError> {
        yield* store.ensureSessionStorage(sessionId);
        const event: SessionEvent = {
          type: "session.provisioning-started",
          id: sessionId,
          definition,
          runnerId,
          createdAt,
        };
        yield* journal.append(sessionId, 0, event, sessionEventCodec);
        return yield* requireState(applySessionEvent(undefined, event));
      },
    );

  const appendAll: SessionFixture["appendAll"] = (sessionId, events) =>
    Effect.gen(function* (): Effect.fn.Return<SessionState, JournalError> {
      const recovered = yield* replaySessionState(sessionId).pipe(
        Effect.provideService(Journal, journal),
      );
      let state = yield* requireState(recovered.state);
      let sequence = recovered.sequence;
      for (const event of events) {
        const entry = yield* journal.append(sessionId, sequence, event, sessionEventCodec);
        sequence = entry.sequence;
        state = yield* requireState(applySessionEvent(state, event));
      }
      return state;
    });

  return {
    create,
    append: (sessionId, event) => appendAll(sessionId, [event]),
    appendAll,
    startInitialRun: (sessionId, checkoutState = "available", baseCommit) =>
      appendAll(sessionId, initialRunEvents(checkoutState, baseCommit)),
    completeInitialRun: (sessionId, checkoutState = "available", baseCommit) =>
      appendAll(sessionId, initialRunEvents(checkoutState, baseCommit)),
  };
}

function initialRunEvents(
  checkoutState: RunnerCheckoutState,
  baseCommit: string | undefined,
): readonly SessionEvent[] {
  return [
    { type: "disk.initialized" },
    {
      type: "checkout.updated",
      checkoutState,
      ...(baseCommit === undefined ? {} : { baseCommit }),
    },
    { type: "environment.changed", state: "running" },
    {
      type: "message.accepted",
      acceptedAt: "2026-08-17T12:05:00Z",
    },
  ];
}
