import { assert, assertEquals } from "@std/assert";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Effect } from "effect";

import {
  makePiEventNormalizer,
  sessionUsage,
  stringify,
  truncateUtf8,
} from "@/src/harness/pi/event-normalizer.ts";
import type { SessionConversationEvent, SessionLiveEvent } from "@openorb/protocol";

Deno.test("does not durably publish an assistant message Pi did not persist", async () => {
  const conversation: SessionConversationEvent[] = [];
  const live: SessionLiveEvent[] = [];
  const normalize = makePiEventNormalizer({
    getCompactionEntryId: () => undefined,
    getMessageEntryId: () => undefined,
    publishConversation: (event) => Effect.sync(() => conversation.push(event)).pipe(Effect.asVoid),
    publishLive: (event) => Effect.sync(() => live.push(event)).pipe(Effect.asVoid),
  });
  const partial = assistantMessage([]);
  await Effect.runPromise(Effect.forEach(
    [
      { type: "message_start", message: partial } as const,
      {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Incomplete",
          partial,
        },
      } as const,
      {
        type: "message_end",
        message: assistantMessage([{ type: "text", text: "Incomplete" }], "aborted"),
      } as const,
    ],
    normalize,
    { discard: true },
  ));

  assertEquals(conversation, []);
  assert(live.some((event) => event.type === "assistant.text.delta"));
  assert(live.some((event) => event.type === "message.completed"));
});

Deno.test("normalizes only whitespace-only completed assistant content", async () => {
  const conversation: SessionConversationEvent[] = [];
  let nextEntryId = 1;
  const normalize = makePiEventNormalizer({
    getCompactionEntryId: () => undefined,
    getMessageEntryId: () => `entry-${nextEntryId++}`,
    publishConversation: (event) => Effect.sync(() => conversation.push(event)).pipe(Effect.asVoid),
    publishLive: () => Effect.void,
  });
  await Effect.runPromise(Effect.forEach(
    [
      {
        type: "message_end",
        message: assistantMessage([
          { type: "thinking", thinking: "\t", thinkingSignature: "reasoning_content" },
          { type: "text", text: "\n\n" },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "pwd" } },
        ], "toolUse"),
      } as const,
      {
        type: "message_end",
        message: assistantMessage([{ type: "text", text: "  Meaningful answer\n" }], "stop"),
      } as const,
      {
        type: "message_end",
        message: assistantMessage([{
          type: "text",
          text: `${" \t\n".repeat(16 * 1024)}\u0000`,
        }], "toolUse"),
      } as const,
    ],
    normalize,
    { discard: true },
  ));

  const completed = conversation.filter((event) => event.type === "assistant.completed");
  assertEquals(completed[0], {
    type: "assistant.completed",
    messageId: "entry-1",
    text: "",
    thinking: "",
    stopReason: "toolUse",
    usage: zeroUsage(),
  });
  assertEquals(completed[1], {
    type: "assistant.completed",
    messageId: "entry-2",
    text: "  Meaningful answer\n",
    thinking: "",
    stopReason: "stop",
    usage: zeroUsage(),
  });
  assertEquals(completed[2], {
    type: "assistant.completed",
    messageId: "entry-3",
    text: "",
    thinking: "",
    stopReason: "toolUse",
    usage: zeroUsage(),
  });
});

Deno.test("publishes tool conversation events only from persisted Pi messages", async () => {
  const conversation: SessionConversationEvent[] = [];
  const normalize = makePiEventNormalizer({
    getCompactionEntryId: () => undefined,
    getMessageEntryId: (message) => `entry-${message.role}`,
    publishConversation: (event) => Effect.sync(() => conversation.push(event)).pipe(Effect.asVoid),
    publishLive: () => Effect.void,
  });
  const toolCall = {
    type: "toolCall" as const,
    id: "tool-1",
    name: "bash",
    arguments: {
      command: "pwd",
    },
  };

  await Effect.runPromise(normalize({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  }));
  await Effect.runPromise(normalize({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: { content: [{ type: "text", text: "/workspace" }], details: {} },
    isError: false,
  }));
  assertEquals(conversation, []);

  await Effect.runPromise(normalize({
    type: "message_end",
    message: assistantMessage([toolCall], "toolUse"),
  }));
  await Effect.runPromise(normalize({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "/workspace" }],
      details: {},
      isError: false,
      timestamp: 1,
    },
  }));

  assertEquals(conversation, [
    {
      type: "assistant.completed",
      messageId: "entry-assistant",
      text: "",
      thinking: "",
      stopReason: "toolUse",
      usage: zeroUsage(),
    },
    {
      type: "tool.started",
      toolCallId: "tool-1",
      toolName: "bash",
      arguments: '{"command":"pwd"}',
    },
    {
      type: "tool.completed",
      toolCallId: "tool-1",
      toolName: "bash",
      result: "/workspace",
      isError: false,
    },
  ]);
});

Deno.test("bounds normalized UTF-8 text without splitting code points", () => {
  const truncated = truncateUtf8("🙂".repeat(100), 64);

  assert(new TextEncoder().encode(truncated).byteLength <= 64);
  assert(truncated.endsWith("\n[Truncated]"));
  assert(!truncated.includes("�"));
});

Deno.test("renders unserializable tool arguments without legacy Result plumbing", () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);

  assertEquals(stringify(cyclic), "[Unserializable tool arguments]");
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

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}
