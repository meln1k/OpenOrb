import { Context, Data, type Effect, type Scope, type Stream } from "effect";
import type {
  SessionConversationEvent,
  SessionLiveEvent,
  SessionModelRuntime,
} from "@openorb/protocol";

import type { AgentEnvironment } from "../environment/agent-environment.ts";

export interface AgentHarnessState {
  readonly sessionFile: string;
  readonly agentDirectory: string;
}

export interface AgentHarnessStartOptions {
  readonly input: string;
  readonly environment: AgentEnvironment;
  readonly modelRuntime: SessionModelRuntime;
  readonly state: AgentHarnessState;
}

export type AgentHarnessEvent =
  | { readonly _tag: "ConversationAppended"; readonly event: SessionConversationEvent }
  | { readonly _tag: "Live"; readonly event: SessionLiveEvent };

/** A single accepted run. Its finite event stream ends only after the run settles. */
export interface ActiveAgentRun {
  readonly events: Stream.Stream<AgentHarnessEvent, AgentHarnessError>;
  readonly followUp: (input: string) => Effect.Effect<void, AgentHarnessError>;
  /** Clears pending follow-ups before aborting the underlying run. */
  readonly abort: Effect.Effect<void, AgentHarnessError>;
}

export interface AgentHarness {
  readonly start: (
    options: AgentHarnessStartOptions,
  ) => Effect.Effect<ActiveAgentRun, AgentHarnessError, Scope.Scope>;
}

export const AgentHarness: Context.Service<AgentHarness, AgentHarness> = Context.Service(
  "@openorb/runner/AgentHarness",
);

export class AgentHarnessError extends Data.TaggedError("AgentHarnessError")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  constructor(message: string, cause: unknown) {
    super({ message, cause });
  }
}
