import {
  RunId,
  type RunnerCheckoutState,
  type RunnerId,
  type RunnerSessionCreatedAt,
  type SessionId,
} from "@openorb/protocol/runner-api";
import { Deferred, Effect, Schema } from "effect";

import { Journal } from "@/src/session/persistent-actor/journal.ts";
import {
  makePersistentActor,
  type PersistentActor,
  type PersistentActorError,
  persistEvent,
} from "@/src/session/persistent-actor/persistent-actor.ts";
import type { RunnerSessionDefinition } from "@/src/session/definition.ts";
import type { SessionEvent } from "@/src/session/actor/events.ts";
import type { RunnerSessionStore, RunnerSessionStoreError } from "@/src/session/store.ts";
import { sessionBehavior, type SessionState } from "@/src/session/actor/state.ts";

const FIXTURE_RUN_ID = Schema.decodeUnknownSync(RunId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c99",
);

interface PersistCommand {
  readonly event: SessionEvent;
  readonly reply: Deferred.Deferred<SessionState | undefined>;
}

export interface SessionFixture {
  readonly create: (
    sessionId: SessionId,
    definition: RunnerSessionDefinition,
    createdAt: typeof RunnerSessionCreatedAt.Type,
  ) => Effect.Effect<
    SessionState,
    PersistentActorError | RunnerSessionStoreError
  >;
  readonly append: (
    sessionId: SessionId,
    event: SessionEvent,
  ) => Effect.Effect<SessionState, PersistentActorError>;
  readonly appendAll: (
    sessionId: SessionId,
    events: readonly SessionEvent[],
  ) => Effect.Effect<SessionState, PersistentActorError>;
  readonly startInitialRun: (
    sessionId: SessionId,
    checkoutState?: RunnerCheckoutState,
    baseCommit?: string,
  ) => Effect.Effect<SessionState, PersistentActorError>;
  readonly completeInitialRun: (
    sessionId: SessionId,
    checkoutState?: RunnerCheckoutState,
    baseCommit?: string,
  ) => Effect.Effect<SessionState, PersistentActorError>;
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
    store.ensureSessionStorage(sessionId).pipe(
      Effect.andThen(Effect.scoped(
        makePersistentActor<SessionState | undefined, PersistCommand, SessionEvent>({
          ...sessionBehavior,
          persistenceId: sessionId,
          validateRecovery: (state, sequence) =>
            state === undefined && sequence === 0
              ? Effect.void
              : Effect.fail("The session fixture requires an empty journal."),
          setup: () => Effect.succeed(persistCommand),
        }).pipe(
          Effect.provideService(Journal, journal),
          Effect.flatMap((actor) =>
            request(actor, {
              type: "session.provisioning-started",
              id: sessionId,
              definition,
              runnerId,
              createdAt,
            }).pipe(Effect.flatMap(requireState))
          ),
        ),
      )),
    );

  const appendAll: SessionFixture["appendAll"] = (sessionId, events) =>
    Effect.scoped(
      makePersistentActor<SessionState | undefined, PersistCommand, SessionEvent>({
        ...sessionBehavior,
        persistenceId: sessionId,
        validateRecovery: (state) =>
          state === undefined
            ? Effect.fail("The session fixture requires existing state.")
            : Effect.void,
        setup: () => Effect.succeed(persistCommand),
      }).pipe(
        Effect.provideService(Journal, journal),
        Effect.flatMap((actor) =>
          Effect.gen(function* () {
            let state: SessionState | undefined;
            for (const event of events) state = yield* request(actor, event);
            return yield* requireState(state);
          })
        ),
      ),
    );

  return {
    create,
    append: (sessionId, event) => appendAll(sessionId, [event]),
    appendAll,
    startInitialRun: (sessionId, checkoutState = "available", baseCommit) =>
      appendAll(sessionId, initialRunEvents(checkoutState, baseCommit)),
    completeInitialRun: (sessionId, checkoutState = "available", baseCommit) =>
      appendAll(sessionId, [
        ...initialRunEvents(checkoutState, baseCommit),
        { type: "run.completed", runId: FIXTURE_RUN_ID },
      ]),
  };

  function persistCommand(
    _state: SessionState | undefined,
    command: PersistCommand,
  ) {
    return Effect.succeed(persistEvent<SessionState | undefined, SessionEvent>(
      command.event,
      (state) => Deferred.succeed(command.reply, state).pipe(Effect.asVoid),
    ));
  }

  function request(
    actor: PersistentActor<PersistCommand>,
    event: SessionEvent,
  ) {
    return Effect.gen(function* () {
      const reply = yield* Deferred.make<SessionState | undefined>();
      yield* actor.send({ event, reply });
      return yield* Deferred.await(reply);
    });
  }
}

function initialRunEvents(
  checkoutState: RunnerCheckoutState,
  baseCommit: string | undefined,
): readonly SessionEvent[] {
  return [
    {
      type: "checkout.updated",
      checkoutState,
      ...(baseCommit === undefined ? {} : { baseCommit }),
    },
    { type: "run.requested", runId: FIXTURE_RUN_ID, purpose: "initial", issues: [] },
    {
      type: "run.started",
      runId: FIXTURE_RUN_ID,
      acceptedAt: "2026-08-17T12:05:00Z",
    },
  ];
}
