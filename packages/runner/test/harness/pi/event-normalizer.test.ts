import { assert, assertEquals } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import {
  makePiEventNormalizer,
  sessionUsage,
  stringify,
  truncateUtf8,
} from "@/src/harness/pi/event-normalizer.ts";
import { eventsFromPiEntries } from "@/src/harness/pi/history.ts";
import type { EphemeralSessionEvent } from "@openorb/protocol/runner-api";

Deno.test("message completion remains a live ephemeral event", async () => {
  const live: EphemeralSessionEvent[] = [];
  const normalize = makePiEventNormalizer({
    publishLive: (event) => Effect.sync(() => live.push(event)).pipe(Effect.asVoid),
  });
  await Effect.runPromise(normalize({
    type: "message_end",
    message: {
      role: "user",
      content: [{ type: "text", text: "Inspect" }],
      timestamp: 1,
    },
  }));
  assertEquals(live, [{ type: "message.completed", role: "user" }]);
});

Deno.test("Pi internal system messages and context edits stay outside the conversation", async () => {
  const live: EphemeralSessionEvent[] = [];
  const normalize = makePiEventNormalizer({
    publishLive: (event) => Effect.sync(() => live.push(event)).pipe(Effect.asVoid),
  });
  const session = SessionManager.inMemory("/workspace");
  const system = { role: "system" as const, content: "Trusted instructions", timestamp: 1 };
  session.appendMessage(system);
  const userId = session.appendMessage({ role: "user", content: "Original prompt", timestamp: 2 });
  session.appendContextEdit(userId, { content: "Provider-only replacement" });
  session.appendUsage("cache_warming", "opencode-go", "deepseek-v4-flash", {
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  await Effect.runPromise(normalize({ type: "message_start", message: system }));
  await Effect.runPromise(normalize({ type: "message_end", message: system }));
  for (const entry of session.getBranch()) {
    await Effect.runPromise(normalize({ type: "entry_appended", entry }));
  }

  assertEquals(
    live,
    session.getBranch().filter((entry) => entry.type === "message").map((entry) => ({
      type: "session.entry.appended",
      entryId: entry.id,
      entryType: "message",
    })),
  );
  assertEquals(eventsFromPiEntries(session.getBranch()), [{
    type: "user.message",
    messageId: userId,
    text: "Original prompt",
  }]);
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
