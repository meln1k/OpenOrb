import * as Schema from "effect/Schema";

export const MAX_RPC_SESSION_EVENT_TEXT_BYTES = 32 * 1024;
export const MAX_RPC_QUEUED_SESSION_MESSAGES = 8;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const BooleanSchema = Schema.Boolean;
const CompactionReason = Schema.Literals(["manual", "threshold", "overflow"]);
const MessageRole = Schema.Literals([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);
const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const SessionEntryType = Schema.Literals([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);

export const SessionUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  totalCost: NonNegativeNumber,
});
export type SessionUsage = typeof SessionUsage.Type;

export const RunnerCheckoutState = Schema.Literals(["pending", "available", "unavailable"]);
export type RunnerCheckoutState = typeof RunnerCheckoutState.Type;

export const SessionProvisioningStage = Schema.Literals([
  "created",
  "starting-vm",
  "cloning",
  "creating-branch",
  "setup",
  "resuming",
  "checkpointing",
  "running",
  "ready",
  "stopped",
  "failed",
]);
export type SessionProvisioningStage = typeof SessionProvisioningStage.Type;

const ProvisioningStateEvent = Schema.Struct({
  type: Schema.Literal("session.state"),
  stage: SessionProvisioningStage,
  checkoutState: RunnerCheckoutState,
});

const UserMessageEvent = Schema.Struct({
  type: Schema.Literal("user.message"),
  messageId: eventIdentifier("User message identifiers"),
  text: nonEmptyBoundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "User messages"),
});

const AssistantCompletedEvent = Schema.Struct({
  type: Schema.Literal("assistant.completed"),
  messageId: eventIdentifier("Assistant message identifiers"),
  text: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Assistant text"),
  thinking: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Assistant thinking"),
  stopReason: Schema.Literals([
    "stop",
    "length",
    "toolUse",
    "error",
    "aborted",
    "deferred",
    "pending",
  ]),
  usage: SessionUsage,
});

const ToolStartedEvent = Schema.Struct({
  type: Schema.Literal("tool.started"),
  toolCallId: eventIdentifier("Tool call identifiers"),
  toolName: eventIdentifier("Tool names"),
  arguments: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Tool arguments"),
});

const ToolCompletedEvent = Schema.Struct({
  type: Schema.Literal("tool.completed"),
  toolCallId: eventIdentifier("Tool call identifiers"),
  toolName: eventIdentifier("Tool names"),
  result: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Tool results"),
  isError: BooleanSchema,
});

const ContextCompactedEvent = Schema.Struct({
  type: Schema.Literal("context.compacted"),
  compactionId: eventIdentifier("Compaction identifiers"),
  summary: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Compaction summaries"),
  tokensBefore: NonNegativeInt,
  usage: Schema.optionalKey(SessionUsage),
});

const ProvisioningLogEvent = Schema.Struct({
  type: Schema.Literal("provisioning.log"),
  stream: Schema.Literals(["stdout", "stderr"]),
  text: nonEmptyBoundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Provisioning log events"),
});

const ConversationResetEvent = Schema.Struct({
  type: Schema.Literal("conversation.reset"),
});

const AssistantTextDeltaEvent = Schema.Struct({
  type: Schema.Literal("assistant.text.delta"),
  delta: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Assistant text deltas"),
});

const AssistantThinkingDeltaEvent = Schema.Struct({
  type: Schema.Literal("assistant.thinking.delta"),
  delta: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Assistant thinking deltas"),
});

const AgentStartedEvent = Schema.Struct({ type: Schema.Literal("agent.started") });

const AgentEndedEvent = Schema.Struct({
  type: Schema.Literal("agent.ended"),
  willRetry: BooleanSchema,
});

const AgentSettledEvent = Schema.Struct({ type: Schema.Literal("agent.settled") });
const TurnStartedEvent = Schema.Struct({ type: Schema.Literal("turn.started") });
const GitSnapshotUpdatedEvent = Schema.Struct({ type: Schema.Literal("git.snapshot.updated") });

const TurnCompletedEvent = Schema.Struct({
  type: Schema.Literal("turn.completed"),
  toolResultCount: NonNegativeInt,
});

const MessageStartedEvent = Schema.Struct({
  type: Schema.Literal("message.started"),
  role: MessageRole,
});

const MessageCompletedEvent = Schema.Struct({
  type: Schema.Literal("message.completed"),
  role: MessageRole,
});

const AssistantStreamStartedEvent = Schema.Struct({
  type: Schema.Literal("assistant.stream.started"),
});

const AssistantContentStartedEvent = Schema.Struct({
  type: Schema.Literal("assistant.content.started"),
  contentIndex: NonNegativeInt,
  contentType: Schema.Literals(["text", "thinking"]),
});

const AssistantContentCompletedEvent = Schema.Struct({
  type: Schema.Literal("assistant.content.completed"),
  contentIndex: NonNegativeInt,
  contentType: Schema.Literals(["text", "thinking"]),
});

const AssistantToolCallStartedEvent = Schema.Struct({
  type: Schema.Literal("assistant.tool-call.started"),
  contentIndex: NonNegativeInt,
});

const AssistantToolCallDeltaEvent = Schema.Struct({
  type: Schema.Literal("assistant.tool-call.delta"),
  contentIndex: NonNegativeInt,
  delta: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Assistant tool call deltas"),
});

const AssistantToolCallCompletedEvent = Schema.Struct({
  type: Schema.Literal("assistant.tool-call.completed"),
  contentIndex: NonNegativeInt,
  toolCallId: eventIdentifier("Tool call identifiers"),
  toolName: eventIdentifier("Tool names"),
  arguments: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Tool arguments"),
});

const AssistantStreamCompletedEvent = Schema.Struct({
  type: Schema.Literal("assistant.stream.completed"),
  reason: Schema.Literals(["stop", "length", "toolUse", "deferred"]),
});

const AssistantStreamFailedEvent = Schema.Struct({
  type: Schema.Literal("assistant.stream.failed"),
  reason: Schema.Literals(["aborted", "error"]),
  errorMessage: Schema.optionalKey(
    boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Model errors"),
  ),
});

const AssistantUsageUpdatedEvent = Schema.Struct({
  type: Schema.Literal("assistant.usage.updated"),
  usage: SessionUsage,
});

const ToolUpdatedEvent = Schema.Struct({
  type: Schema.Literal("tool.updated"),
  toolCallId: eventIdentifier("Tool call identifiers"),
  toolName: eventIdentifier("Tool names"),
  partialResult: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Partial tool results"),
});

const QueuedMessages = Schema.Array(
  boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Queued messages"),
).check(
  Schema.isMaxLength(MAX_RPC_QUEUED_SESSION_MESSAGES, {
    message: `Expected at most ${MAX_RPC_QUEUED_SESSION_MESSAGES} queued messages.`,
  }),
);

const QueueUpdatedEvent = Schema.Struct({
  type: Schema.Literal("queue.updated"),
  steering: QueuedMessages,
  followUp: QueuedMessages,
});

const CompactionStartedEvent = Schema.Struct({
  type: Schema.Literal("compaction.started"),
  reason: CompactionReason,
});

const CompactionCompletedEvent = Schema.Struct({
  type: Schema.Literal("compaction.completed"),
  reason: CompactionReason,
  aborted: BooleanSchema,
  willRetry: BooleanSchema,
  summary: Schema.optionalKey(
    boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Compaction summaries"),
  ),
  tokensBefore: Schema.optionalKey(NonNegativeInt),
  estimatedTokensAfter: Schema.optionalKey(NonNegativeInt),
  errorMessage: Schema.optionalKey(
    boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Compaction errors"),
  ),
});

const ModelRetryStartedEvent = Schema.Struct({
  type: Schema.Literal("model.retry.started"),
  attempt: NonNegativeInt,
  maxAttempts: NonNegativeInt,
  delayMs: NonNegativeInt,
  errorMessage: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Model retry errors"),
});

const ModelRetryCompletedEvent = Schema.Struct({
  type: Schema.Literal("model.retry.completed"),
  success: BooleanSchema,
  attempt: NonNegativeInt,
  finalError: Schema.optionalKey(
    boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Model retry errors"),
  ),
});

const SummarizationRetryScheduledEvent = Schema.Struct({
  type: Schema.Literal("summarization.retry.scheduled"),
  attempt: NonNegativeInt,
  maxAttempts: NonNegativeInt,
  delayMs: NonNegativeInt,
  errorMessage: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Summarization errors"),
});

const SummarizationRetryStartedEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("summarization.retry.started"),
    source: Schema.Literal("branchSummary"),
  }),
  Schema.Struct({
    type: Schema.Literal("summarization.retry.started"),
    source: Schema.Literal("compaction"),
    reason: CompactionReason,
  }),
]);

const SummarizationRetryCompletedEvent = Schema.Struct({
  type: Schema.Literal("summarization.retry.completed"),
});

const SessionEntryAppendedEvent = Schema.Struct({
  type: Schema.Literal("session.entry.appended"),
  entryId: eventIdentifier("Session entry identifiers"),
  entryType: SessionEntryType,
});

const SessionInfoChangedEvent = Schema.Struct({
  type: Schema.Literal("session.info.changed"),
  name: Schema.optionalKey(boundedText(256, "Session names")),
});

const ThinkingLevelChangedEvent = Schema.Struct({
  type: Schema.Literal("thinking-level.changed"),
  level: ThinkingLevel,
});

const BashOutputDeltaEvent = Schema.Struct({
  type: Schema.Literal("bash.output.delta"),
  id: Schema.optionalKey(eventIdentifier("Bash execution identifiers")),
  delta: boundedText(MAX_RPC_SESSION_EVENT_TEXT_BYTES, "Bash output deltas"),
});

/** Replayable event payloads projected from Pi's durable session branch. */
export const DurableSessionEvent = Schema.Union([
  UserMessageEvent,
  AssistantCompletedEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  ContextCompactedEvent,
]);
export type DurableSessionEvent = typeof DurableSessionEvent.Type;

/** Transient event payloads observed while a session is running. */
export const EphemeralSessionEvent = Schema.Union([
  ProvisioningStateEvent,
  ConversationResetEvent,
  ProvisioningLogEvent,
  AssistantTextDeltaEvent,
  AssistantThinkingDeltaEvent,
  AgentStartedEvent,
  AgentEndedEvent,
  AgentSettledEvent,
  TurnStartedEvent,
  GitSnapshotUpdatedEvent,
  TurnCompletedEvent,
  MessageStartedEvent,
  MessageCompletedEvent,
  AssistantStreamStartedEvent,
  AssistantContentStartedEvent,
  AssistantContentCompletedEvent,
  AssistantToolCallStartedEvent,
  AssistantToolCallDeltaEvent,
  AssistantToolCallCompletedEvent,
  AssistantStreamCompletedEvent,
  AssistantStreamFailedEvent,
  AssistantUsageUpdatedEvent,
  ToolUpdatedEvent,
  QueueUpdatedEvent,
  CompactionStartedEvent,
  CompactionCompletedEvent,
  ModelRetryStartedEvent,
  ModelRetryCompletedEvent,
  SummarizationRetryScheduledEvent,
  SummarizationRetryStartedEvent,
  SummarizationRetryCompletedEvent,
  SessionEntryAppendedEvent,
  SessionInfoChangedEvent,
  ThinkingLevelChangedEvent,
  BashOutputDeltaEvent,
]);
export type EphemeralSessionEvent = typeof EphemeralSessionEvent.Type;

/** The single authoritative schema for every session event payload on the wire. */
export const SessionEvent = Schema.Union([DurableSessionEvent, EphemeralSessionEvent]);
export type SessionEvent = typeof SessionEvent.Type;

function eventIdentifier(label: string) {
  return Schema.String.check(
    Schema.isMinLength(1, { message: `${label} must not be empty.` }),
    Schema.isMaxLength(256, { message: `${label} must contain at most 256 characters.` }),
  );
}

function boundedText(maximumBytes: number, label: string) {
  return Schema.String.check(
    Schema.makeFilter(
      (value) =>
        utf8Length(value) <= maximumBytes
          ? undefined
          : `${label} must contain at most ${maximumBytes} UTF-8 bytes.`,
      { description: `${label} bounded to ${maximumBytes} UTF-8 bytes` },
    ),
  );
}

function nonEmptyBoundedText(maximumBytes: number, label: string) {
  return boundedText(maximumBytes, label).check(
    Schema.isMinLength(1, { message: `${label} must not be empty.` }),
  );
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
