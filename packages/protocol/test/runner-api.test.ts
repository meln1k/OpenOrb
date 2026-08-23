import { assertEquals, assertThrows } from "@std/assert";
import { Effect, Schema, type Scope, Stream } from "effect";
import * as RpcTest from "effect/unstable/rpc/RpcTest";

import {
  type AbortRejected,
  AbortSessionAccepted,
  AbortSessionPayload,
  type CapacityExceeded,
  ClientRequestId,
  type HistoryReadError,
  ProjectId,
  type PromptRejected,
  PromptSessionAccepted,
  PromptSessionPayload,
  type ProvisionRejected,
  ProvisionSessionPayload,
  ProvisionSessionSuccess,
  RunId,
  RunnerApi,
  RunnerCapacity,
  RunnerId,
  RunnerIdentity,
  type RunnerIdentityError,
  RunnerSessionSnapshot,
  type RunnerWatchError,
  type SessionConflict,
  type SessionCorrupt,
  SessionId,
  SessionModelRuntime,
  type SessionNotFound,
  WatchSessionEvent,
  WatchSessionPayload,
} from "@/src/runner-api.ts";

type RunnerApiError =
  | AbortRejected
  | CapacityExceeded
  | HistoryReadError
  | PromptRejected
  | ProvisionRejected
  | RunnerIdentityError
  | RunnerWatchError
  | SessionConflict
  | SessionCorrupt
  | SessionNotFound;

const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134c09");
const PROJECT_ID = ProjectId.make("01989d78-65ee-7f6a-a97e-0f16ad134c10");
const RUNNER_ID = RunnerId.make("01989d78-65ee-7f6a-a97e-0f16ad134c11");
const RUN_ID = RunId.make("run-1");
const CLIENT_REQUEST_ID = ClientRequestId.make("prompt-request-1");
const RUNNER_TOKEN = `openorb_runner_${"a".repeat(43)}`;

Deno.test("RunnerApi schemas bound identity and stable domain identifiers", () => {
  assertEquals(
    Schema.decodeUnknownSync(RunnerIdentity)({
      token: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      runnerVersion: "0.0.0",
      protocolVersion: 2,
      capabilities: ["effect-rpc", "session-watch"],
    }).runnerId,
    RUNNER_ID,
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(RunnerIdentity)({
      token: "not-a-runner-token",
      runnerId: RUNNER_ID,
      runnerVersion: "0.0.0",
      protocolVersion: 2,
      capabilities: ["effect-rpc"],
    })
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(RunnerIdentity)({
      token: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      runnerVersion: "0.0.0",
      protocolVersion: 2,
      capabilities: ["effect-rpc", "effect-rpc"],
    })
  );

  const provision = Schema.decodeUnknownSync(ProvisionSessionPayload)({
    mode: "create",
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://github.com/openorb/example.git",
    ref: "main",
    branchName: "openorb/session",
    orbSize: "medium",
    initialPrompt: "Implement the change.",
    modelRuntime: modelRuntime(),
  });
  assertEquals(provision.sessionId, SESSION_ID);
  assertThrows(() =>
    Schema.decodeUnknownSync(ProvisionSessionPayload)({
      ...provision,
      repositoryUrl: "https://example.com/openorb/example.git",
    })
  );

  assertEquals(
    Schema.decodeUnknownSync(PromptSessionPayload)({
      sessionId: SESSION_ID,
      clientRequestId: CLIENT_REQUEST_ID,
      prompt: "Continue.",
      modelRuntime: modelRuntime(),
    }).clientRequestId,
    CLIENT_REQUEST_ID,
  );
  assertEquals(
    Schema.decodeUnknownSync(AbortSessionPayload)({
      sessionId: SESSION_ID,
      runId: RUN_ID,
    }).runId,
    RUN_ID,
  );
});

Deno.test("WatchSession events always state their run attribution", () => {
  assertEquals(
    Schema.decodeUnknownSync(WatchSessionEvent)({
      runId: null,
      cursor: 1,
      event: { type: "user.message", messageId: "message-1", text: "Hello" },
    }).runId,
    null,
  );
  assertEquals(
    Schema.decodeUnknownSync(WatchSessionEvent)({
      runId: RUN_ID,
      event: { type: "assistant.text.delta", delta: "Hi" },
    }).runId,
    RUN_ID,
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(WatchSessionEvent)({
      cursor: 1,
      event: { type: "user.message", messageId: "message-1", text: "Hello" },
    })
  );
});

Deno.test("RunnerApi exposes all unary and streaming procedures through RpcTest", async () => {
  const identity = new RunnerIdentity({
    token: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    runnerVersion: "0.0.0",
    protocolVersion: 2,
    capabilities: ["effect-rpc"],
  });
  const session = sessionSnapshot();
  const capacity = runnerCapacity();
  const handlers = RunnerApi.toLayer({
    "runner.identify": () => Effect.succeed(identity),
    "runner.watch": () =>
      Stream.make({
        type: "snapshot.complete" as const,
        revision: 1,
        sessionCount: 1,
        observedAt: 1,
        capacity,
      }),
    "session.provision": ({ sessionId }) =>
      Effect.succeed(
        new ProvisionSessionSuccess({
          session: new RunnerSessionSnapshot({ ...session, id: sessionId }),
          ref: "main",
          branchName: "openorb/session",
          checkoutState: "pending",
        }),
      ),
    "session.prompt": ({ clientRequestId }) =>
      Effect.succeed(
        new PromptSessionAccepted({
          clientRequestId,
          runId: RUN_ID,
          mode: "started",
        }),
      ),
    "session.abort": ({ runId }) => Effect.succeed(new AbortSessionAccepted({ runId })),
    "session.watch": () =>
      Stream.make({
        runId: null,
        cursor: 1,
        event: { type: "user.message" as const, messageId: "message-1", text: "Hello" },
      }),
  });
  const promptPayload = new PromptSessionPayload({
    sessionId: SESSION_ID,
    clientRequestId: CLIENT_REQUEST_ID,
    prompt: "Continue.",
    modelRuntime: new SessionModelRuntime(modelRuntime()),
  });
  const abortPayload = new AbortSessionPayload({ sessionId: SESSION_ID, runId: RUN_ID });
  const watchPayload = new WatchSessionPayload({ sessionId: SESSION_ID, afterCursor: 0 });

  await Effect.runPromise(Effect.scoped(Effect.gen(function* (): Effect.fn.Return<
    void,
    RunnerApiError,
    Scope.Scope
  > {
    const client = yield* RpcTest.makeClient(RunnerApi).pipe(Effect.provide(handlers));
    assertEquals((yield* client["runner.identify"]()).runnerId, RUNNER_ID);
    assertEquals(
      Array.from(yield* client["runner.watch"]().pipe(Stream.runCollect))[0]?.type,
      "snapshot.complete",
    );
    assertEquals(
      (yield* client["session.provision"]({
        mode: "retry",
        sessionId: SESSION_ID,
        modelRuntime: modelRuntime(),
      })).session.id,
      SESSION_ID,
    );
    assertEquals(
      (yield* client["session.prompt"](promptPayload)).runId,
      RUN_ID,
    );
    assertEquals(
      (yield* client["session.abort"](abortPayload)).runId,
      RUN_ID,
    );
    assertEquals(
      Array.from(
        yield* client["session.watch"](watchPayload).pipe(Stream.runCollect),
      )[0]?.runId,
      null,
    );
  })));
});

function modelRuntime() {
  return {
    model: "opencode-go/deepseek-v4-flash",
    thinkingLevel: "high" as const,
    credential: { type: "api_key" as const, value: "provider-secret" },
  };
}

function runnerCapacity(): RunnerCapacity {
  return new RunnerCapacity({
    maxConcurrentSessions: 2,
    activeSessions: 1,
    vmCpuCount: 4,
    vmMemoryMiB: 8_192,
    diskFreeMiB: 100_000,
  });
}

function sessionSnapshot(): RunnerSessionSnapshot {
  return new RunnerSessionSnapshot({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    createdAt: "2026-08-23T12:00:00Z",
    initialPromptPreview: "Implement the change.",
    model: "opencode-go/deepseek-v4-flash",
    orbSize: "medium",
    state: "ready",
    lastEventCursor: 0,
  });
}
