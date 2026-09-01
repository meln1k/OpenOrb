import { Context, Deferred, Effect, Layer, MutableRef, type Scope } from "effect";
import type {
  AbortSessionPayload,
  PromptSessionPayload,
  SessionId,
  StopSessionPayload,
  UpdateSessionGitFilePayload,
  WakeSessionPayload,
} from "@openorb/protocol/runner-api";

import type { AgentEnvironmentProvider } from "../../environment/agent-environment.ts";
import type { AgentHarness } from "../../harness/agent-harness.ts";
import type { Journal } from "../persistent-actor/journal.ts";
import { makePersistentActor, type PersistentActor } from "../persistent-actor/persistent-actor.ts";
import { actorError, SessionActorError } from "./actor-error.ts";
import type {
  AbortAcceptance,
  DeletionAcceptance,
  GitFileUpdateAcceptance,
  PromptAcceptance,
  SessionActorInput,
  SessionCommand,
  StopAcceptance,
  WakeAcceptance,
} from "./commands.ts";
import { makeSessionBehavior } from "./behavior.ts";
import type { SessionActorStatus } from "./runtime.ts";
import type { SessionEvents } from "../events.ts";
import type { SessionEvent } from "./events.ts";
import { sessionBehavior, type SessionState } from "./state.ts";
import type { RunnerSessionStore } from "../store.ts";

export type {
  AbortAcceptance,
  DeletionAcceptance,
  GitFileUpdateAcceptance,
  PromptAcceptance,
  SessionActorInput,
  StopAcceptance,
  WakeAcceptance,
} from "./commands.ts";
export { SessionActorError } from "./actor-error.ts";

export interface SessionActor {
  readonly sessionId: SessionId;
  readonly activeRunId: string | undefined;
  readonly active: boolean;
  readonly wake: (payload: WakeSessionPayload) => Effect.Effect<WakeAcceptance>;
  readonly prompt: (payload: PromptSessionPayload) => Effect.Effect<PromptAcceptance>;
  readonly abort: (payload: AbortSessionPayload) => Effect.Effect<AbortAcceptance>;
  readonly stop: (payload: StopSessionPayload) => Effect.Effect<StopAcceptance>;
  readonly delete: () => Effect.Effect<DeletionAcceptance>;
  readonly updateGitFile: (
    payload: UpdateSessionGitFilePayload,
  ) => Effect.Effect<GitFileUpdateAcceptance>;
  readonly awaitTermination: Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

export interface SessionActorFactory {
  readonly spawn: (
    input: SessionActorInput,
  ) => Effect.Effect<SessionActor, SessionActorError>;
}

export const SessionActorFactory: Context.Service<SessionActorFactory, SessionActorFactory> =
  Context.Service("@openorb/runner/SessionActorFactory");

type SessionActorDependencies =
  | AgentEnvironmentProvider
  | AgentHarness
  | Journal
  | RunnerSessionStore
  | Scope.Scope
  | SessionEvents;

type SessionBehaviorDependencies =
  | AgentEnvironmentProvider
  | AgentHarness
  | RunnerSessionStore
  | SessionEvents;

export function makeSessionActorFactory(): Effect.Effect<
  SessionActorFactory,
  never,
  SessionActorDependencies
> {
  return Effect.gen(function* () {
    const dependencies = yield* Effect.context<SessionActorDependencies>();
    return SessionActorFactory.of({
      spawn: Effect.fn("SessionActorFactory.spawn")((input: SessionActorInput) =>
        makeSessionActor(input).pipe(Effect.provide(dependencies))
      ),
    });
  });
}

export function sessionActorFactoryLayer(): Layer.Layer<
  SessionActorFactory,
  never,
  | AgentEnvironmentProvider
  | AgentHarness
  | Journal
  | RunnerSessionStore
  | SessionEvents
> {
  return Layer.effect(SessionActorFactory, makeSessionActorFactory());
}

const makeSessionActor = Effect.fn("makeSessionActor")(function* (
  input: SessionActorInput,
): Effect.fn.Return<SessionActor, SessionActorError, SessionActorDependencies> {
  const dependencies = yield* Effect.context<SessionBehaviorDependencies>();
  const sessionId = input.metadata.id;
  const status = MutableRef.make<SessionActorStatus>({ active: false });
  const persistentActor: PersistentActor<SessionCommand> = yield* makePersistentActor<
    SessionState | undefined,
    SessionCommand,
    SessionEvent
  >({
    ...sessionBehavior,
    persistenceId: sessionId,
    validateRecovery: (state, sequence) =>
      (input.mode === "create"
          ? state === undefined && sequence === 0
          : state !== undefined && state.data.id === sessionId &&
            state.data.runnerId === input.metadata.runnerId)
        ? Effect.void
        : Effect.fail(
          new SessionActorError(
            "The recovered session state does not match this actor.",
            undefined,
          ),
        ),
    setup: (context) =>
      makeSessionBehavior(input, context, status).pipe(Effect.provide(dependencies)),
  }).pipe(Effect.mapError(actorError));

  const initialized = yield* Deferred.make<void, SessionActorError>();
  if (
    !(yield* persistentActor.send({ kind: "internal", _tag: "Initialize", reply: initialized }))
  ) {
    return yield* new SessionActorError("The session actor is unavailable.", undefined);
  }
  yield* Effect.race(
    Deferred.await(initialized),
    persistentActor.awaitTermination.pipe(
      Effect.andThen(Effect.fail(
        new SessionActorError("The session actor stopped during initialization.", undefined),
      )),
    ),
  ).pipe(Effect.onError(() => persistentActor.shutdown));

  const request = <Acceptance>(
    makeCommand: (reply: Deferred.Deferred<Acceptance>) => SessionCommand,
    unavailable: Acceptance,
  ): Effect.Effect<Acceptance> =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<Acceptance>();
      if (!(yield* persistentActor.send(makeCommand(reply)))) return unavailable;
      return yield* Effect.race(
        Deferred.await(reply),
        persistentActor.awaitTermination.pipe(Effect.as(unavailable)),
      );
    });

  return {
    sessionId,
    get activeRunId() {
      return MutableRef.get(status).activeRunId;
    },
    get active() {
      return MutableRef.get(status).active;
    },
    wake: (payload) =>
      request<WakeAcceptance>(
        (reply) => ({ kind: "command", _tag: "Wake", payload, reply }),
        { ok: false, message: "The session actor is unavailable." },
      ),
    prompt: (payload) =>
      request<PromptAcceptance>(
        (reply) => ({ kind: "command", _tag: "Prompt", payload, reply }),
        { ok: false, message: "The session actor is unavailable." },
      ),
    abort: (payload) =>
      request<AbortAcceptance>(
        (reply) => ({ kind: "command", _tag: "Abort", payload, reply }),
        { ok: false, message: "The session actor is unavailable." },
      ),
    stop: (payload) =>
      request<StopAcceptance>(
        (reply) => ({ kind: "command", _tag: "Stop", payload, idle: false, reply }),
        { ok: false, message: "The session actor is unavailable." },
      ),
    delete: () =>
      request<DeletionAcceptance>(
        (reply) => ({ kind: "command", _tag: "Delete", reply }),
        { ok: false, message: "The session actor is unavailable." },
      ),
    updateGitFile: (payload) =>
      request<GitFileUpdateAcceptance>(
        (reply) => ({ kind: "command", _tag: "UpdateGitFile", payload, reply }),
        { ok: false, message: "The session actor is unavailable." },
      ),
    awaitTermination: persistentActor.awaitTermination,
    shutdown: persistentActor.shutdown,
  } satisfies SessionActor;
});
