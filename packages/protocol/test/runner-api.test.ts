import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseSafe } from "@remix-run/data-schema";
import { Effect, Schema, type Scope, Stream } from "effect";
import * as RpcTest from "effect/rpc/RpcTest";

import { sessionGitSnapshotSchema } from "@/src/browser-session-git-snapshot.ts";
import {
  AttachEnvironmentPayload,
  type CapacityExceeded,
  ControlEnvironmentPayload,
  ConversationViewSchema,
  CreateEnvironmentPayload,
  DeleteEnvironmentPayload,
  type DeleteFailed,
  EnvironmentAttachAccepted,
  EnvironmentAttachNonce,
  EnvironmentControlled,
  EnvironmentCreated,
  EnvironmentDeleted,
  type EnvironmentNotFound,
  type EnvironmentRejected,
  GitAuthor,
  GitMutationRevision,
  MAX_SESSION_ISSUES,
  ProjectId,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  RunnerCapacity,
  RunnerEnvironmentSnapshot,
  RunnerId,
  RunnerIdentity,
  type RunnerIdentityError,
  RunnerSessionSnapshot,
  type RunnerWatchError,
  type SessionConflict,
  SessionEnvironmentSecret,
  SessionEnvironmentSecrets,
  SessionEvent,
  SessionGitSnapshot,
  SessionId,
  SessionIssue,
  SessionIssues,
  SessionModelRuntime,
  WorkspaceId,
} from "@/src/runner-api.ts";
import {
  MAX_RUNNER_RPC_FRAME_BYTES,
  MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_FILES_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_JSON_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_PATCH_SECTION_JSON_BYTES,
} from "@/src/runner-api-limits.ts";

type RunnerApiError =
  | CapacityExceeded
  | DeleteFailed
  | EnvironmentNotFound
  | EnvironmentRejected
  | RunnerIdentityError
  | RunnerWatchError
  | SessionConflict;

const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134c09");
const WORKSPACE_ID = WorkspaceId.make("01989d78-65ee-7f6a-a97e-0f16ad134c12");
const PROJECT_ID = ProjectId.make("01989d78-65ee-7f6a-a97e-0f16ad134c10");
const RUNNER_ID = RunnerId.make("01989d78-65ee-7f6a-a97e-0f16ad134c11");
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
  const created = Schema.decodeUnknownSync(CreateEnvironmentPayload)({
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    orbSize: "medium",
    repositoryUrl: "https://github.com/openorb/example.git",
    gitAuthor: { name: "OpenOrb User", email: "user@example.com" },
  });
  assertEquals(created.workspaceId, WORKSPACE_ID);
  assertThrows(() =>
    Schema.decodeUnknownSync(CreateEnvironmentPayload)({
      ...created,
      repositoryUrl: "https://example.com/openorb/example.git",
    })
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(CreateEnvironmentPayload)({
      ...created,
      gitAuthor: { name: "OpenOrb User", email: "not-an-email" },
    })
  );

  const started = Schema.decodeUnknownSync(ControlEnvironmentPayload)({
    sessionId: SESSION_ID,
    action: "start",
    githubToken: "github-token",
    environmentSecrets: [{
      name: "SERVICE_TOKEN",
      value: "service-secret",
      allowedHosts: ["api.example.com", "*.service.example"],
    }],
  });
  assertEquals(started.environmentSecrets, [
    new SessionEnvironmentSecret({
      name: "SERVICE_TOKEN",
      value: "service-secret",
      allowedHosts: ["api.example.com", "*.service.example"],
    }),
  ]);
  for (
    const environmentSecrets of [
      [
        { name: "GH_TOKEN", value: "collision" },
      ],
      [
        { name: "SERVICE_TOKEN", value: "one" },
        { name: "SERVICE_TOKEN", value: "two" },
      ],
      [
        { name: "SERVICE_TOKEN", value: "secret", allowedHosts: ["https://api.example.com"] },
      ],
    ]
  ) {
    assertThrows(() =>
      Schema.decodeUnknownSync(ControlEnvironmentPayload)({ ...started, environmentSecrets })
    );
  }
  assertThrows(() =>
    Schema.decodeUnknownSync(ControlEnvironmentPayload)({ ...started, action: "suspend" })
  );
  assertEquals(RUNNER_PROTOCOL_VERSION, 27);
});

Deno.test("session model runtime accepts only explicit credential transports", () => {
  const accessToken = Schema.decodeUnknownSync(SessionModelRuntime)({
    ...modelRuntime(),
    credential: { type: "access_token", value: "short-lived-access" },
  });
  assertEquals(accessToken.credential, {
    type: "access_token",
    value: "short-lived-access",
  });
  assertThrows(() =>
    Schema.decodeUnknownSync(SessionModelRuntime)({
      ...modelRuntime(),
      credential: {
        type: "oauth",
        access: "access",
        refresh: "refresh-must-not-cross-the-protocol",
      },
    })
  );
});

Deno.test("environment secrets reserve enough room for the RPC request envelope", () => {
  const maximumLengthHost = (index: number) =>
    `${index.toString(36).padStart(2, "0")}.${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${
      "d".repeat(58)
    }`;
  const environmentSecrets = (hostCount: number) =>
    Array.from({ length: 64 }, (_, secretIndex) => ({
      name: `SERVICE_TOKEN_${secretIndex}`,
      value: "x".repeat(4_096),
      allowedHosts: Array.from(
        { length: hostCount },
        (_, hostIndex) => maximumLengthHost(hostIndex),
      ),
    }));

  assertEquals(maximumLengthHost(0).length, 253);
  const acceptedSecrets = Schema.decodeUnknownSync(SessionEnvironmentSecrets)(
    environmentSecrets(31),
  );
  assert(
    byteLength(JSON.stringify(acceptedSecrets)) < MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES,
  );

  const payload = Schema.decodeUnknownSync(ControlEnvironmentPayload)({
    sessionId: SESSION_ID,
    action: "restart",
    githubToken: "\0".repeat(4_096),
    environmentSecrets: acceptedSecrets,
    recovery: "restart-environment",
  });
  const frame = {
    _tag: "Request",
    id: Number.MAX_SAFE_INTEGER,
    tag: "environment.control",
    payload,
    headers: [],
    traceId: "f".repeat(32),
    spanId: "f".repeat(16),
    sampled: true,
  };
  assert(byteLength(JSON.stringify(frame)) <= MAX_RUNNER_RPC_FRAME_BYTES);

  const oversizedSecrets = environmentSecrets(32);
  const oversizedBytes = byteLength(JSON.stringify(oversizedSecrets));
  assert(oversizedBytes > MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES);
  assert(oversizedBytes < MAX_RUNNER_RPC_FRAME_BYTES);
  assertThrows(() => Schema.decodeUnknownSync(SessionEnvironmentSecrets)(oversizedSecrets));
});

Deno.test("structural frames reject normalized events, host objects and malformed ops", () => {
  const view = { conversation: { id: 0 }, entries: [], docs: {} };
  assertEquals<unknown>(Schema.decodeUnknownSync(ConversationViewSchema)(view), view);
  for (
    const invalid of [
      { type: "assistant.text.delta", delta: "old" },
      { type: "conversation.ops", ops: [["s", "compressed-path", 1]] },
      { type: "conversation.ops", ops: [["s", ["__proto__", "polluted"], true]] },
      { type: "conversation.ops", ops: [["r", { handle: () => {} }]] },
      { type: "conversation.snapshot", view: { ...view, docs: { host: new Date() } } },
      { type: "conversation.snapshot", view: { ...view, entries: [{ id: 1 }] } },
    ]
  ) assertThrows(() => Schema.decodeUnknownSync(SessionEvent)(invalid));
  assertThrows(() =>
    Schema.decodeUnknownSync(RunnerSessionSnapshot)({ ...sessionSnapshot(), agentState: undefined })
  );
});

Deno.test("session issues are categorized, bounded, and carry explicit recovery", () => {
  const issue = Schema.decodeUnknownSync(SessionIssue)({
    category: "vm-stop",
    severity: "failure",
    message: "The VM disk could not be synchronized.",
    diagnostics: "safe bounded diagnostics",
    recovery: "restart-environment",
  });
  assertEquals(issue.recovery, "restart-environment");
  assertEquals(
    Schema.decodeUnknownSync(SessionIssues)(Array(MAX_SESSION_ISSUES).fill(issue)).length,
    MAX_SESSION_ISSUES,
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(SessionIssues)(Array(MAX_SESSION_ISSUES + 1).fill(issue))
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(SessionIssue)({ ...issue, message: "x".repeat(1_001) })
  );
});

Deno.test("SessionGitSnapshot rejects payloads that would exceed its JSON budgets", () => {
  const largeFiles = Array.from({ length: 5_000 }, (_, index) => {
    const path = `${index}-${"x".repeat(220)}`;
    return {
      kind: "tracked" as const,
      path,
      displayPath: path,
      status: "modified" as const,
      diffState: "available" as const,
    };
  });
  assertEquals(largeFiles.length, 5_000);
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

  const individuallyValidPatch = "\u001b".repeat(17_000);
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

Deno.test("SessionGitSnapshot rejects excess keys at every nesting level despite permissive decoding", () => {
  const snapshot = gitSnapshot();
  const decode = Schema.decodeUnknownSync(SessionGitSnapshot, { onExcessProperty: "ignore" });
  assertEquals<object>(Schema.encodeSync(SessionGitSnapshot)(decode(snapshot)), snapshot);
  const sections = snapshot.sections;
  for (
    const candidate of [
      { ...snapshot, extra: true },
      { ...snapshot, sections: { ...sections, extra: true } },
      { ...snapshot, sections: { ...sections, staged: { ...sections.staged, extra: true } } },
      { ...snapshot, sections: { ...sections, unstaged: { ...sections.unstaged, extra: true } } },
      gitSnapshot({
        unstagedFiles: [{
          kind: "tracked",
          path: "src/main.ts",
          displayPath: "src/main.ts",
          status: "modified",
          diffState: "available",
          previousPath: "not-a-rename.ts",
        }],
      }),
    ]
  ) {
    assertThrows(() => decode(candidate));
  }
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

Deno.test("RunnerApi exposes only runner and environment procedures through RpcTest", async () => {
  const identity = new RunnerIdentity({
    token: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    runnerVersion: "0.0.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  });
  const capacity = runnerCapacity();
  const environment = new RunnerEnvironmentSnapshot({
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    createdAt: "2026-08-23T12:00:00Z",
    orbSize: "small",
    state: "stopped",
  });
  assertEquals(Array.from(RunnerApi.requests.keys()).sort(), [
    "environment.attach",
    "environment.control",
    "environment.create",
    "environment.delete",
    "runner.identify",
    "runner.watch",
  ]);
  const handlers = RunnerApi.toLayer({
    "runner.identify": () => Effect.succeed(identity),
    "runner.watch": () =>
      Stream.make(
        { type: "snapshot.environment" as const, environment },
        {
          type: "snapshot.complete" as const,
          revision: 1,
          environmentCount: 1,
          observedAt: 1,
          capacity,
        },
      ),
    "environment.create": () => Effect.succeed(new EnvironmentCreated({ environment })),
    "environment.control": ({ action }) =>
      Effect.succeed(
        new EnvironmentControlled({
          state: action === "stop" ? "stopped" : "running",
          forced: false,
        }),
      ),
    "environment.attach": () => Effect.succeed(new EnvironmentAttachAccepted({})),
    "environment.delete": () => Effect.succeed(new EnvironmentDeleted({})),
  });

  const createPayload = new CreateEnvironmentPayload({
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    orbSize: "small",
    repositoryUrl: "https://github.com/acme/repo.git",
    gitAuthor: new GitAuthor({ name: "Ada", email: "ada@example.com" }),
  });
  const controlPayload = new ControlEnvironmentPayload({
    sessionId: SESSION_ID,
    action: "start",
    githubToken: "github-token",
  });
  const attachPayload = new AttachEnvironmentPayload({
    sessionId: SESSION_ID,
    nonce: Schema.decodeUnknownSync(EnvironmentAttachNonce)("A".repeat(43)),
  });
  const deletePayload = new DeleteEnvironmentPayload({ sessionId: SESSION_ID });

  await Effect.runPromise(Effect.scoped(Effect.gen(function* (): Effect.fn.Return<
    void,
    RunnerApiError,
    Scope.Scope
  > {
    const client = yield* RpcTest.makeClient(RunnerApi).pipe(Effect.provide(handlers));
    assertEquals((yield* client["runner.identify"]()).runnerId, RUNNER_ID);
    assertEquals(
      Array.from(yield* client["runner.watch"]().pipe(Stream.runCollect)).map((event) =>
        event.type
      ),
      ["snapshot.environment", "snapshot.complete"],
    );
    assertEquals(
      (yield* client["environment.create"](createPayload)).environment.sessionId,
      SESSION_ID,
    );
    assertEquals(
      (yield* client["environment.control"](controlPayload)).state,
      "running",
    );
    assert(
      (yield* client["environment.attach"](attachPayload)) instanceof EnvironmentAttachAccepted,
    );
    assert(
      (yield* client["environment.delete"](deletePayload)) instanceof EnvironmentDeleted,
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
    initialThinkingLevel: "max",
    orbSize: "medium",
    state: "ready",
    agentState: "idle",
    environmentState: "running",
    issues: [],
  });
}

function gitSnapshot(overrides: {
  readonly stagedFiles?: ReadonlyArray<object>;
  readonly unstagedFiles?: ReadonlyArray<object>;
  readonly stagedPatch?: string;
  readonly unstagedPatch?: string;
} = {}) {
  return {
    mutationRevision: GitMutationRevision.make(0),
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
