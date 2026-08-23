import { assertEquals, assertNotEquals } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { eventsFromPiEntries } from "@/src/pi-session-history.ts";

Deno.test("projects only Pi's active conversation branch", () => {
  const session = SessionManager.inMemory("/workspace");
  const firstUserId = session.appendMessage({
    role: "user",
    content: "Inspect the repository",
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Abandoned response" }],
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
    stopReason: "stop",
    timestamp: 2,
  });
  session.branch(firstUserId);
  const secondUserId = session.appendMessage({
    role: "user",
    content: "Inspect only the source directory",
    timestamp: 3,
  });
  const activeAssistantId = session.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Checking source files", thinkingSignature: "private" },
      { type: "text", text: "The source directory is ready." },
    ],
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
    stopReason: "length",
    timestamp: 4,
  });

  assertEquals(eventsFromPiEntries(session.getBranch()), [
    {
      type: "user.message",
      messageId: firstUserId,
      text: "Inspect the repository",
    },
    {
      type: "user.message",
      messageId: secondUserId,
      text: "Inspect only the source directory",
    },
    {
      type: "assistant.completed",
      messageId: activeAssistantId,
      text: "The source directory is ready.",
      thinking: "Checking source files",
      stopReason: "length",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalTokens: 18,
        totalCost: 10,
      },
    },
  ]);
});

Deno.test("projects durable compaction boundaries and their usage in branch order", () => {
  const session = SessionManager.inMemory("/workspace");
  session.appendMessage({
    role: "user",
    content: "Inspect the repository",
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The initial context is large." }],
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: {
      input: 40_000,
      output: 1_000,
      cacheRead: 2_000,
      cacheWrite: 500,
      totalTokens: 43_500,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const keptEntryId = session.appendMessage({
    role: "user",
    content: "Keep this request",
    timestamp: 3,
  });
  const compactionId = session.appendCompaction(
    "The repository was inspected.",
    keptEntryId,
    43_500,
    undefined,
    false,
    {
      input: 2_000,
      output: 200,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 2_300,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 },
    },
  );
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Continuing after compaction." }],
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: {
      input: 4_000,
      output: 100,
      cacheRead: 500,
      cacheWrite: 0,
      totalTokens: 4_600,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 },
    },
    stopReason: "stop",
    timestamp: 4,
  });

  const events = eventsFromPiEntries(session.getBranch());
  assertEquals(events.map((event) => event.type), [
    "user.message",
    "assistant.completed",
    "user.message",
    "context.compacted",
    "assistant.completed",
  ]);
  assertEquals(events[3], {
    type: "context.compacted",
    compactionId,
    summary: "The repository was inspected.",
    tokensBefore: 43_500,
    usage: {
      inputTokens: 2_000,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      totalTokens: 2_300,
      totalCost: 3,
    },
  });
});

Deno.test("projects tool-only assistant turns with durable arguments and results", () => {
  const session = SessionManager.inMemory("/workspace");
  const assistantId = session.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "\t", thinkingSignature: "reasoning_content" },
      { type: "text", text: "\n\n" },
      {
        type: "toolCall",
        id: "tool-1",
        name: "bash",
        arguments: { command: "pwd" },
      },
    ],
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  });
  session.appendMessage({
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "bash",
    content: [{ type: "text", text: "/workspace" }],
    isError: false,
    timestamp: 2,
  });

  assertEquals(eventsFromPiEntries(session.getBranch()), [
    {
      type: "assistant.completed",
      messageId: assistantId,
      text: "",
      thinking: "",
      stopReason: "toolUse",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        totalCost: 0,
      },
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

Deno.test("uses durable entry IDs when same-role messages share a timestamp", () => {
  const session = SessionManager.inMemory("/workspace");
  const firstId = session.appendMessage({
    role: "user",
    content: "First prompt",
    timestamp: 7,
  });
  const secondId = session.appendMessage({
    role: "user",
    content: "Second prompt",
    timestamp: 7,
  });

  assertNotEquals(firstId, secondId);
  assertEquals(eventsFromPiEntries(session.getBranch()), [
    { type: "user.message", messageId: firstId, text: "First prompt" },
    { type: "user.message", messageId: secondId, text: "Second prompt" },
  ]);
});
