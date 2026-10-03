import { Context, Data, type Effect, type Scope, type Stream } from "effect";
import type { ConversationView } from "@earendil-works/pi-durable";
import type {
  EnvironmentState,
  SessionId,
  SessionModelRuntime,
  SubmissionId,
  ThinkingLevel,
} from "@openorb/protocol/runner-api";

import type { AgentEnvironment, AgentEnvironmentError } from "../environment/agent-environment.ts";

export type { ConversationView };

export interface AgentHarnessState {
  readonly directory: string;
}

export interface AgentHarnessOpenOptions {
  readonly sessionId: SessionId;
  readonly environment: AgentEnvironment;
  /** Live host-side state; reading it never acquires guest compute. */
  readonly environmentState: EnvironmentState;
  /** Current state followed by changes; running means the project is prepared. */
  readonly environmentStates: Stream.Stream<EnvironmentState>;
  readonly git: {
    readonly repositoryUrl: string;
    readonly branchName: string;
  };
  readonly modelRuntime: SessionModelRuntime;
  readonly state: AgentHarnessState;
  readonly controlEnvironment: (
    action: "start" | "stop" | "restart",
  ) => Effect.Effect<{ state: "running" | "stopped"; forced: boolean }, AgentEnvironmentError>;
}

export interface AgentHarnessSession {
  readonly updateModelRuntime: (
    modelRuntime: SessionModelRuntime,
  ) => Effect.Effect<void, AgentHarnessError>;
  readonly setThinkingLevel: (
    level: ThinkingLevel,
  ) => Effect.Effect<ThinkingLevel, AgentHarnessError>;
  readonly submit: (
    input: string,
    requestId: string,
  ) => Effect.Effect<SubmissionId, AgentHarnessError>;
  readonly resume: Effect.Effect<void, AgentHarnessError>;
  readonly abort: Effect.Effect<void, AgentHarnessError>;
  readonly view: ConversationView;
  readonly views: Stream.Stream<ConversationView, AgentHarnessError>;
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
