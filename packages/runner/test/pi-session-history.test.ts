import { assertEquals } from "@std/assert";
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
  session.appendMessage({
    role: "user",
    content: "Inspect only the source directory",
    timestamp: 3,
  });
  session.appendMessage({
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
      messageId: "pi:user:1",
      text: "Inspect the repository",
    },
    {
      type: "user.message",
      messageId: "pi:user:3",
      text: "Inspect only the source directory",
    },
    {
      type: "assistant.completed",
      messageId: "pi:assistant:4",
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
