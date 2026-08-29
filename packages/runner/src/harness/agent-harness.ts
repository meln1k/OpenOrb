import { Context, Data, type Effect, type Scope, type Stream } from "effect";
import type {
  EphemeralSessionEvent,
  SessionId,
  SessionModelRuntime,
} from "@openorb/protocol/runner-api";

import type { AgentEnvironment } from "../environment/agent-environment.ts";

export interface AgentHarnessState {
  readonly sessionFile: string;
  readonly agentDirectory: string;
}

export interface AgentHarnessOpenOptions {
  readonly sessionId: SessionId;
  readonly environment: AgentEnvironment;
  readonly git: {
    readonly repositoryUrl: string;
    readonly branchName: string;
  };
  readonly modelRuntime: SessionModelRuntime;
  readonly state: AgentHarnessState;
}

/** A single accepted run. Its finite event stream ends only after the run settles. */
export interface ActiveAgentRun {
  readonly events: Stream.Stream<EphemeralSessionEvent, AgentHarnessError>;
  readonly followUp: (input: string) => Effect.Effect<void, AgentHarnessError>;
  /** Clears pending follow-ups before aborting the underlying run. */
  readonly abort: Effect.Effect<void, AgentHarnessError>;
}

export interface AgentHarnessSession {
  readonly start: (input: string) => Effect.Effect<ActiveAgentRun, AgentHarnessError>;
}

export interface AgentHarness {
  readonly open: (
    options: AgentHarnessOpenOptions,
  ) => Effect.Effect<AgentHarnessSession, AgentHarnessError, Scope.Scope>;
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
