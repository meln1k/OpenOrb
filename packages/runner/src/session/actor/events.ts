import {
  EnvironmentState,
  RunnerCheckoutState,
  RunnerId,
  RunnerSessionCreatedAt,
  SessionGitHead,
  SessionId,
  SessionIssue,
} from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import { RunnerSessionDefinition } from "../definition.ts";

/** Infrastructure facts only. Durable owns input admission, runs, abort and recovery. */
export const SessionEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session.provisioning-started"),
    id: SessionId,
    definition: RunnerSessionDefinition,
    runnerId: RunnerId,
    createdAt: RunnerSessionCreatedAt,
  }),
  Schema.Struct({ type: Schema.Literal("disk.initialized") }),
  Schema.Struct({ type: Schema.Literal("environment.changed"), state: EnvironmentState }),
  Schema.Struct({ type: Schema.Literal("stop.completed") }),
  Schema.Struct({ type: Schema.Literal("issue.recorded"), issue: SessionIssue }),
  Schema.Struct({
    type: Schema.Literal("checkout.updated"),
    checkoutState: RunnerCheckoutState,
    baseCommit: Schema.optionalKey(SessionGitHead),
  }),
  Schema.Struct({ type: Schema.Literal("message.accepted"), acceptedAt: RunnerSessionCreatedAt }),
]);
export type SessionEvent = typeof SessionEvent.Type;
