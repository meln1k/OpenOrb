import { assertEquals, assertThrows } from "@std/assert";
import type { JsonObject } from "@earendil-works/pi-durable";
import { ConversationViewSchema } from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import {
  appendOptimisticUserMessage,
  createSessionTranscriptState,
  reduceSessionTranscriptState,
  totalSessionUsage,
} from "./session-transcript-state.ts";

const view = (entries: readonly unknown[] = [], docs: JsonObject = {}) =>
  Schema.decodeUnknownSync(ConversationViewSchema)({ conversation: { id: 0 }, entries, docs });
const user = (id: number, text: string) => ({
  id,
  conversationId: 0,
  kind: "pi.user",
  model: [{ role: "user", content: text, timestamp: 1 }],
});
const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "Final answer" }],
  usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.1 } },
};
const initial = () => createSessionTranscriptState("running", "high");

Deno.test("snapshot replacement and Chord root replacement never append old transcript", () => {
  let state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([user(1, "old")]),
  });
  state = reduceSessionTranscriptState(state, {
    type: "conversation.snapshot",
    view: view([user(2, "new")]),
  });
  assertEquals(state.entries, [{ role: "user", messageId: "2:0", text: "new" }]);
  state = reduceSessionTranscriptState(state, {
    type: "conversation.ops",
    ops: [["r", { conversation: { id: 0 }, entries: [], docs: {} }]],
  });
  assertEquals(state.entries, []);
  assertThrows(() =>
    reduceSessionTranscriptState(initial(), { type: "conversation.ops", ops: [] })
  );
});

Deno.test("partial removal and final entry in one atomic batch render exactly one answer", () => {
  const before = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([], { "pi.live": { generation: { message: assistant } } }),
  });
  const after = reduceSessionTranscriptState(before, {
    type: "conversation.ops",
    ops: [
      ["d", ["docs", "pi.live", "generation"]],
      ["p", ["entries"], 0, 0, [{
        id: 1,
        conversationId: 0,
        kind: "pi.assistant",
        model: [assistant],
      }]],
    ],
  });
  assertEquals(after.entries, [{
    role: "assistant",
    messageId: "1:0",
    text: "Final answer",
    thinking: "",
    completed: true,
  }]);
  assertEquals(before.view?.docs["pi.live"]?.generation !== undefined, true);
});

Deno.test("compaction shrinks active transcript but usage remains the durable ledger", () => {
  let state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([user(1, "old")]),
  });
  state = reduceSessionTranscriptState(state, {
    type: "conversation.snapshot",
    view: view([
      {
        id: 2,
        conversationId: 0,
        kind: "pi.compaction",
        head: 2,
        model: [{ role: "user", content: "Summary" }],
      },
    ], {
      "pi.usage": { models: { "provider/model": assistant.usage }, tools: {} },
      "pi.agent": { thinkingLevel: "max" },
      "pi.inbox": {
        items: [{ id: 3, mode: "followUp", content: [{ type: "text", text: "Next" }] }],
      },
    }),
  });
  assertEquals(state.entries, [{ id: 2, label: "Context compacted", detail: "Summary" }]);
  assertEquals(state.thinkingLevel, "max");
  assertEquals(state.followUpQueue, ["Next"]);
  assertEquals(totalSessionUsage(state).totalTokens, 15);
  assertEquals(state.contextUsage, undefined);
});

Deno.test("environment stopping never settles or discards a running agent partial", () => {
  const before = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([], { "pi.live": { generation: { message: assistant } } }),
  });
  const after = reduceSessionTranscriptState(before, {
    type: "session.state",
    stage: "stopping",
    agentState: "running",
    environmentState: "stopping",
    checkoutState: "available",
    issues: [],
  });
  assertEquals(after.entries, before.entries);
  assertEquals(after.status, "Agent running · Environment stopping");
});

Deno.test("optimistic prompt survives replacement and only a newly observed matching entry reconciles it", () => {
  let state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([user(1, "again")]),
  });
  state = appendOptimisticUserMessage(state, "pending-1", "again");
  state = reduceSessionTranscriptState(state, {
    type: "conversation.snapshot",
    view: view([user(1, "again")]),
  });
  assertEquals(state.entries.length, 2);
  state = reduceSessionTranscriptState(state, {
    type: "conversation.snapshot",
    view: view([user(1, "again"), user(2, "again")]),
  });
  assertEquals(state.entries.length, 2);
  assertEquals(state.entries.some((entry) => "delivery" in entry), false);
});

Deno.test("tool projection retains arguments and suppresses read output without rewriting replicated state", () => {
  const mounted = view([
    {
      id: 1,
      conversationId: 0,
      kind: "pi.assistant",
      model: [{
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "/workspace/a" },
        }],
      }],
    },
  ], {
    "pi.live": {
      tools: [{ callId: "call-1", name: "read", status: "running", output: "file contents" }],
    },
  });
  const state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: mounted,
  });
  assertEquals(state.entries, [{
    role: "tool",
    toolCallId: "call-1",
    toolName: "read",
    arguments: '{"path":"/workspace/a"}',
    active: true,
  }]);
  assertEquals(state.view, mounted);
});

for (const toolName of ["read", "readImage"]) {
  Deno.test(`${toolName} images use artifact Markdown while text output stays hidden`, () => {
    const artifactId = "01989d78-65ee-8f6a-a97e-0f16ad134c10";
    const state = reduceSessionTranscriptState(initial(), {
      type: "conversation.snapshot",
      view: view([{
        id: 1,
        conversationId: 0,
        kind: "pi.tool-result",
        model: [{
          role: "toolResult",
          toolCallId: "read-image",
          toolName,
          content: [
            { type: "text", text: "hidden file output" },
            { type: "image", artifactId },
            { type: "image", text: "[Image unavailable: unsupported format]" },
          ],
        }],
      }]),
    });
    assertEquals(state.entries, [{
      role: "tool",
      toolCallId: "read-image",
      toolName,
      active: false,
      isError: false,
      result:
        `\n\n![Image](openorb-artifact:image:${artifactId})\n\n[Image unavailable: unsupported format]`,
    }]);
  });

  Deno.test(`${toolName} errors retain diagnostic text`, () => {
    const state = reduceSessionTranscriptState(initial(), {
      type: "conversation.snapshot",
      view: view([{
        id: 1,
        conversationId: 0,
        kind: "pi.tool-result",
        model: [{
          role: "toolResult",
          toolCallId: "failed-read",
          toolName,
          isError: true,
          content: [{ type: "text", text: "Guest file could not be read." }],
        }],
      }]),
    });
    assertEquals(state.entries, [{
      role: "tool",
      toolCallId: "failed-read",
      toolName,
      active: false,
      isError: true,
      result: "Guest file could not be read.",
    }]);
  });
}
