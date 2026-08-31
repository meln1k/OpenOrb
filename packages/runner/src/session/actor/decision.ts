import { Deferred, Effect, type Scope } from "effect";

import {
  type CommandDecision,
  noEvent,
  persistEvent,
} from "../persistent-actor/persistent-actor.ts";
import type { SessionEvent } from "./events.ts";
import type { SessionState } from "./state.ts";

export type PersistentSessionState = SessionState | undefined;
export type SessionDecision = CommandDecision<PersistentSessionState, SessionEvent>;

export interface SessionDecisions {
  readonly none: (
    afterCommit?: (
      state: PersistentSessionState,
    ) => Effect.Effect<void, never, Scope.Scope>,
  ) => SessionDecision;
  readonly persist: (
    event: SessionEvent,
    afterCommit?: (state: SessionState) => Effect.Effect<void, never, Scope.Scope>,
  ) => SessionDecision;
  readonly reply: <A, E>(reply: Deferred.Deferred<A, E>, value: A) => SessionDecision;
  readonly fail: <A, E>(reply: Deferred.Deferred<A, E>, error: E) => SessionDecision;
}

export function makeSessionDecisions(): SessionDecisions {
  const none: SessionDecisions["none"] = (afterCommit = () => Effect.void) =>
    noEvent<PersistentSessionState, SessionEvent>(afterCommit);
  const persist: SessionDecisions["persist"] = (event, afterCommit = () => Effect.void) =>
    persistEvent<PersistentSessionState, SessionEvent>(
      event,
      (state) =>
        state === undefined
          ? Effect.die(new Error("A session event produced no session state."))
          : afterCommit(state),
    );

  return {
    none,
    persist,
    reply: (reply, value) => none(() => Deferred.succeed(reply, value).pipe(Effect.asVoid)),
    fail: (reply, error) => none(() => Deferred.fail(reply, error).pipe(Effect.asVoid)),
  };
}
