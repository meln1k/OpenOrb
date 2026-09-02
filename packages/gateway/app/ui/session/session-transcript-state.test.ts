import { assertEquals } from "@std/assert";

import type { SessionEvent, SessionUsage } from "@openorb/protocol/browser-session-events";
import {
  appendOptimisticUserMessage,
  createSessionTranscriptState,
  failOptimisticUserMessage,
  reduceSessionTranscriptState,
  removeOptimisticUserMessage,
  runnerSessionStateForProvisioningStage,
  type SessionState,
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
  }, "running");
  assertEquals(compacted.contextUsage, undefined);

  const recovered = reduceSessionTranscriptState(
    compacted,
    completedAssistant("assistant-2", usage(20, 5)),
    "running",
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

Deno.test("optimistic user messages reconcile with durable events or retain failures", () => {
  const initial = createSessionTranscriptState("ready");
  const pending = appendOptimisticUserMessage(
    initial,
    "optimistic-1",
    "Continue the implementation",
  );
  assertEquals(pending.entries, [{
    role: "user",
    messageId: "optimistic-1",
    text: "Continue the implementation",
    delivery: "pending",
  }]);

  const failed = failOptimisticUserMessage(
    pending,
    "optimistic-1",
    "The pinned runner is offline.",
  );
  assertEquals(failed.entries, [{
    role: "user",
    messageId: "optimistic-1",
    text: "Continue the implementation",
    delivery: "failed",
    deliveryError: "The pinned runner is offline.",
  }]);

  const reconciled = reduceSessionTranscriptState(failed, {
    type: "user.message",
    messageId: "pi-user-1",
    text: "Continue the implementation",
  }, "ready");
  assertEquals(reconciled.entries, [{
    role: "user",
    messageId: "pi-user-1",
    text: "Continue the implementation",
  }]);
});

Deno.test("optimistic user messages reconcile after form line-ending normalization", () => {
  const pending = appendOptimisticUserMessage(
    createSessionTranscriptState("ready"),
    "optimistic-1",
    "rate the reliability\n",
  );

  const reconciled = reduceSessionTranscriptState(pending, {
    type: "user.message",
    messageId: "pi-user-1",
    text: "rate the reliability\r\n",
  }, "ready");

  assertEquals(reconciled.entries, [{
    role: "user",
    messageId: "pi-user-1",
    text: "rate the reliability\r\n",
  }]);
});

Deno.test("accepted follow-ups leave the optimistic transcript and track Pi's live queue", () => {
  const initial = createSessionTranscriptState("running");
  const pending = appendOptimisticUserMessage(initial, "optimistic-1", "First follow-up");
  const accepted = removeOptimisticUserMessage(pending, "optimistic-1");
  assertEquals(accepted.entries, []);

  const queued = reduceSessionTranscriptState(accepted, {
    type: "queue.updated",
    steering: [],
    followUp: ["First follow-up", "Second follow-up"],
  }, "running");
  assertEquals(queued.followUpQueue, ["First follow-up", "Second follow-up"]);

  const delivered = reduceSessionTranscriptState(queued, {
    type: "queue.updated",
    steering: [],
    followUp: ["Second follow-up"],
  }, "running");
  assertEquals(delivered.followUpQueue, ["Second follow-up"]);

  const ready = reduceSessionTranscriptState(delivered, {
    type: "session.state",
    stage: "ready",
    checkoutState: "available",
    issues: [],
  }, "ready");
  assertEquals(ready.followUpQueue, []);
});

Deno.test("checkpoint lifecycle stages expose transcript-specific status", () => {
  const checkpointing = reduceSessionTranscriptState(
    createSessionTranscriptState("ready"),
    { type: "session.state", stage: "checkpointing", checkoutState: "available", issues: [] },
    "provisioning",
  );
  assertEquals(checkpointing.status, "Creating checkpoint");

  const stopped = reduceSessionTranscriptState(checkpointing, {
    type: "session.state",
    stage: "stopped",
    checkoutState: "available",
    issues: [],
  }, "stopped");
  assertEquals(stopped.status, "Stopped");

  const resuming = reduceSessionTranscriptState(stopped, {
    type: "session.state",
    stage: "resuming",
    checkoutState: "available",
    issues: [],
  }, "provisioning");
  assertEquals(resuming.status, "Resuming checkpoint");
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
  let sessionState: SessionState = "running";
  let transcriptState = createSessionTranscriptState(sessionState);
  for (const event of events) {
    if (event.type === "session.state") {
      sessionState = runnerSessionStateForProvisioningStage(event.stage);
    }
    transcriptState = reduceSessionTranscriptState(transcriptState, event, sessionState);
  }
  return transcriptState;
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
