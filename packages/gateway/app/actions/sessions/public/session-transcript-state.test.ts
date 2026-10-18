import { test } from "vite-plus/test";
import { assertEquals, assertThrows } from "@jsr/std__assert";
import type { ConversationView, JsonObject } from "@earendil-works/pi-durable";
import {
  appendOptimisticUserMessage,
  createSessionTranscriptState,
  reduceSessionTranscriptState,
  totalSessionUsage,
} from "./session-transcript-state.ts";

// Fixtures reach the reducer as JSON, as frames from the Session Durable Object do.
const view = (entries: readonly unknown[] = [], docs: JsonObject = {}): ConversationView =>
  JSON.parse(JSON.stringify({ conversation: { id: 0 }, entries, docs }));
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

test("snapshot replacement and Chord root replacement never append old transcript", () => {
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
    reduceSessionTranscriptState(initial(), { type: "conversation.ops", ops: [] }),
  );
});

test("partial removal and final entry in one atomic batch render exactly one answer", () => {
  const before = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([], { "pi.live": { generation: { message: assistant } } }),
  });
  const after = reduceSessionTranscriptState(before, {
    type: "conversation.ops",
    ops: [
      ["d", ["docs", "pi.live", "generation"]],
      [
        "p",
        ["entries"],
        0,
        0,
        [
          {
            id: 1,
            conversationId: 0,
            kind: "pi.assistant",
            model: [assistant],
          },
        ],
      ],
    ],
  });
  assertEquals(after.entries, [
    {
      role: "assistant",
      messageId: "1:0",
      text: "Final answer",
      thinking: "",
      completed: true,
    },
  ]);
  assertEquals(before.view?.docs["pi.live"]?.generation !== undefined, true);
});

test("compaction shrinks active transcript but usage remains the durable ledger", () => {
  let state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([user(1, "old")]),
  });
  state = reduceSessionTranscriptState(state, {
    type: "conversation.snapshot",
    view: view(
      [
        {
          id: 2,
          conversationId: 0,
          kind: "pi.compaction",
          head: 2,
          model: [{ role: "user", content: "Summary" }],
        },
      ],
      {
        "pi.usage": { models: { "provider/model": assistant.usage }, tools: {} },
        "pi.agent": { thinkingLevel: "max" },
        "pi.inbox": {
          items: [{ id: 3, mode: "followUp", content: [{ type: "text", text: "Next" }] }],
        },
      },
    ),
  });
  assertEquals(state.entries, [{ id: 2, label: "Context compacted", detail: "Summary" }]);
  assertEquals(state.thinkingLevel, "max");
  assertEquals(state.followUpQueue, [{ text: "Next" }]);
  assertEquals(totalSessionUsage(state).totalTokens, 15);
  assertEquals(state.contextUsage, undefined);
});

test("environment stopping never settles or discards a running agent partial", () => {
  const before = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([], { "pi.live": { generation: { message: assistant } } }),
  });
  const after = reduceSessionTranscriptState(before, {
    type: "session.state",
    stage: "stopping",
    agentState: "running",
    environmentState: "stopping",
    environmentReachable: true,
    checkoutState: "available",
    issues: [],
  });
  assertEquals(after.entries, before.entries);
  assertEquals(after.status, "Agent running · Environment stopping");
});

test("optimistic prompt survives replacement and only a newly observed matching entry reconciles it", () => {
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
  assertEquals(
    state.entries.some((entry) => "delivery" in entry),
    false,
  );
});

test("tool projection retains arguments and suppresses read output without rewriting replicated state", () => {
  const mounted = view(
    [
      {
        id: 1,
        conversationId: 0,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "read",
                arguments: { path: "/workspace/a" },
              },
            ],
          },
        ],
      },
    ],
    {
      "pi.live": {
        tools: [{ callId: "call-1", name: "read", status: "running", output: "file contents" }],
      },
    },
  );
  const state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: mounted,
  });
  assertEquals(state.entries, [
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read",
      arguments: '{"path":"/workspace/a"}',
      active: true,
    },
  ]);
  assertEquals(state.view, mounted);
});

test("read images use artifact Markdown while text output stays hidden", () => {
  const artifactId = "01989d78-65ee-8f6a-a97e-0f16ad134c10";
  const state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([
      {
        id: 1,
        conversationId: 0,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "read-image",
            toolName: "read",
            content: [
              { type: "text", text: "hidden file output" },
              { type: "image", artifactId },
              { type: "image", text: "[Image unavailable: unsupported format]" },
            ],
          },
        ],
      },
    ]),
  });
  assertEquals(state.entries, [
    {
      role: "tool",
      toolCallId: "read-image",
      toolName: "read",
      active: false,
      isError: false,
      result: `\n\n![Image](openorb-artifact:image:${artifactId})\n\n[Image unavailable: unsupported format]`,
    },
  ]);
});

test("read errors retain diagnostic text", () => {
  const state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([
      {
        id: 1,
        conversationId: 0,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "failed-read",
            toolName: "read",
            isError: true,
            content: [{ type: "text", text: "Guest file could not be read." }],
          },
        ],
      },
    ]),
  });
  assertEquals(state.entries, [
    {
      role: "tool",
      toolCallId: "failed-read",
      toolName: "read",
      active: false,
      isError: true,
      result: "Guest file could not be read.",
    },
  ]);
});

test("setup entries show their output to viewers, not the message written for the agent", () => {
  const state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view([
      {
        id: 1,
        conversationId: 0,
        kind: "openorb.setup",
        data: { step: "setup", exitCode: 2, output: "npm ERR! missing script" },
        model: [{ role: "user", content: "[OpenOrb] .agents/setup failed", timestamp: 1 }],
      },
      user(2, "Fix the build"),
    ]),
  });
  assertEquals(state.entries, [
    { role: "setup", id: 1, step: "setup", exitCode: 2, output: "npm ERR! missing script" },
    { role: "user", messageId: "2:0", text: "Fix the build" },
  ]);
});

test("messages from other threads show their sender and text, not the label the model reads", () => {
  const parent = "0b9e3f2c-5d41-4c7a-9a3e-2f6d8c1b7e40";
  const state = reduceSessionTranscriptState(initial(), {
    type: "conversation.snapshot",
    view: view(
      [
        {
          id: 1,
          conversationId: 0,
          kind: "openorb.thread-message",
          data: { relation: "parent", sessionId: parent, title: "Instagram photo downloads" },
          model: [
            {
              role: "user",
              content: `Message from parent thread ${parent}:\n\nMessage from the user: keep this line`,
              timestamp: 1,
            },
          ],
        },
        {
          id: 2,
          conversationId: 0,
          kind: "openorb.thread-message",
          data: { relation: "sibling", sessionId: parent },
          model: [{ role: "user", content: "Unrecognised sender", timestamp: 1 }],
        },
      ],
      {
        "pi.inbox": {
          items: [
            { id: 3, mode: "followUp", content: "Next from the user" },
            {
              id: 4,
              mode: "followUp",
              content: `Message from parent thread ${parent}:\n\nQueued while busy`,
              entry: {
                kind: "openorb.thread-message",
                data: { relation: "parent", sessionId: parent, title: "Instagram photo downloads" },
              },
            },
          ],
        },
      },
    ),
  });
  assertEquals(state.entries, [
    {
      role: "thread",
      messageId: "1:0",
      relation: "parent",
      sessionId: parent,
      title: "Instagram photo downloads",
      text: "Message from the user: keep this line",
    },
    { role: "user", messageId: "2:0", text: "Unrecognised sender" },
  ]);
  // A message queued while this thread is busy is not shown as the user's follow-up.
  assertEquals(state.followUpQueue, [
    { text: "Next from the user" },
    {
      text: "Queued while busy",
      sender: { relation: "parent", sessionId: parent, title: "Instagram photo downloads" },
    },
  ]);
});
