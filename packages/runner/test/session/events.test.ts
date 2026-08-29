import { assertEquals } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import {
  GitAuthor,
  ProjectId,
  RunId,
  type SessionId,
  SessionId as SessionIdSchema,
  UserId,
} from "@openorb/protocol/runner-api";
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";

import { makeSessionEvents, type SessionEvents } from "@/src/session/events.ts";
import { eventsFromPiEntries, readPiSessionEvents } from "@/src/harness/pi/history.ts";
import { AgentHarnessError } from "@/src/harness/agent-harness.ts";
import {
  createOpenOrbPiSession,
  observeSessionManagerPersistence,
} from "@/src/harness/pi/session.ts";
import { RunnerSessionDefinition } from "@/src/session/definition.ts";
import { makeRunnerSessionStore, RunnerSessionStore } from "@/src/session/store.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = Schema.decodeUnknownSync(SessionIdSchema)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)("01989d78-65ee-7f6a-a97e-0f16ad134c11");
const USER_ID = Schema.decodeUnknownSync(UserId)("01989d78-65ee-7f6a-a97e-0f16ad134c12");
const GIT_AUTHOR = new GitAuthor({ name: "OpenOrb User", email: "user@example.com" });
const SESSION_LIVE_TAIL_CAPACITY = 512;
const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "test-model-provider-key" },
};

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
          event: {
            type: "session.state",
            stage: "ready",
            checkoutState: "available",
          },
        },
      ]);
    }, { active: false });
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

Deno.test("active conversation reads use the cache and coalesced updates preserve every cursor", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    let historyReads = 0;
    await withSession(workingDirectory, SESSION_ID, async ({ events, pi }) => {
      const firstMessageId = pi.appendMessage({
        role: "user",
        content: "Inspect the repository",
        timestamp: 1,
      });
      const replayed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const waiting = Effect.runFork(
        events.watch(SESSION_ID, 0).pipe(
          Stream.filter((item) => "cursor" in item),
          Stream.tap((item) =>
            item.cursor === 1
              ? Effect.promise(() => {
                replayed.resolve();
                return release.promise;
              })
              : Effect.void
          ),
          Stream.take(3),
          Stream.runCollect,
        ),
      );
      await replayed.promise;
      const secondMessageId = pi.appendMessage({
        role: "user",
        content: "Now inspect the tests",
        timestamp: 2,
      });
      const thirdMessageId = pi.appendMessage({
        role: "user",
        content: "Then inspect the documentation",
        timestamp: 3,
      });
      release.resolve();

      assertEquals(Array.from(await Effect.runPromise(Fiber.join(waiting))), [
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
        {
          runId: null,
          cursor: 3,
          event: {
            type: "user.message",
            messageId: thirdMessageId,
            text: "Then inspect the documentation",
          },
        },
      ]);
      assertEquals(historyReads, 0);
    }, {
      eventOptions: {
        readHistory: () =>
          Effect.sync(() => {
            historyReads++;
            return [];
          }),
      },
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("cold conversation reads project directly from Pi JSONL", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    let historyReads = 0;
    await withSession(workingDirectory, SESSION_ID, async ({ events, pi }) => {
      const messageId = pi.appendMessage({ role: "user", content: "Cold history", timestamp: 1 });
      const replay = await Effect.runPromise(
        events.watch(SESSION_ID, 0).pipe(
          Stream.filter((item) => "cursor" in item),
          Stream.take(1),
          Stream.runCollect,
        ),
      );
      assertEquals(Array.from(replay), [{
        runId: null,
        cursor: 1,
        event: { type: "user.message", messageId, text: "Cold history" },
      }]);
      assertEquals(historyReads, 1);
    }, {
      active: false,
      eventOptions: {
        readHistory: (_sessionId, sessionFile) =>
          Effect.promise(() => {
            historyReads++;
            return readPiSessionEvents(sessionFile);
          }),
      },
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("disposing an active cache restores JSONL-backed reads", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    let historyReads = 0;
    await withSession(
      workingDirectory,
      SESSION_ID,
      async ({ events, pi, disposeCache }) => {
        pi.appendMessage({ role: "user", content: "Cached", timestamp: 1 });
        disposeCache();
        const messageId = pi.appendMessage({
          role: "user",
          content: "After disposal",
          timestamp: 2,
        });
        const replay = await Effect.runPromise(
          events.watch(SESSION_ID, 1).pipe(
            Stream.filter((item) => "cursor" in item),
            Stream.take(1),
            Stream.runCollect,
          ),
        );
        assertEquals(Array.from(replay), [{
          runId: null,
          cursor: 2,
          event: { type: "user.message", messageId, text: "After disposal" },
        }]);
        assertEquals(historyReads, 1);
      },
      {
        eventOptions: {
          readHistory: (_sessionId, sessionFile) =>
            Effect.promise(() => {
              historyReads++;
              return readPiSessionEvents(sessionFile);
            }),
        },
      },
    );
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("failed Pi creation disposes its active cache before the worker scope closes", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    let historyReads = 0;
    await withSession(
      workingDirectory,
      SESSION_ID,
      async ({ events, pi, sessionFile, scope }) => {
        const failed = await Effect.runPromiseExit(
          createOpenOrbPiSession({
            sessionId: SESSION_ID,
            runnerSessionFile: sessionFile,
            runnerAgentDirectory: `${workingDirectory}/pi-agent`,
            repositoryUrl: "https://github.com/meln1k/openorb.git",
            branchName: "openorb/session-events-test",
            modelRuntime: MODEL_RUNTIME,
            tools: [],
            conversationProjection: {
              activate: (sessionId, initial) =>
                events.activateConversation(sessionId, initial).pipe(
                  Effect.mapError((cause) =>
                    new AgentHarnessError("Could not activate the conversation cache.", cause)
                  ),
                ),
            },
          }, {
            createAgentSession: () => Promise.reject(new Error("Pi creation failed")),
          }).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        assertEquals(failed._tag, "Failure");

        const messageId = pi.appendMessage({
          role: "user",
          content: "Read from JSONL after rollback",
          timestamp: 1,
        });
        const replay = await Effect.runPromise(
          events.watch(SESSION_ID, 0).pipe(
            Stream.filter((item) => "cursor" in item),
            Stream.take(1),
            Stream.runCollect,
          ),
        );
        assertEquals(Array.from(replay), [{
          runId: null,
          cursor: 1,
          event: {
            type: "user.message",
            messageId,
            text: "Read from JSONL after rollback",
          },
        }]);
        assertEquals(historyReads, 1);
      },
      {
        active: false,
        eventOptions: {
          readHistory: (_sessionId, sessionFile) =>
            Effect.promise(() => {
              historyReads++;
              return readPiSessionEvents(sessionFile);
            }),
        },
      },
    );
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

Deno.test("coalesced conversation notifications deliver every missing JSONL event", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await withSession(workingDirectory, SESSION_ID, async ({ events, pi }) => {
      pi.appendMessage({ role: "user", content: "message-1", timestamp: 1 });
      const replayed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const watching = Effect.runFork(
        events.watch(SESSION_ID, 0).pipe(
          Stream.filter((item) => "cursor" in item),
          Stream.tap((item) =>
            item.cursor === 1
              ? Effect.promise(() => {
                replayed.resolve();
                return release.promise;
              })
              : Effect.void
          ),
          Stream.take(10),
          Stream.runCollect,
        ),
      );
      await replayed.promise;
      for (let cursor = 2; cursor <= 10; cursor++) {
        pi.appendMessage({ role: "user", content: `message-${cursor}`, timestamp: cursor });
      }
      release.resolve();

      assertEquals(
        Array.from(await Effect.runPromise(Fiber.join(watching)), (item) => item.cursor),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      );
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("live pressure is bounded independently from durable JSONL catch-up", async () => {
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
      let sawDurable = false;
      let sawLiveSentinel = false;
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
          Stream.takeUntil((item) => {
            if ("cursor" in item && item.cursor === 2) sawDurable = true;
            if (
              item.event.type === "assistant.text.delta" && item.event.delta === "pressure-512"
            ) sawLiveSentinel = true;
            return sawDurable && sawLiveSentinel;
          }),
          Stream.runCollect,
        ),
      );
      await replayed.promise;

      for (let index = 0; index < SESSION_LIVE_TAIL_CAPACITY + 1; index++) {
        await Effect.runPromise(events.publishLive(
          SESSION_ID,
          "01989d78-65ee-7f6a-a97e-0f16ad134c12",
          { type: "assistant.text.delta", delta: `pressure-${index}` },
        ));
      }
      const secondMessageId = pi.appendMessage({
        role: "user",
        content: "Now inspect the tests",
        timestamp: 2,
      });
      release.resolve();

      const received = Array.from(await Effect.runPromise(Fiber.join(watching)));
      const durable = received.filter((item) => "cursor" in item);
      assertEquals(
        received.filter((item) => item.event.type === "assistant.text.delta").length,
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
      scope: Scope.Scope;
      disposeCache: () => void;
    },
  ) => Promise<void>,
  options: {
    active?: boolean;
    eventOptions?: Parameters<typeof makeSessionEvents>[0];
  } = {},
) {
  const store = await Effect.runPromise(
    makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
      Effect.provide(DenoFileSystem.layer),
    ),
  );
  await Effect.runPromise(store.ensureSession(
    sessionId,
    new RunnerSessionDefinition({
      userId: USER_ID,
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/meln1k/openorb.git",
      ref: "main",
      branchName: "openorb/session-events-test",
      gitAuthor: GIT_AUTHOR,
      initialPrompt: "Inspect the repository",
      model: "opencode-go/deepseek-v4-flash",
      orbSize: "small",
    }),
    "2026-08-23T12:00:00Z",
  ));
  const paths = await Effect.runPromise(store.getSessionPiPaths(sessionId));
  const pi = SessionManager.open(paths.sessionFile, undefined, "/workspace");
  const scope = await Effect.runPromise(Scope.make());
  try {
    const events = await Effect.runPromise(
      makeSessionEvents(options.eventOptions).pipe(
        Effect.provideService(RunnerSessionStore, store),
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    let disposeCache = () => {};
    if (options.active !== false) {
      const activeConversation = await Effect.runPromise(
        events.activateConversation(sessionId, eventsFromPiEntries(pi.getBranch())).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      disposeCache = activeConversation.dispose;
      observeSessionManagerPersistence(
        pi,
        () => activeConversation.update(eventsFromPiEntries(pi.getBranch())),
      );
    }
    await use({ events, pi, sessionFile: paths.sessionFile, store, scope, disposeCache });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}
