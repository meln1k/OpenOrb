import { Context, Effect, type Exit, Layer } from "effect";
import type {
  AbortSessionPayload,
  AgentState,
  EnvironmentState,
  PromptSessionPayload,
  SessionId,
  SetSessionThinkingLevelPayload,
  StopSessionPayload,
  UpdateSessionGitFilePayload,
  WakeSessionPayload,
} from "@openorb/protocol/runner-api";
import type {
  AbortAcceptance,
  DeletionAcceptance,
  GitFileUpdateAcceptance,
  PromptAcceptance,
  SessionActorInput,
  StopAcceptance,
  ThinkingLevelAcceptance,
  WakeAcceptance,
} from "./commands.ts";
import type { SessionActorError } from "./actor-error.ts";
import { makeSessionActor, type SessionActorDependencies } from "./session.ts";

export type {
  AbortAcceptance,
  DeletionAcceptance,
  GitFileUpdateAcceptance,
  PromptAcceptance,
  SessionActorInput,
  StopAcceptance,
  ThinkingLevelAcceptance,
  WakeAcceptance,
} from "./commands.ts";
export { SessionActorError } from "./actor-error.ts";

export interface SessionActor {
  readonly sessionId: SessionId;
  readonly active: boolean;
  readonly agentState: AgentState;
  readonly environmentState: EnvironmentState;
  readonly wake: (payload: WakeSessionPayload) => Effect.Effect<WakeAcceptance>;
  readonly prompt: (payload: PromptSessionPayload) => Effect.Effect<PromptAcceptance>;
  readonly setThinkingLevel: (
    payload: SetSessionThinkingLevelPayload,
  ) => Effect.Effect<ThinkingLevelAcceptance>;
  readonly abort: (payload: AbortSessionPayload) => Effect.Effect<AbortAcceptance>;
  readonly stop: (payload: StopSessionPayload) => Effect.Effect<StopAcceptance>;
  readonly delete: () => Effect.Effect<DeletionAcceptance>;
  readonly updateGitFile: (
    payload: UpdateSessionGitFilePayload,
  ) => Effect.Effect<GitFileUpdateAcceptance>;
  readonly awaitTermination: Effect.Effect<Exit.Exit<void>>;
  readonly shutdown: Effect.Effect<void>;
}

export interface SessionActorFactory {
  readonly spawn: (input: SessionActorInput) => Effect.Effect<SessionActor, SessionActorError>;
}
export const SessionActorFactory: Context.Service<SessionActorFactory, SessionActorFactory> =
  Context.Service("@openorb/runner/SessionActorFactory");

export function makeSessionActorFactory(): Effect.Effect<
  SessionActorFactory,
  never,
  SessionActorDependencies
> {
  return Effect.gen(function* () {
    const dependencies = yield* Effect.context<SessionActorDependencies>();
    return SessionActorFactory.of({
      spawn: (input) => makeSessionActor(input).pipe(Effect.provide(dependencies)),
    });
  });
}

export function sessionActorFactoryLayer() {
  return Layer.effect(SessionActorFactory, makeSessionActorFactory());
}
