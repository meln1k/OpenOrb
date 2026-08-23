import { assert, assertEquals } from "@std/assert";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { PiEventNormalizer, sessionUsage, truncateUtf8 } from "@/src/pi-event-normalizer.ts";
import type { SessionConversationEvent, SessionLiveEvent } from "@openorb/protocol";

Deno.test("does not durably publish an assistant message Pi did not persist", async () => {
  const conversation: SessionConversationEvent[] = [];
  const live: SessionLiveEvent[] = [];
  const normalizer = new PiEventNormalizer({
    getCompactionEntryId: () => undefined,
    getMessageEntryId: () => undefined,
    publishConversation(event) {
      conversation.push(event);
      return Promise.resolve();
    },
    publishLive(event) {
      live.push(event);
      return Promise.resolve();
    },
  });
  const partial = assistantMessage([]);
  normalizer.handle({ type: "message_start", message: partial });
  normalizer.handle({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Incomplete",
      partial,
    },
  });
  normalizer.handle({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "Incomplete" }], "aborted"),
  });

  await normalizer.flush();

  assertEquals(conversation, []);
  assert(live.some((event) => event.type === "assistant.text.delta"));
  assert(live.some((event) => event.type === "message.completed"));
});

Deno.test("normalizes only whitespace-only completed assistant content", async () => {
  const conversation: SessionConversationEvent[] = [];
  let nextEntryId = 1;
  const normalizer = new PiEventNormalizer({
    getCompactionEntryId: () => undefined,
    getMessageEntryId: () => `entry-${nextEntryId++}`,
    publishConversation(event) {
      conversation.push(event);
      return Promise.resolve();
    },
    publishLive() {
      return Promise.resolve();
    },
  });
  normalizer.handle({
    type: "message_end",
    message: assistantMessage([
      { type: "thinking", thinking: "\t", thinkingSignature: "reasoning_content" },
      { type: "text", text: "\n\n" },
      { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "pwd" } },
    ], "toolUse"),
  });
  normalizer.handle({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "  Meaningful answer\n" }], "stop"),
  });
  normalizer.handle({
    type: "message_end",
    message: assistantMessage([{
      type: "text",
      text: `${" \t\n".repeat(16 * 1024)}\u0000`,
    }], "toolUse"),
  });

  await normalizer.flush();

  assertEquals(conversation[0], {
    type: "assistant.completed",
    messageId: "entry-1",
    text: "",
    thinking: "",
    stopReason: "toolUse",
    usage: zeroUsage(),
  });
  assertEquals(conversation[1], {
    type: "assistant.completed",
    messageId: "entry-2",
    text: "  Meaningful answer\n",
    thinking: "",
    stopReason: "stop",
    usage: zeroUsage(),
  });
  assertEquals(conversation[2], {
    type: "assistant.completed",
    messageId: "entry-3",
    text: "",
    thinking: "",
    stopReason: "toolUse",
    usage: zeroUsage(),
  });
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
