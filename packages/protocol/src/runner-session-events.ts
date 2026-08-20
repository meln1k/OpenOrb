import { array, literal, number, object, optional, string, union } from "@remix-run/data-schema";

import type { InferOutput } from "@remix-run/data-schema";
import type { RunnerMessage } from "@/src/runner-message.ts";
import type { RunnerSessionState } from "@/src/runner-session-inventory.ts";

export const SESSION_EVENT_MESSAGE_TYPE = "session.event";
export const SESSION_EVENT_REPLAY_MESSAGE_TYPE = "session.event.replay";
export const SESSION_EVENT_REPLAY_RESULT_MESSAGE_TYPE = "session.event.replay.result";
export const MAX_PROVISIONING_EVENT_TEXT_BYTES = 16 * 1024;
export const MAX_USER_MESSAGE_TEXT_BYTES = 32 * 1024;
export const MAX_SESSION_MESSAGE_TEXT_BYTES = 24 * 1024;
export const MAX_TOOL_EVENT_TEXT_BYTES = 24 * 1024;
export const MAX_ACTIVITY_EVENT_TEXT_BYTES = 8 * 1024;
export const MAX_QUEUED_SESSION_MESSAGES = 8;
export const MAX_QUEUED_MESSAGE_TEXT_BYTES = 2 * 1024;

const booleanSchema = union([literal(true), literal(false)]);
const nonNegativeIntegerSchema = number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a non-negative safe integer.",
);
const nonNegativeNumberSchema = number().refine(
  (value) => Number.isFinite(value) && value >= 0,
  "Expected a finite non-negative number.",
);
const compactionReasonSchema = union([
  literal("manual" as const),
  literal("threshold" as const),
  literal("overflow" as const),
]);
const messageRoleSchema = union([
  literal("user" as const),
  literal("assistant" as const),
  literal("toolResult" as const),
  literal("bashExecution" as const),
  literal("custom" as const),
  literal("branchSummary" as const),
  literal("compactionSummary" as const),
]);
const thinkingLevelSchema = union([
  literal("off" as const),
  literal("minimal" as const),
  literal("low" as const),
  literal("medium" as const),
  literal("high" as const),
  literal("xhigh" as const),
  literal("max" as const),
]);
const sessionEntryTypeSchema = union([
  literal("message" as const),
  literal("thinking_level_change" as const),
  literal("model_change" as const),
  literal("compaction" as const),
  literal("branch_summary" as const),
  literal("custom" as const),
  literal("custom_message" as const),
  literal("label" as const),
  literal("session_info" as const),
]);

export const sessionUsageSchema = object(
  {
    inputTokens: nonNegativeIntegerSchema,
    outputTokens: nonNegativeIntegerSchema,
    cacheReadTokens: nonNegativeIntegerSchema,
    cacheWriteTokens: nonNegativeIntegerSchema,
    totalTokens: nonNegativeIntegerSchema,
    totalCost: nonNegativeNumberSchema,
  },
  { unknownKeys: "error" },
);

export type SessionUsage = InferOutput<typeof sessionUsageSchema>;

export const runnerCheckoutStateSchema = union([
  literal("pending" as const),
  literal("available" as const),
  literal("unavailable" as const),
]);

export type RunnerCheckoutState = InferOutput<typeof runnerCheckoutStateSchema>;

export const sessionProvisioningStageSchema = union([
  literal("created" as const),
  literal("starting-vm" as const),
  literal("cloning" as const),
  literal("creating-branch" as const),
  literal("setup" as const),
  literal("running" as const),
  literal("ready" as const),
  literal("failed" as const),
]);

export type SessionProvisioningStage = InferOutput<typeof sessionProvisioningStageSchema>;

export function runnerSessionStateForProvisioningStage(
  stage: SessionProvisioningStage,
): RunnerSessionState {
  switch (stage) {
    case "created":
      return "created";
    case "ready":
      return "ready";
    case "running":
      return "running";
    case "failed":
      return "error";
    default:
      return "provisioning";
  }
}

const provisioningStateEventSchema = object(
  {
    type: literal("session.state" as const),
    stage: sessionProvisioningStageSchema,
    checkoutState: runnerCheckoutStateSchema,
  },
  { unknownKeys: "error" },
);

const userMessageEventSchema = object(
  {
    type: literal("user.message" as const),
    messageId: eventIdentifierSchema("User message identifiers"),
    text: string().refine(
      (value) => value.length > 0 && byteLength(value) <= MAX_USER_MESSAGE_TEXT_BYTES,
      `User messages must contain at most ${MAX_USER_MESSAGE_TEXT_BYTES} UTF-8 bytes.`,
    ),
  },
  { unknownKeys: "error" },
);

const assistantCompletedEventSchema = object(
  {
    type: literal("assistant.completed" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    text: boundedTextSchema(MAX_SESSION_MESSAGE_TEXT_BYTES, "Assistant text"),
    thinking: boundedTextSchema(MAX_SESSION_MESSAGE_TEXT_BYTES, "Assistant thinking"),
    stopReason: union([
      literal("stop" as const),
      literal("length" as const),
      literal("toolUse" as const),
      literal("error" as const),
      literal("aborted" as const),
      literal("deferred" as const),
      literal("pending" as const),
    ]),
    usage: sessionUsageSchema,
  },
  { unknownKeys: "error" },
);

const toolStartedEventSchema = object(
  {
    type: literal("tool.started" as const),
    toolCallId: eventIdentifierSchema("Tool call identifiers"),
    toolName: eventIdentifierSchema("Tool names"),
    arguments: boundedTextSchema(MAX_TOOL_EVENT_TEXT_BYTES, "Tool arguments"),
  },
  { unknownKeys: "error" },
);

const toolCompletedEventSchema = object(
  {
    type: literal("tool.completed" as const),
    toolCallId: eventIdentifierSchema("Tool call identifiers"),
    toolName: eventIdentifierSchema("Tool names"),
    result: boundedTextSchema(MAX_TOOL_EVENT_TEXT_BYTES, "Tool results"),
    isError: union([literal(true), literal(false)]),
  },
  { unknownKeys: "error" },
);

const provisioningLogEventSchema = object(
  {
    type: literal("provisioning.log" as const),
    stream: union([literal("stdout" as const), literal("stderr" as const)]),
    text: string().refine(
      (value) => value.length > 0 && byteLength(value) <= MAX_PROVISIONING_EVENT_TEXT_BYTES,
      `Provisioning log events must contain at most ${MAX_PROVISIONING_EVENT_TEXT_BYTES} UTF-8 bytes.`,
    ),
  },
  { unknownKeys: "error" },
);

const conversationResetEventSchema = object(
  { type: literal("conversation.reset" as const) },
  { unknownKeys: "error" },
);

const assistantTextDeltaEventSchema = object(
  {
    type: literal("assistant.text.delta" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    delta: boundedTextSchema(MAX_PROVISIONING_EVENT_TEXT_BYTES, "Assistant text deltas"),
  },
  { unknownKeys: "error" },
);

const assistantThinkingDeltaEventSchema = object(
  {
    type: literal("assistant.thinking.delta" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    delta: boundedTextSchema(MAX_PROVISIONING_EVENT_TEXT_BYTES, "Assistant thinking deltas"),
  },
  { unknownKeys: "error" },
);

const agentStartedEventSchema = object(
  { type: literal("agent.started" as const) },
  { unknownKeys: "error" },
);

const agentEndedEventSchema = object(
  {
    type: literal("agent.ended" as const),
    willRetry: booleanSchema,
  },
  { unknownKeys: "error" },
);

const agentSettledEventSchema = object(
  { type: literal("agent.settled" as const) },
  { unknownKeys: "error" },
);

const turnStartedEventSchema = object(
  { type: literal("turn.started" as const) },
  { unknownKeys: "error" },
);

const turnCompletedEventSchema = object(
  {
    type: literal("turn.completed" as const),
    toolResultCount: nonNegativeIntegerSchema,
  },
  { unknownKeys: "error" },
);

const messageStartedEventSchema = object(
  {
    type: literal("message.started" as const),
    messageId: eventIdentifierSchema("Message identifiers"),
    role: messageRoleSchema,
  },
  { unknownKeys: "error" },
);

const messageCompletedEventSchema = object(
  {
    type: literal("message.completed" as const),
    messageId: eventIdentifierSchema("Message identifiers"),
    role: messageRoleSchema,
  },
  { unknownKeys: "error" },
);

const assistantStreamStartedEventSchema = object(
  {
    type: literal("assistant.stream.started" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
  },
  { unknownKeys: "error" },
);

const assistantContentStartedEventSchema = object(
  {
    type: literal("assistant.content.started" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    contentIndex: nonNegativeIntegerSchema,
    contentType: union([literal("text" as const), literal("thinking" as const)]),
  },
  { unknownKeys: "error" },
);

const assistantContentCompletedEventSchema = object(
  {
    type: literal("assistant.content.completed" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    contentIndex: nonNegativeIntegerSchema,
    contentType: union([literal("text" as const), literal("thinking" as const)]),
  },
  { unknownKeys: "error" },
);

const assistantToolCallStartedEventSchema = object(
  {
    type: literal("assistant.tool-call.started" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    contentIndex: nonNegativeIntegerSchema,
  },
  { unknownKeys: "error" },
);

const assistantToolCallDeltaEventSchema = object(
  {
    type: literal("assistant.tool-call.delta" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    contentIndex: nonNegativeIntegerSchema,
    delta: boundedTextSchema(MAX_ACTIVITY_EVENT_TEXT_BYTES, "Assistant tool call deltas"),
  },
  { unknownKeys: "error" },
);

const assistantToolCallCompletedEventSchema = object(
  {
    type: literal("assistant.tool-call.completed" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    contentIndex: nonNegativeIntegerSchema,
    toolCallId: eventIdentifierSchema("Tool call identifiers"),
    toolName: eventIdentifierSchema("Tool names"),
    arguments: boundedTextSchema(MAX_TOOL_EVENT_TEXT_BYTES, "Tool arguments"),
  },
  { unknownKeys: "error" },
);

const assistantStreamCompletedEventSchema = object(
  {
    type: literal("assistant.stream.completed" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    reason: union([
      literal("stop" as const),
      literal("length" as const),
      literal("toolUse" as const),
      literal("deferred" as const),
    ]),
  },
  { unknownKeys: "error" },
);

const assistantStreamFailedEventSchema = object(
  {
    type: literal("assistant.stream.failed" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    reason: union([literal("aborted" as const), literal("error" as const)]),
    errorMessage: optional(boundedTextSchema(MAX_ACTIVITY_EVENT_TEXT_BYTES, "Model errors")),
  },
  { unknownKeys: "error" },
);

const assistantUsageUpdatedEventSchema = object(
  {
    type: literal("assistant.usage.updated" as const),
    messageId: eventIdentifierSchema("Assistant message identifiers"),
    usage: sessionUsageSchema,
  },
  { unknownKeys: "error" },
);

const toolUpdatedEventSchema = object(
  {
    type: literal("tool.updated" as const),
    toolCallId: eventIdentifierSchema("Tool call identifiers"),
    toolName: eventIdentifierSchema("Tool names"),
    partialResult: boundedTextSchema(MAX_TOOL_EVENT_TEXT_BYTES, "Partial tool results"),
  },
  { unknownKeys: "error" },
);

const queuedMessageSchema = boundedTextSchema(
  MAX_QUEUED_MESSAGE_TEXT_BYTES,
  "Queued messages",
);
const queuedMessagesSchema = array(queuedMessageSchema).refine(
  (messages) => messages.length <= MAX_QUEUED_SESSION_MESSAGES,
  `Expected at most ${MAX_QUEUED_SESSION_MESSAGES} queued messages.`,
);
const queueUpdatedEventSchema = object(
  {
    type: literal("queue.updated" as const),
    steering: queuedMessagesSchema,
    followUp: queuedMessagesSchema,
  },
  { unknownKeys: "error" },
);

const compactionStartedEventSchema = object(
  {
    type: literal("compaction.started" as const),
    reason: compactionReasonSchema,
  },
  { unknownKeys: "error" },
);

const compactionCompletedEventSchema = object(
  {
    type: literal("compaction.completed" as const),
    reason: compactionReasonSchema,
    aborted: booleanSchema,
    willRetry: booleanSchema,
    summary: optional(boundedTextSchema(MAX_ACTIVITY_EVENT_TEXT_BYTES, "Compaction summaries")),
    tokensBefore: optional(nonNegativeIntegerSchema),
    estimatedTokensAfter: optional(nonNegativeIntegerSchema),
    errorMessage: optional(boundedTextSchema(MAX_ACTIVITY_EVENT_TEXT_BYTES, "Compaction errors")),
  },
  { unknownKeys: "error" },
);

const modelRetryStartedEventSchema = object(
  {
    type: literal("model.retry.started" as const),
    attempt: nonNegativeIntegerSchema,
    maxAttempts: nonNegativeIntegerSchema,
    delayMs: nonNegativeIntegerSchema,
    errorMessage: boundedTextSchema(MAX_ACTIVITY_EVENT_TEXT_BYTES, "Model retry errors"),
  },
  { unknownKeys: "error" },
);

const modelRetryCompletedEventSchema = object(
  {
    type: literal("model.retry.completed" as const),
    success: booleanSchema,
    attempt: nonNegativeIntegerSchema,
    finalError: optional(boundedTextSchema(MAX_ACTIVITY_EVENT_TEXT_BYTES, "Model retry errors")),
  },
  { unknownKeys: "error" },
);

const summarizationRetryScheduledEventSchema = object(
  {
    type: literal("summarization.retry.scheduled" as const),
    attempt: nonNegativeIntegerSchema,
    maxAttempts: nonNegativeIntegerSchema,
    delayMs: nonNegativeIntegerSchema,
    errorMessage: boundedTextSchema(MAX_ACTIVITY_EVENT_TEXT_BYTES, "Summarization errors"),
  },
  { unknownKeys: "error" },
);

const summarizationRetryStartedEventSchema = union([
  object(
    {
      type: literal("summarization.retry.started" as const),
      source: literal("branchSummary" as const),
    },
    { unknownKeys: "error" },
  ),
  object(
    {
      type: literal("summarization.retry.started" as const),
      source: literal("compaction" as const),
      reason: compactionReasonSchema,
    },
    { unknownKeys: "error" },
  ),
]);

const summarizationRetryCompletedEventSchema = object(
  { type: literal("summarization.retry.completed" as const) },
  { unknownKeys: "error" },
);

const sessionEntryAppendedEventSchema = object(
  {
    type: literal("session.entry.appended" as const),
    entryId: eventIdentifierSchema("Session entry identifiers"),
    entryType: sessionEntryTypeSchema,
  },
  { unknownKeys: "error" },
);

const sessionInfoChangedEventSchema = object(
  {
    type: literal("session.info.changed" as const),
    name: optional(boundedTextSchema(256, "Session names")),
  },
  { unknownKeys: "error" },
);

const thinkingLevelChangedEventSchema = object(
  {
    type: literal("thinking-level.changed" as const),
    level: thinkingLevelSchema,
  },
  { unknownKeys: "error" },
);

const bashOutputDeltaEventSchema = object(
  {
    type: literal("bash.output.delta" as const),
    id: optional(eventIdentifierSchema("Bash execution identifiers")),
    delta: boundedTextSchema(MAX_PROVISIONING_EVENT_TEXT_BYTES, "Bash output deltas"),
  },
  { unknownKeys: "error" },
);

export const sessionConversationEventSchema = union([
  userMessageEventSchema,
  assistantCompletedEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
]);

export const sessionLiveEventSchema = union([
  provisioningStateEventSchema,
  conversationResetEventSchema,
  provisioningLogEventSchema,
  assistantTextDeltaEventSchema,
  assistantThinkingDeltaEventSchema,
  agentStartedEventSchema,
  agentEndedEventSchema,
  agentSettledEventSchema,
  turnStartedEventSchema,
  turnCompletedEventSchema,
  messageStartedEventSchema,
  messageCompletedEventSchema,
  assistantStreamStartedEventSchema,
  assistantContentStartedEventSchema,
  assistantContentCompletedEventSchema,
  assistantToolCallStartedEventSchema,
  assistantToolCallDeltaEventSchema,
  assistantToolCallCompletedEventSchema,
  assistantStreamCompletedEventSchema,
  assistantStreamFailedEventSchema,
  assistantUsageUpdatedEventSchema,
  toolUpdatedEventSchema,
  queueUpdatedEventSchema,
  compactionStartedEventSchema,
  compactionCompletedEventSchema,
  modelRetryStartedEventSchema,
  modelRetryCompletedEventSchema,
  summarizationRetryScheduledEventSchema,
  summarizationRetryStartedEventSchema,
  summarizationRetryCompletedEventSchema,
  sessionEntryAppendedEventSchema,
  sessionInfoChangedEventSchema,
  thinkingLevelChangedEventSchema,
  bashOutputDeltaEventSchema,
]);

export const sessionEventSchema = union([sessionConversationEventSchema, sessionLiveEventSchema]);

export type SessionConversationEvent = InferOutput<typeof sessionConversationEventSchema>;
export type SessionLiveEvent = InferOutput<typeof sessionLiveEventSchema>;
export type SessionEvent = InferOutput<typeof sessionEventSchema>;

export const sessionEventPayloadSchema = union([
  object(
    {
      cursor: number().refine(
        (value) => Number.isSafeInteger(value) && value > 0,
        "Session event cursors must be positive safe integers.",
      ),
      event: sessionConversationEventSchema,
    },
    { unknownKeys: "error" },
  ),
  object(
    { event: sessionLiveEventSchema },
    { unknownKeys: "error" },
  ),
]);

export type SessionEventPayload = InferOutput<typeof sessionEventPayloadSchema>;

export const sessionEventReplayPayloadSchema = object(
  { afterCursor: nonNegativeIntegerSchema },
  { unknownKeys: "error" },
);

export const sessionEventReplayResultPayloadSchema = union([
  object(
    {
      status: literal("completed" as const),
      cursor: nonNegativeIntegerSchema,
    },
    { unknownKeys: "error" },
  ),
  object(
    { status: literal("failed" as const) },
    { unknownKeys: "error" },
  ),
]);

export type SessionEventReplayPayload = InferOutput<typeof sessionEventReplayPayloadSchema>;
export type SessionEventReplayResultPayload = InferOutput<
  typeof sessionEventReplayResultPayloadSchema
>;

export type SessionEventMessage = RunnerMessage<SessionEventPayload> & {
  type: typeof SESSION_EVENT_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};

export type SessionEventReplayCommand = RunnerMessage<SessionEventReplayPayload> & {
  type: typeof SESSION_EVENT_REPLAY_MESSAGE_TYPE;
  sessionId: string;
};

export type SessionEventReplayResultMessage = RunnerMessage<SessionEventReplayResultPayload> & {
  type: typeof SESSION_EVENT_REPLAY_RESULT_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function eventIdentifierSchema(label: string) {
  return string().refine(
    (value) => value.length > 0 && value.length <= 256,
    `${label} must contain at most 256 characters.`,
  );
}

function boundedTextSchema(maxBytes: number, label: string) {
  return string().refine(
    (value) => byteLength(value) <= maxBytes,
    `${label} must contain at most ${maxBytes} UTF-8 bytes.`,
  );
}
