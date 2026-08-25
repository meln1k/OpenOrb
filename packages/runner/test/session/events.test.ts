import { assertEquals } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import {
  ProjectId,
  RunId,
  type SessionId,
  SessionId as SessionIdSchema,
} from "@openorb/protocol/runner-api";
import { Effect, Fiber, Schema, Stream } from "effect";

import { makeSessionEvents, type SessionEvents } from "@/src/session/events.ts";
import { makeRunnerSessionStore, RunnerSessionStore } from "@/src/session/store.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = Schema.decodeUnknownSync(SessionIdSchema)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)("01989d78-65ee-7f6a-a97e-0f16ad134c11");
const SESSION_LIVE_TAIL_CAPACITY = 512;

Deno.test("WatchSession emits the current lifecycle state after a runner restart", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await withSession(workingDirectory, SESSION_ID, async ({ events, store }) => {
      await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
        state: "ready",
        checkoutState: "available",
      }));

      const replay = await Effect.runPromise(
        events.watch(SESSION_ID, 0).pipe(Stream.take(2), Stream.runCollect),
      );

      assertEquals(Array.from(replay), [
        { runId: null, event: { type: "conversation.reset" } },
        {
          runId: null,
          conversationCursor: 0,
          event: {
            type: "session.state",
            stage: "ready",
            checkoutState: "available",
          },
        },
      ]);
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("WatchSession retains the latest lifecycle state across watch reconnects", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await withSession(workingDirectory, SESSION_ID, async ({ events }) => {
      const runId = Schema.decodeUnknownSync(RunId)("01989d78-65ee-7f6a-a97e-0f16ad134c12");
      await Effect.runPromise(events.publishLive(SESSION_ID, runId, {
        type: "session.state",
        stage: "running",
        checkoutState: "available",
      }));

      const replay = await Effect.runPromise(
        events.watch(SESSION_ID, 0).pipe(Stream.take(2), Stream.runCollect),
      );

      assertEquals(Array.from(replay), [
        { runId: null, event: { type: "conversation.reset" } },
        {
          runId,
          conversationCursor: 0,
          event: {
            type: "session.state",
            stage: "running",
            checkoutState: "available",
          },
        },
      ]);
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("WatchSession replays JSONL once and directly tails durable Pi appends", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await withSession(workingDirectory, SESSION_ID, async ({ events, pi, sessionFile }) => {
      const firstMessageId = pi.appendMessage({
        role: "user",
        content: "Inspect the repository",
        timestamp: 1,
      });

      const initial = await Effect.runPromise(
        events.watch(SESSION_ID, 0).pipe(Stream.take(2), Stream.runCollect),
      );
      assertEquals(Array.from(initial), [
        { runId: null, event: { type: "conversation.reset" } },
        {
          runId: null,
          cursor: 1,
          event: {
            type: "user.message",
            messageId: firstMessageId,
            text: "Inspect the repository",
          },
        },
      ]);

      const replayed = Promise.withResolvers<void>();
      const waiting = Effect.runFork(
        events.watch(SESSION_ID, 0).pipe(
          Stream.tap((item) =>
            "cursor" in item && item.cursor === 1
              ? Effect.sync(() => replayed.resolve())
              : Effect.void
          ),
          Stream.filter((item) => "cursor" in item && item.cursor === 2),
          Stream.take(1),
          Stream.runCollect,
        ),
      );
      await replayed.promise;
      const secondMessageId = pi.appendMessage({
        role: "user",
        content: "Now inspect the tests",
        timestamp: 2,
      });
      await Deno.rename(sessionFile, `${sessionFile}.hidden`);
      await Effect.runPromise(events.publishConversation(SESSION_ID, {
        type: "user.message",
        messageId: secondMessageId,
        text: "Now inspect the tests",
      }));
      assertEquals(Array.from(await Effect.runPromise(Fiber.join(waiting))), [{
        runId: null,
        cursor: 2,
        event: {
          type: "user.message",
          messageId: secondMessageId,
          text: "Now inspect the tests",
        },
      }]);
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("WatchSession resets a cursor ahead of durable history", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await withSession(workingDirectory, SESSION_ID, async ({ events, pi }) => {
      const messageId = pi.appendMessage({
        role: "user",
        content: "Inspect the repository",
        timestamp: 1,
      });
      const replay = await Effect.runPromise(
        events.watch(SESSION_ID, 99).pipe(Stream.take(2), Stream.runCollect),
      );
      assertEquals(Array.from(replay), [
        { runId: null, event: { type: "conversation.reset" } },
        {
          runId: null,
          cursor: 1,
          event: {
            type: "user.message",
            messageId,
            text: "Inspect the repository",
          },
        },
      ]);
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("live tail pressure drops after 512 items but still admits durable events", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await withSession(workingDirectory, SESSION_ID, async ({ events, pi }) => {
      const firstMessageId = pi.appendMessage({
        role: "user",
        content: "Inspect the repository",
        timestamp: 1,
      });
      const replayed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const watching = Effect.runFork(
        events.watch(SESSION_ID, 0).pipe(
          Stream.tap((item) =>
            "cursor" in item && item.cursor === 1
              ? Effect.promise(() => {
                replayed.resolve();
                return release.promise;
              })
              : Effect.void
          ),
          Stream.takeUntil((item) => "cursor" in item && item.cursor === 2),
          Stream.runCollect,
        ),
      );
      await replayed.promise;

      for (let index = 0; index < SESSION_LIVE_TAIL_CAPACITY + 1; index++) {
        await Effect.runPromise(events.publishLive(
          SESSION_ID,
          "01989d78-65ee-7f6a-a97e-0f16ad134c12",
          { type: "agent.started" },
        ));
      }
      const secondMessageId = pi.appendMessage({
        role: "user",
        content: "Now inspect the tests",
        timestamp: 2,
      });
      await Effect.runPromise(events.publishConversation(SESSION_ID, {
        type: "user.message",
        messageId: secondMessageId,
        text: "Now inspect the tests",
      }));
      release.resolve();

      const received = Array.from(await Effect.runPromise(Fiber.join(watching)));
      const durable = received.filter((item) => "cursor" in item);
      assertEquals(
        received.filter((item) => item.event.type === "agent.started").length,
        SESSION_LIVE_TAIL_CAPACITY,
      );
      assertEquals(durable, [
        {
          runId: null,
          cursor: 1,
          event: {
            type: "user.message",
            messageId: firstMessageId,
            text: "Inspect the repository",
          },
        },
        {
          runId: null,
          cursor: 2,
          event: {
            type: "user.message",
            messageId: secondMessageId,
            text: "Now inspect the tests",
          },
        },
      ]);
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

async function withSession(
  workingDirectory: string,
  sessionId: SessionId,
  use: (
    session: {
      events: SessionEvents;
      pi: SessionManager;
      sessionFile: string;
      store: RunnerSessionStore;
    },
  ) => Promise<void>,
) {
  const store = await Effect.runPromise(
    makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
      Effect.provide(DenoFileSystem.layer),
    ),
  );
  await Effect.runPromise(store.createSession({
    id: sessionId,
    projectId: PROJECT_ID,
    repositoryUrl: "https://github.com/meln1k/openorb.git",
    ref: "main",
    branchName: "openorb/session-events-test",
    initialPrompt: "Inspect the repository",
    model: "opencode-go/deepseek-v4-flash",
    orbSize: "small",
    createdAt: "2026-08-23T12:00:00Z",
  }));
  const paths = await Effect.runPromise(store.getSessionPiPaths(sessionId));
  const pi = SessionManager.open(paths.sessionFile, undefined, "/workspace");
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        makeSessionEvents().pipe(Effect.provideService(RunnerSessionStore, store)),
        (events) =>
          Effect.promise(() => use({ events, pi, sessionFile: paths.sessionFile, store })),
      ),
    ),
  );
}
