import { assert, assertEquals } from "@std/assert";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { parseSafe } from "@remix-run/data-schema";

import { PiEventNormalizer, sessionUsage, truncateUtf8 } from "@/src/pi-event-normalizer.ts";
import {
  type SessionConversationEvent,
  type SessionLiveEvent,
  sessionLiveEventSchema,
} from "@openorb/protocol";

Deno.test("projects Pi messages and tools into conversation events while relaying deltas live", async () => {
  const conversation: SessionConversationEvent[] = [];
  const live: SessionLiveEvent[] = [];
  const normalizer = new PiEventNormalizer({
    publishConversation(event) {
      conversation.push(event);
      return Promise.resolve();
    },
    publishLive(event) {
      live.push(event);
      return Promise.resolve();
    },
  });

  const user: UserMessage = {
    role: "user",
    content: "Inspect the repository",
    timestamp: -1,
  };
  normalizer.handle({ type: "message_start", message: user });
  normalizer.handle({ type: "message_end", message: user });
  const partial = assistantMessage([]);
  normalizer.handle({ type: "message_start", message: partial });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "Checking files. ",
      partial,
    },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "I found it.",
      partial,
    },
  });
  normalizer.handle({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "README.md" },
  });
  normalizer.handle({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "read",
    result: {
      content: [
        { type: "text", text: "OpenOrb" },
        { type: "image", data: "not-relayed", mimeType: "image/png" },
      ],
    },
    isError: false,
  });
  normalizer.handle({
    type: "message_end",
    message: assistantMessage([
      { type: "thinking", thinking: "Checking files. " },
      { type: "text", text: "I found it." },
    ], "stop"),
  });
  await normalizer.flush();

  assertEquals(conversation[0], {
    type: "user.message",
    messageId: "pi:user:-1",
    text: "Inspect the repository",
  });
  assertEquals(conversation.slice(1, 3), [
    {
      type: "tool.started",
      toolCallId: "tool-1",
      toolName: "read",
      arguments: '{"path":"README.md"}',
    },
    {
      type: "tool.completed",
      toolCallId: "tool-1",
      toolName: "read",
      result: "OpenOrb\n[Image result omitted]",
      isError: false,
    },
  ]);
  const completed = conversation[3];
  assert(completed?.type === "assistant.completed");
  assertEquals(completed.text, "I found it.");
  assertEquals(completed.thinking, "Checking files. ");
  assertEquals(completed.stopReason, "stop");
  assertEquals(completed.usage.totalTokens, 0);
  assertEquals(
    live.filter((event) =>
      event.type === "assistant.thinking.delta" || event.type === "assistant.text.delta"
    ),
    [
      {
        type: "assistant.thinking.delta",
        messageId: completed.messageId,
        delta: "Checking files. ",
      },
      {
        type: "assistant.text.delta",
        messageId: completed.messageId,
        delta: "I found it.",
      },
    ],
  );
  assert(live.some((event) => event.type === "message.started" && event.role === "assistant"));
  assert(live.some((event) => event.type === "message.completed" && event.role === "assistant"));
  assertEquals(live.filter((event) => event.type === "assistant.usage.updated").length, 2);
});

Deno.test("projects every meaningful Pi activity family into validated live events", async () => {
  const live: SessionLiveEvent[] = [];
  const normalizer = new PiEventNormalizer({
    secrets: ["provider-secret"],
    publishConversation() {
      return Promise.resolve();
    },
    publishLive(event) {
      live.push(event);
      return Promise.resolve();
    },
  });
  const partial = assistantMessage([]);
  const failed = assistantMessage([], "error", "provider-secret request failed");
  const user: UserMessage = { role: "user", content: "Prompt", timestamp: 10 };

  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "turn_start" });
  normalizer.handle({ type: "message_start", message: partial });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "start", partial },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "Inspecting",
      partial,
    },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "thinking_end",
      contentIndex: 0,
      content: "Inspecting",
      partial,
    },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 1, partial },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "Working",
      partial,
    },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "text_end",
      contentIndex: 1,
      content: "Working",
      partial,
    },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 2,
      delta: '{"path":',
      partial,
    },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
      partial,
    },
  });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "done", reason: "toolUse", message: partial },
  });
  normalizer.handle({
    type: "message_update",
    message: failed,
    assistantMessageEvent: { type: "error", reason: "error", error: failed },
  });
  normalizer.handle({
    type: "tool_execution_update",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "README.md" },
    partialResult: { content: [{ type: "text", text: "Partial" }] },
  });
  normalizer.handle({ type: "queue_update", steering: ["Steer"], followUp: ["Follow up"] });
  normalizer.handle({ type: "compaction_start", reason: "threshold" });
  normalizer.handle({
    type: "compaction_end",
    reason: "threshold",
    result: {
      summary: "Summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 1_000,
      estimatedTokensAfter: 400,
    },
    aborted: false,
    willRetry: false,
  });
  normalizer.handle({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 100,
    errorMessage: "provider-secret unavailable",
  });
  normalizer.handle({ type: "auto_retry_end", success: true, attempt: 1 });
  normalizer.handle({
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 100,
    errorMessage: "Summary failed",
  });
  normalizer.handle({
    type: "summarization_retry_attempt_start",
    source: "compaction",
    reason: "threshold",
  });
  normalizer.handle({ type: "summarization_retry_finished" });
  normalizer.handle({
    type: "entry_appended",
    entry: {
      type: "session_info",
      id: "entry-2",
      parentId: "entry-1",
      timestamp: "2026-08-20T00:00:00Z",
      name: "Session",
    },
  });
  normalizer.handle({ type: "session_info_changed", name: "Session" });
  normalizer.handle({ type: "thinking_level_changed", level: "high" });
  normalizer.handle({ type: "bash_execution_update", id: "bash-1", delta: "output" });
  normalizer.handle({ type: "turn_end", message: user, toolResults: [] });
  normalizer.handle({ type: "agent_end", messages: [user], willRetry: false });
  normalizer.handle({ type: "agent_settled" });
  await normalizer.flush();

  const types = new Set(live.map((event) => event.type));
  const expectedTypes: SessionLiveEvent["type"][] = [
    "agent.started",
    "agent.ended",
    "agent.settled",
    "turn.started",
    "turn.completed",
    "message.started",
    "assistant.stream.started",
    "assistant.content.started",
    "assistant.content.completed",
    "assistant.text.delta",
    "assistant.thinking.delta",
    "assistant.tool-call.started",
    "assistant.tool-call.delta",
    "assistant.tool-call.completed",
    "assistant.stream.completed",
    "assistant.stream.failed",
    "assistant.usage.updated",
    "tool.updated",
    "queue.updated",
    "compaction.started",
    "compaction.completed",
    "model.retry.started",
    "model.retry.completed",
    "summarization.retry.scheduled",
    "summarization.retry.started",
    "summarization.retry.completed",
    "session.entry.appended",
    "session.info.changed",
    "thinking-level.changed",
    "bash.output.delta",
  ];
  for (const type of expectedTypes) {
    assert(types.has(type), `Expected normalized event ${type}.`);
  }
  assert(
    live.every((event) => parseSafe(sessionLiveEventSchema, event).success),
    "Every normalized event must satisfy the wire schema.",
  );
  const serialized = JSON.stringify(live);
  assert(!serialized.includes("provider-secret"));
  assert(serialized.includes("[REDACTED]"));
});

Deno.test("bounds normalized UTF-8 text without splitting code points", () => {
  const truncated = truncateUtf8("🙂".repeat(100), 64);

  assert(new TextEncoder().encode(truncated).byteLength <= 64);
  assert(truncated.endsWith("\n[Truncated]"));
  assert(!truncated.includes("�"));
});

Deno.test("normalizes invalid provider usage into wire-safe values", () => {
  assertEquals(
    sessionUsage({
      input: Number.POSITIVE_INFINITY,
      output: -1,
      cacheRead: 1.9,
      cacheWrite: Number.NaN,
      totalTokens: Number.MAX_VALUE,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: Number.NEGATIVE_INFINITY,
      },
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
      totalCost: 0,
    },
  );
});

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "pending",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0,
  };
}
