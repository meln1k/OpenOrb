import { assertEquals } from "@std/assert";

import type { SessionEvent, SessionUsage } from "@openorb/protocol";
import {
  createSessionTranscriptState,
  reduceSessionTranscriptState,
  type ToolEntry,
  totalSessionUsage,
  type TranscriptEntry,
} from "@/app/ui/session/session-transcript-state.ts";

Deno.test("commits streamed assistant content and usage under its durable message identity", () => {
  const state = reduce([
    { type: "message.started", role: "assistant" },
    { type: "assistant.text.delta", delta: "Hello" },
    { type: "assistant.thinking.delta", delta: "Reasoning" },
    { type: "assistant.usage.updated", usage: usage(4, 2) },
    {
      type: "assistant.completed",
      messageId: "entry-1",
      text: "Hello world",
      thinking: "Reasoning complete",
      stopReason: "stop",
      usage: usage(6, 3),
    },
  ]);

  assertEquals(state.entries.filter((entry) => "role" in entry && entry.role === "assistant"), [
    {
      role: "assistant",
      messageId: "entry-1",
      text: "Hello world",
      thinking: "Reasoning complete",
      completed: true,
    },
  ]);
  assertEquals([...state.usageByMessageId], [["entry-1", usage(6, 3)]]);
  assertEquals(totalSessionUsage(state), usage(6, 3));
});

Deno.test("conversation reset preserves provisioning output and discards incomplete content", () => {
  const state = reduce([
    { type: "provisioning.log", stream: "stdout", text: "Cloning repository\n" },
    { type: "user.message", messageId: "user-old", text: "Old prompt" },
    {
      type: "assistant.completed",
      messageId: "assistant-old",
      text: "Old answer",
      thinking: "",
      stopReason: "stop",
      usage: usage(2, 1),
    },
    { type: "message.started", role: "assistant" },
    { type: "assistant.text.delta", delta: "Incomplete answer" },
    { type: "conversation.reset" },
    { type: "user.message", messageId: "user-new", text: "Current prompt" },
  ]);

  assertEquals(state.entries, [
    {
      role: "provisioning",
      text: "Cloning repository\n",
    },
    { role: "user", messageId: "user-new", text: "Current prompt" },
  ]);
  assertEquals([...state.usageByMessageId], []);
  assertEquals(state.contextUsage, undefined);
});

Deno.test("compaction invalidates context usage until a valid assistant completion replaces it", () => {
  const beforeCompaction = reduce([
    completedAssistant("assistant-1", usage(100, 10)),
  ]);
  assertEquals(beforeCompaction.contextUsage, usage(100, 10));

  const compacted = reduceSessionTranscriptState(beforeCompaction, {
    type: "context.compacted",
    compactionId: "compaction-1",
    summary: "Condensed prior work",
    tokensBefore: 110,
    usage: undefined,
  });
  assertEquals(compacted.contextUsage, undefined);

  const recovered = reduceSessionTranscriptState(
    compacted,
    completedAssistant("assistant-2", usage(20, 5)),
  );
  assertEquals(recovered.contextUsage, usage(20, 5));
});

Deno.test("stream failure and explicit settlement finish transient transcript rows", () => {
  const failed = reduce([
    { type: "message.started", role: "assistant" },
    { type: "assistant.text.delta", delta: "Partial answer" },
    {
      type: "tool.started",
      toolCallId: "tool-1",
      toolName: "bash",
      arguments: '{"command":"pwd"}',
    },
    {
      type: "assistant.stream.failed",
      reason: "error",
      errorMessage: "Provider unavailable",
    },
  ]);
  assertEquals(
    failed.entries.find((entry) => "role" in entry && entry.role === "assistant"),
    {
      role: "assistant",
      text: "Partial answer",
      thinking: "",
      completed: true,
    },
  );
  assertEquals(toolEntries(failed.entries)[0]?.active, false);

  const settled = reduce([
    { type: "message.started", role: "assistant" },
    { type: "assistant.thinking.delta", delta: "Working" },
    { type: "agent.settled" },
  ]);
  assertEquals(
    settled.entries.find((entry) => "role" in entry && entry.role === "assistant"),
    {
      role: "assistant",
      text: "",
      thinking: "Working",
      completed: true,
    },
  );
});

Deno.test("duplicate durable events are idempotent", () => {
  const user: SessionEvent = {
    type: "user.message",
    messageId: "user-1",
    text: "Inspect the repository",
  };
  const assistant = completedAssistant("assistant-1", usage(8, 3));
  const state = reduce([user, assistant, user, assistant]);

  assertEquals(state.entries.filter(isMessageEntry).length, 2);
  assertEquals([...state.usageByMessageId], [["assistant-1", usage(8, 3)]]);
  assertEquals(totalSessionUsage(state), usage(8, 3));
});

Deno.test("agent and turn boundaries do not add transcript activity", () => {
  const state = reduce([
    { type: "agent.started" },
    { type: "turn.started" },
    { type: "turn.completed", toolResultCount: 2 },
    { type: "agent.settled" },
  ]);

  assertEquals(state.entries, []);
  assertEquals(state.nextActivityId, 1);
  assertEquals(state.status, "Agent running");
});

function reduce(events: SessionEvent[]) {
  return events.reduce(
    reduceSessionTranscriptState,
    createSessionTranscriptState("running", false),
  );
}

function usage(inputTokens: number, outputTokens: number): SessionUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    totalCost: inputTokens + outputTokens,
  };
}

function completedAssistant(messageId: string, eventUsage: SessionUsage): SessionEvent {
  return {
    type: "assistant.completed",
    messageId,
    text: `Answer from ${messageId}`,
    thinking: "",
    stopReason: "stop",
    usage: eventUsage,
  };
}

function toolEntries(entries: readonly TranscriptEntry[]): ToolEntry[] {
  return entries.filter(
    (entry): entry is ToolEntry => "role" in entry && entry.role === "tool",
  );
}

function isMessageEntry(entry: TranscriptEntry): boolean {
  return "role" in entry && (entry.role === "user" || entry.role === "assistant");
}
