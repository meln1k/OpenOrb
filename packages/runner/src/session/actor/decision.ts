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
          : logCommittedLifecycle(event, state).pipe(Effect.andThen(afterCommit(state))),
    );

  return {
    none,
    persist,
    reply: (reply, value) => none(() => Deferred.succeed(reply, value).pipe(Effect.asVoid)),
    fail: (reply, error) => none(() => Deferred.fail(reply, error).pipe(Effect.asVoid)),
  };
}

/** Only durable lifecycle facts; never serialize journal events or their diagnostics. */
function logCommittedLifecycle(event: SessionEvent, state: SessionState): Effect.Effect<void> {
  let name: string;
  let failed = false;
  switch (event.type) {
    case "session.provisioning-started":
    case "provisioning.retried":
      name = "provision.accepted";
      break;
    case "provisioning.failed":
    case "provisioning.interrupted":
      name = "provision.failed";
      failed = true;
      break;
    case "wake.started":
    case "restoration.started":
      name = "wake.started";
      break;
    case "wake.completed":
    case "restoration.completed":
      name = "wake.ready";
      break;
    case "wake.failed":
    case "wake.interrupted":
    case "restoration.failed":
    case "restoration.interrupted":
      name = "wake.failed";
      failed = true;
      break;
    case "restore.failed":
      name = "actor.restoration-failed";
      failed = true;
      break;
    default:
      return Effect.void;
  }
  return (failed ? Effect.logError(name) : Effect.logInfo(name)).pipe(
    Effect.annotateLogs({
      component: "openorb-runner",
      sessionId: state.data.id,
      runnerId: state.data.runnerId,
      transition: event.type,
    }),
  );
}
