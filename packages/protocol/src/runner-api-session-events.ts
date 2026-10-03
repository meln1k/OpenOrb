import * as Schema from "effect/Schema";
import { isConversationOps, isConversationView } from "./conversation-frame.ts";

export type { ConversationView, Op } from "./conversation-frame.ts";
export const MAX_RPC_SESSION_EVENT_TEXT_BYTES = 32 * 1024;
export const MAX_SESSION_ISSUES = 16;
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const SessionUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  totalCost: NonNegativeNumber,
});
export type SessionUsage = typeof SessionUsage.Type;

export const AgentState = Schema.Literals(["idle", "running", "paused", "error"]);
export type AgentState = typeof AgentState.Type;
export const EnvironmentState = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export type EnvironmentState = typeof EnvironmentState.Type;
export const RunnerCheckoutState = Schema.Literals(["pending", "available", "unavailable"]);
export type RunnerCheckoutState = typeof RunnerCheckoutState.Type;
export const SessionIssueCategory = Schema.Literals([
  "vm-start",
  "github-authentication",
  "clone",
  "setup",
  "resume-hook",
  "vm-stop",
  "model",
  "report",
  "operation-uncertain",
  "actor-crash",
  "runner-storage",
]);
export type SessionIssueCategory = typeof SessionIssueCategory.Type;
export const SessionRecoveryAction = Schema.Literals([
  "none",
  "retry-provisioning",
  "restart-environment",
]);
export type SessionRecoveryAction = typeof SessionRecoveryAction.Type;
export const SessionEnvironmentRecoveryMode = Schema.Literals(["restart-environment"]);
export type SessionEnvironmentRecoveryMode = typeof SessionEnvironmentRecoveryMode.Type;
export const SessionIssue = Schema.Struct({
  category: SessionIssueCategory,
  severity: Schema.Literals(["warning", "failure"]),
  message: boundedText(1_000).check(Schema.isMinLength(1)),
  diagnostics: Schema.optionalKey(boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES)),
  recovery: SessionRecoveryAction,
});
export type SessionIssue = typeof SessionIssue.Type;
export const SessionIssues = Schema.Array(SessionIssue).check(
  Schema.isMaxLength(MAX_SESSION_ISSUES),
);
export const SessionProvisioningStage = Schema.Literals([
  "created",
  "starting-vm",
  "cloning",
  "creating-branch",
  "setup",
  "resuming",
  "stopping",
  "running",
  "ready",
  "stopped",
  "failed",
]);
export type SessionProvisioningStage = typeof SessionProvisioningStage.Type;

export const ConversationViewSchema = Schema.declare(isConversationView, {
  toCodecJson: () => undefined,
});
export const ConversationOpsSchema = Schema.declare(isConversationOps, {
  toCodecJson: () => undefined,
});
export const ConversationFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("conversation.snapshot"), view: ConversationViewSchema }),
  Schema.Struct({ type: Schema.Literal("conversation.ops"), ops: ConversationOpsSchema }),
]);
export type ConversationFrame = typeof ConversationFrame.Type;

/** Infrastructure facts and exact structural Durable frames. No semantic replay or cursors. */
export const SessionEvent = Schema.Union([
  ConversationFrame,
  Schema.Struct({
    type: Schema.Literal("session.state"),
    stage: SessionProvisioningStage,
    agentState: AgentState,
    environmentState: EnvironmentState,
    checkoutState: RunnerCheckoutState,
    issues: SessionIssues,
  }),
  Schema.Struct({
    type: Schema.Literal("provisioning.log"),
    stream: Schema.Literals(["stdout", "stderr"]),
    text: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ type: Schema.Literal("git.snapshot.updated") }),
]);
export type SessionEvent = typeof SessionEvent.Type;

function boundedText(maximumBytes: number) {
  return Schema.String.check(
    Schema.makeFilter((value) =>
      new TextEncoder().encode(value).byteLength <= maximumBytes
        ? undefined
        : `Expected at most ${maximumBytes} UTF-8 bytes.`
    ),
  );
}
