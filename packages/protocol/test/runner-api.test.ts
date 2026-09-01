import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseSafe } from "@remix-run/data-schema";
import { Effect, Schema, type Scope, Stream } from "effect";
import * as RpcTest from "effect/unstable/rpc/RpcTest";

import { sessionGitSnapshotSchema } from "@/src/browser-session-git-snapshot.ts";
import {
  type AbortRejected,
  AbortSessionAccepted,
  AbortSessionPayload,
  type CapacityExceeded,
  ClientRequestId,
  type DeleteFailed,
  type DeleteRejected,
  DeleteSessionAccepted,
  DeleteSessionPayload,
  DurableSessionEvent,
  EphemeralSessionEvent,
  GitFileUpdateAccepted,
  type GitFileUpdateRejected,
  type GitSnapshotReadError,
  type HistoryReadError,
  ProjectId,
  type PromptRejected,
  PromptSessionAccepted,
  PromptSessionPayload,
  type ProvisionRejected,
  ProvisionSessionPayload,
  ProvisionSessionSuccess,
  ReadSessionGitSnapshotPayload,
  RunId,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  RunnerCapacity,
  RunnerId,
  RunnerIdentity,
  type RunnerIdentityError,
  RunnerSessionSnapshot,
  type RunnerWatchError,
  type SessionConflict,
  type SessionCorrupt,
  SessionEvent,
  SessionGitSnapshot,
  SessionId,
  SessionModelRuntime,
  type SessionNotFound,
  type StopRejected,
  StopSessionAccepted,
  StopSessionPayload,
  UpdateSessionGitFilePayload,
  UserId,
  type WakeRejected,
  WakeSessionAccepted,
  WakeSessionPayload,
  WatchSessionEvent,
  WatchSessionPayload,
} from "@/src/runner-api.ts";
import {
  MAX_RUNNER_RPC_FRAME_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
} from "@/src/runner-api-limits.ts";

type RunnerApiError =
  | AbortRejected
  | CapacityExceeded
  | DeleteFailed
  | DeleteRejected
  | GitFileUpdateRejected
  | GitSnapshotReadError
  | HistoryReadError
  | PromptRejected
  | ProvisionRejected
  | RunnerIdentityError
  | RunnerWatchError
  | SessionConflict
  | SessionCorrupt
  | SessionNotFound
  | StopRejected
  | WakeRejected;

const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134c09");
const USER_ID = UserId.make("01989d78-65ee-7f6a-a97e-0f16ad134c12");
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
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    }).runnerId,
    RUNNER_ID,
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(RunnerIdentity)({
      token: "not-a-runner-token",
      runnerId: RUNNER_ID,
      runnerVersion: "0.0.0",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    })
  );

  const provision = Schema.decodeUnknownSync(ProvisionSessionPayload)({
    mode: "create",
    sessionId: SESSION_ID,
    userId: USER_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://github.com/openorb/example.git",
    ref: "main",
    branchName: "openorb/session",
    gitAuthor: { name: "OpenOrb User", email: "user@example.com" },
    orbSize: "medium",
    initialPrompt: "Implement the change.",
    modelRuntime: modelRuntime(),
  });
  assertEquals(provision.sessionId, SESSION_ID);
  assertEquals(provision.mode, "create");
  if (provision.mode !== "create") throw new Error("Expected a create payload.");
  assertEquals(provision.userId, USER_ID);
  assertThrows(() =>
    Schema.decodeUnknownSync(ProvisionSessionPayload)({
      ...provision,
      repositoryUrl: "https://example.com/openorb/example.git",
    })
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(ProvisionSessionPayload)({
      ...provision,
      gitAuthor: { name: "OpenOrb User", email: "not-an-email" },
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
    Schema.decodeUnknownSync(WakeSessionPayload)({
      sessionId: SESSION_ID,
      modelRuntime: modelRuntime(),
      githubToken: "github-token",
    }).githubToken,
    "github-token",
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
  const snapshotUpdated = Schema.decodeUnknownSync(WatchSessionEvent)({
    runId: RUN_ID,
    event: { type: "git.snapshot.updated" },
  });
  assertEquals(snapshotUpdated.event.type, "git.snapshot.updated");
  assertEquals(
    Schema.decodeUnknownSync(EphemeralSessionEvent)(snapshotUpdated.event).type,
    "git.snapshot.updated",
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(WatchSessionEvent)({
      cursor: 1,
      event: { type: "user.message", messageId: "message-1", text: "Hello" },
    })
  );
});

Deno.test("one SessionEvent schema validates durable and ephemeral wire payloads", () => {
  const durable = {
    type: "user.message" as const,
    messageId: "message-1",
    text: "Hello",
  };
  const ephemeral = {
    type: "assistant.text.delta" as const,
    delta: "Hi",
  };

  assertEquals(Schema.decodeUnknownSync(SessionEvent)(durable), durable);
  assertEquals(Schema.decodeUnknownSync(SessionEvent)(ephemeral), ephemeral);
  assertEquals(Schema.decodeUnknownSync(DurableSessionEvent)(durable), durable);
  assertEquals(Schema.decodeUnknownSync(EphemeralSessionEvent)(ephemeral), ephemeral);
  assertThrows(() => Schema.decodeUnknownSync(DurableSessionEvent)(ephemeral));
  assertThrows(() => Schema.decodeUnknownSync(EphemeralSessionEvent)(durable));
});

Deno.test("SessionGitSnapshot rejects payloads that would exceed its JSON budgets", () => {
  const largeFiles = Array.from({ length: 1_000 }, (_, index) => {
    const path = `${index}-${"x".repeat(220)}`;
    return {
      kind: "tracked" as const,
      path,
      displayPath: path,
      status: "modified" as const,
      diffState: "available" as const,
    };
  });
  assertEquals(largeFiles.length, 1_000);
  assert(
    byteLength(JSON.stringify(largeFiles)) > MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES,
  );
  const oversizedFilesSnapshot = gitSnapshot({ unstagedFiles: largeFiles });
  assertThrows(() => Schema.decodeUnknownSync(SessionGitSnapshot)(oversizedFilesSnapshot));
  assertEquals(parseSafe(sessionGitSnapshotSchema, oversizedFilesSnapshot).success, false);

  const escapingPatch = "\u001b".repeat(40_000);
  assert(byteLength(escapingPatch) < MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES);
  assert(
    byteLength(JSON.stringify(escapingPatch)) >
      MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  );
  const oversizedPatchSnapshot = gitSnapshot({
    stagedPatch: escapingPatch,
  });
  assertThrows(() => Schema.decodeUnknownSync(SessionGitSnapshot)(oversizedPatchSnapshot));
  assertEquals(parseSafe(sessionGitSnapshotSchema, oversizedPatchSnapshot).success, false);

  const individuallyValidPatch = "\u001b".repeat(35_000);
  assert(
    byteLength(JSON.stringify(individuallyValidPatch)) <
      MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
  );
  assert(
    byteLength(JSON.stringify({
      staged: individuallyValidPatch,
      unstaged: individuallyValidPatch,
    })) > MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  );
  const oversizedCombinedPatches = gitSnapshot({
    stagedPatch: individuallyValidPatch,
    unstagedPatch: individuallyValidPatch,
  });
  assertThrows(() => Schema.decodeUnknownSync(SessionGitSnapshot)(oversizedCombinedPatches));
  assertEquals(parseSafe(sessionGitSnapshotSchema, oversizedCombinedPatches).success, false);
});

Deno.test("SessionGitSnapshot accepts only explicit section-owned file states", () => {
  const oldFlatSnapshot = {
    generatedAt: "2026-08-23T12:00:00Z",
    completeness: "complete",
    stale: false,
    truncated: false,
    summary: { changed: 1, staged: 1, unstaged: 0, untracked: 0 },
    files: [],
    patches: { staged: "", unstaged: "" },
  };
  const contradictoryTrackedFile = gitSnapshot({
    unstagedFiles: [{
      kind: "tracked",
      path: "src/main.ts",
      displayPath: "src/main.ts",
      status: "modified",
      staged: "modified",
      diffState: "available",
    }],
  });
  const invalidUntrackedFile = gitSnapshot({
    unstagedFiles: [{
      kind: "untracked",
      path: "new.txt",
      displayPath: "new.txt",
      status: "modified",
      diffState: "available",
    }],
  });
  const stagedUntrackedFile = gitSnapshot({
    stagedFiles: [{
      kind: "untracked",
      path: "new.txt",
      displayPath: "new.txt",
      status: "added",
      diffState: "available",
    }],
  });
  const incompleteRename = gitSnapshot({
    stagedFiles: [{
      kind: "tracked",
      path: "new.ts",
      displayPath: "new.ts",
      status: "renamed",
      diffState: "available",
    }],
  });

  for (
    const candidate of [
      oldFlatSnapshot,
      contradictoryTrackedFile,
      invalidUntrackedFile,
      stagedUntrackedFile,
      incompleteRename,
    ]
  ) {
    assertThrows(() => Schema.decodeUnknownSync(SessionGitSnapshot)(candidate));
    assertEquals(parseSafe(sessionGitSnapshotSchema, candidate).success, false);
  }
});

Deno.test("Git Snapshot paths preserve exact mutation operands separately from display text", () => {
  const path = "src/literal*\nname.ts";
  const displayPath = "src/literal*\\u{A}name.ts";
  const previousPath = "src/old?\nname.ts";
  const previousDisplayPath = "src/old?\\u{A}name.ts";
  const candidate = gitSnapshot({
    stagedFiles: [{
      kind: "tracked",
      path,
      displayPath,
      previousPath,
      previousDisplayPath,
      status: "renamed",
      diffState: "available",
    }],
  });

  const runnerSnapshot = Schema.decodeUnknownSync(SessionGitSnapshot)(candidate);
  assertEquals(runnerSnapshot.sections.staged.files[0]?.path, path);
  assertEquals(runnerSnapshot.sections.staged.files[0]?.displayPath, displayPath);
  const browserSnapshot = parseSafe(sessionGitSnapshotSchema, candidate);
  assert(browserSnapshot.success);
  assertEquals(browserSnapshot.value.sections.staged.files[0]?.path, path);
  assertEquals(browserSnapshot.value.sections.staged.files[0]?.displayPath, displayPath);
  assertEquals(
    Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
      sessionId: SESSION_ID,
      action: "stage",
      path,
      previousPath,
    }).path,
    path,
  );
});

Deno.test("valid SessionGitSnapshot payloads fit one runner RPC frame and parse in the browser", () => {
  const files: Array<{
    kind: "tracked";
    path: string;
    displayPath: string;
    status: "modified";
    diffState: "available";
  }> = [];
  for (let index = 0; index < 1_000; index++) {
    const path = `${index}-${"x".repeat(4_090 - String(index).length)}`;
    const file = {
      kind: "tracked" as const,
      path,
      displayPath: path,
      status: "modified" as const,
      diffState: "available" as const,
    };
    if (
      byteLength(JSON.stringify([...files, file])) > MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES
    ) break;
    files.push(file);
  }
  const largestFileBytes = Math.max(
    ...files.map((file) => byteLength(JSON.stringify(file)) + 1),
  );
  assert(
    byteLength(JSON.stringify(files)) >
      MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES - largestFileBytes,
  );

  const patchJsonBudget = Math.floor((MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES - 64) / 2);
  const patch = "\n".repeat(Math.floor((patchJsonBudget - 2) / 2));
  assertEquals(
    byteLength(JSON.stringify(patch)),
    patchJsonBudget,
  );
  const candidate = gitSnapshot({
    unstagedFiles: files,
    stagedPatch: patch,
    unstagedPatch: patch,
  });
  const snapshot = Schema.decodeUnknownSync(SessionGitSnapshot)(candidate);
  assert(parseSafe(sessionGitSnapshotSchema, candidate).success);
  assert(byteLength(JSON.stringify(snapshot)) < MAX_RUNNER_RPC_FRAME_BYTES);
});

Deno.test("RunnerApi exposes all unary and streaming procedures through RpcTest", async () => {
  const identity = new RunnerIdentity({
    token: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    runnerVersion: "0.0.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
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
    "session.wake": () => Effect.succeed(new WakeSessionAccepted({})),
    "session.abort": ({ runId }) => Effect.succeed(new AbortSessionAccepted({ runId })),
    "session.stop": () => Effect.succeed(new StopSessionAccepted({})),
    "session.delete": () => Effect.succeed(new DeleteSessionAccepted({})),
    "session.git-snapshot.read": () =>
      Effect.succeed(
        new SessionGitSnapshot({
          generatedAt: "2026-08-23T12:00:00Z",
          completeness: "complete",
          stale: false,
          truncated: false,
          sections: {
            staged: { files: [], patch: "", truncated: false },
            unstaged: {
              files: [{
                kind: "tracked",
                path: "src/main.ts",
                displayPath: "src/main.ts",
                status: "modified",
                diffState: "available",
              }],
              patch: "diff --git a/src/main.ts b/src/main.ts\n",
              truncated: false,
            },
          },
        }),
      ),
    "session.git-file.update": () => Effect.succeed(new GitFileUpdateAccepted({})),
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
  const stopPayload = new StopSessionPayload({ sessionId: SESSION_ID });
  const deletePayload = new DeleteSessionPayload({ sessionId: SESSION_ID });
  const wakePayload = new WakeSessionPayload({
    sessionId: SESSION_ID,
    modelRuntime: new SessionModelRuntime(modelRuntime()),
    githubToken: "github-token",
  });
  const watchPayload = new WatchSessionPayload({ sessionId: SESSION_ID, afterCursor: 0 });
  const snapshotPayload = new ReadSessionGitSnapshotPayload({ sessionId: SESSION_ID });
  const updatePayload = new UpdateSessionGitFilePayload({
    sessionId: SESSION_ID,
    action: "stage",
    path: "src/main.ts",
    previousPath: "src/old-main.ts",
  });

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
    assert((yield* client["session.wake"](wakePayload)) instanceof WakeSessionAccepted);
    assertEquals(
      (yield* client["session.abort"](abortPayload)).runId,
      RUN_ID,
    );
    assert((yield* client["session.stop"](stopPayload)) instanceof StopSessionAccepted);
    assert((yield* client["session.delete"](deletePayload)) instanceof DeleteSessionAccepted);
    assertEquals(
      (yield* client["session.git-snapshot.read"](snapshotPayload)).sections.unstaged.files[0]
        ?.path,
      "src/main.ts",
    );
    assert(
      (yield* client["session.git-file.update"](updatePayload)) instanceof GitFileUpdateAccepted,
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

function gitSnapshot(overrides: {
  readonly stagedFiles?: ReadonlyArray<object>;
  readonly unstagedFiles?: ReadonlyArray<object>;
  readonly stagedPatch?: string;
  readonly unstagedPatch?: string;
} = {}) {
  return {
    generatedAt: "2026-08-23T12:00:00Z",
    branch: "openorb/session",
    head: "0123456789abcdef0123456789abcdef01234567",
    completeness: "complete",
    stale: false,
    truncated: false,
    sections: {
      staged: {
        files: overrides.stagedFiles ?? [],
        patch: overrides.stagedPatch ?? "",
        truncated: false,
      },
      unstaged: {
        files: overrides.unstagedFiles ?? [],
        patch: overrides.unstagedPatch ?? "",
        truncated: false,
      },
    },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
