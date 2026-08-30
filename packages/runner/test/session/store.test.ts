import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import {
  GitAuthor,
  ProjectId,
  RunId,
  RunnerSessionSnapshot,
  SessionGitSnapshot,
  SessionId,
  UserId,
} from "@openorb/protocol/runner-api";
import { Effect, Schema } from "effect";
import { join } from "node:path";

import { RunnerSessionDefinition } from "@/src/session/definition.ts";
import { makeRunnerSessionStore } from "@/src/session/store.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c11",
);
const USER_ID = Schema.decodeUnknownSync(UserId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c12",
);
const OTHER_USER_ID = Schema.decodeUnknownSync(UserId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c13",
);
const GIT_AUTHOR = new GitAuthor({ name: "OpenOrb User", email: "user@example.com" });
const OTHER_GIT_AUTHOR = new GitAuthor({ name: "Another User", email: "other@example.com" });
const CREATED_AT = "2026-08-17T12:00:00Z";
const REPOSITORY_URL = "https://github.com/meln1k/openorb-test-repo.git";
const REF = "main";
const BRANCH_NAME = "openorb/session-test";
const MODEL = "opencode-go/deepseek-v4-flash";
const GUEST_BUILD_ID = "02e784cb-e063-5138-b1c4-334e8a3307a9";
const RUN_ID = Schema.decodeUnknownSync(RunId)("01989d78-65ee-7f6a-a97e-0f16ad134c14");

function sessionDefinition(
  initialPrompt = "Inspect the repository",
  orbSize: "small" | "medium" = "small",
): RunnerSessionDefinition {
  return new RunnerSessionDefinition({
    userId: USER_ID,
    projectId: PROJECT_ID,
    repositoryUrl: REPOSITORY_URL,
    ref: REF,
    branchName: BRANCH_NAME,
    gitAuthor: GIT_AUTHOR,
    initialPrompt,
    model: MODEL,
    orbSize,
  });
}

Deno.test("creates private runner session files and atomically reloads metadata", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    const prompt = `  inspect\n\tthis   ${"😀".repeat(205)}  `;
    const ensured = await Effect.runPromise(
      store.ensureSession(SESSION_ID, sessionDefinition(prompt), CREATED_AT),
    );
    const metadata = ensured.metadata;
    assertEquals(ensured.disposition, "created");
    assertEquals(metadata.state, "created");
    assertEquals(metadata.definition.orbSize, "small");

    const sessionPath = join(workingDirectory, "sessions", SESSION_ID);
    for (const directory of ["workspace", "pi", "logs", "snapshots", "checkpoints"]) {
      const info = await Deno.lstat(join(sessionPath, directory));
      assert(info.isDirectory);
      assertEquals(info.isSymlink, false);
      assertPrivateMode(info.mode, 0o700);
    }
    for (const file of ["lifecycle.jsonl", join("pi", "session.jsonl")]) {
      const info = await Deno.lstat(join(sessionPath, file));
      assert(info.isFile);
      assertEquals(info.isSymlink, false);
      assertPrivateMode(info.mode, 0o600);
    }

    await Deno.writeTextFile(join(sessionPath, "lifecycle.jsonl.interrupted.tmp"), "{");
    const restarted = await makeStore(workingDirectory);
    assertEquals(await Effect.runPromise(restarted.readMetadata(SESSION_ID)), metadata);
    assertEquals(
      (await Effect.runPromise(restarted.updateSessionState(SESSION_ID, "error"))).state,
      "error",
    );
    assertEquals((await Effect.runPromise(restarted.readMetadata(SESSION_ID))).state, "error");
    const replay = await Effect.runPromise(
      restarted.ensureSession(SESSION_ID, sessionDefinition(prompt)),
    );
    assertEquals(replay.disposition, "existing");
    assertEquals(replay.metadata, await Effect.runPromise(restarted.readMetadata(SESSION_ID)));
    for (
      const differingDefinition of [
        sessionDefinition("Duplicate session"),
        new RunnerSessionDefinition({ ...metadata.definition, userId: OTHER_USER_ID }),
        new RunnerSessionDefinition({ ...metadata.definition, gitAuthor: OTHER_GIT_AUTHOR }),
      ]
    ) {
      const duplicateError = await Effect.runPromise(Effect.flip(
        restarted.ensureSession(SESSION_ID, differingDefinition),
      ));
      assertEquals(duplicateError._tag, "RunnerSessionDefinitionConflict");
    }
    assertEquals((await Effect.runPromise(restarted.readMetadata(SESSION_ID))).state, "error");

    const manifest = await Effect.runPromise(restarted.loadSessionManifest());
    assertEquals(manifest.errors, []);
    assertEquals(manifest.sessions.length, 1);
    assertEquals(
      manifest.sessions[0],
      new RunnerSessionSnapshot({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        createdAt: CREATED_AT,
        initialPromptPreview: `inspect this ${"😀".repeat(187)}`,
        model: MODEL,
        orbSize: "small",
        state: "error",
        lastEventCursor: 0,
      }),
    );
    assertEquals(Array.from(manifest.sessions[0]!.initialPromptPreview).length, 200);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("orders run facts without losing a later follow-up timestamp", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(store.ensureSession(SESSION_ID, sessionDefinition(), CREATED_AT));
    await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
      state: "ready",
      checkoutState: "available",
    }));
    const started = await Effect.runPromise(
      store.startRun(SESSION_ID, RUN_ID, "2026-08-17T12:15:00Z"),
    );
    await Effect.runPromise(
      store.acceptFollowUp(SESSION_ID, RUN_ID, "2026-08-17T12:20:00Z"),
    );
    const settled = await Effect.runPromise(
      store.settleRun(SESSION_ID, RUN_ID, started.startedBy),
    );

    assertEquals(settled.state, "ready");
    assertEquals(settled.lastAcceptedUserMessageAt, "2026-08-17T12:20:00Z");
    const events = await readLifecycleEvents(workingDirectory);
    assertEquals(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assertEquals(events.map((event) => event.event.type), [
      "session.created",
      "provisioning.updated",
      "run.started",
      "follow-up.accepted",
      "run.settled",
    ]);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("discards an incomplete lifecycle tail before appending the next event", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(store.ensureSession(SESSION_ID, sessionDefinition(), CREATED_AT));
    const lifecyclePath = join(workingDirectory, "sessions", SESSION_ID, "lifecycle.jsonl");
    await Deno.writeTextFile(lifecyclePath, '{"version":1,"sequence":2', { append: true });

    const restarted = await makeStore(workingDirectory);
    const updated = await Effect.runPromise(restarted.updateSessionState(SESSION_ID, "error"));
    assertEquals(updated.state, "error");
    const events = await readLifecycleEvents(workingDirectory);
    assertEquals(events.map((event) => event.sequence), [1, 2]);
    assertEquals(events[1]?.event.type, "session.state-changed");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("imports legacy metadata once and appends only lifecycle events afterward", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    const ensured = await Effect.runPromise(
      store.ensureSession(SESSION_ID, sessionDefinition(), CREATED_AT),
    );
    const sessionPath = join(workingDirectory, "sessions", SESSION_ID);
    await Deno.remove(join(sessionPath, "lifecycle.jsonl"));
    await Deno.writeTextFile(
      join(sessionPath, "metadata.json"),
      `${JSON.stringify(ensured.metadata)}\n`,
    );

    const restarted = await makeStore(workingDirectory);
    assertEquals(await Effect.runPromise(restarted.readMetadata(SESSION_ID)), ensured.metadata);
    await Effect.runPromise(restarted.updateSessionState(SESSION_ID, "error"));
    const events = await readLifecycleEvents(workingDirectory);
    assertEquals(events.map((event) => event.sequence), [1, 2]);
    assertEquals(events.map((event) => event.event.type), [
      "session.imported",
      "session.state-changed",
    ]);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("derives replay cursors using Pi's JSONL parsing semantics", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(
      store.ensureSession(
        SESSION_ID,
        sessionDefinition("Inspect the repository", "medium"),
        CREATED_AT,
      ),
    );
    const sessionFile = join(workingDirectory, "sessions", SESSION_ID, "pi", "session.jsonl");
    const pi = SessionManager.open(sessionFile, undefined, "/workspace");
    pi.appendMessage({ role: "user", content: "Inspect the repository", timestamp: 1 });
    pi.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
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
      stopReason: "toolUse",
      timestamp: 2,
    });
    pi.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "README" }],
      isError: false,
      timestamp: 3,
    });

    assertEquals(
      (await Effect.runPromise(store.getSessionSnapshot(SESSION_ID))).lastEventCursor,
      4,
    );
    assertEquals(
      (await Array.fromAsync(Deno.readDir(workingDirectory + "/sessions/" + SESSION_ID))).some(
        (entry) => entry.name === "events.jsonl",
      ),
      false,
    );

    await Deno.writeTextFile(sessionFile, "{", { append: true });
    const manifest = await Effect.runPromise(store.loadSessionManifest());
    assertEquals(manifest.sessions[0]?.state, "created");
    assertEquals(manifest.sessions[0]?.lastEventCursor, 4);
    assertEquals(manifest.errors, []);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("atomically stores private validated Git Snapshots outside the workspace", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(store.ensureSession(SESSION_ID, sessionDefinition(), CREATED_AT));
    const snapshot = new SessionGitSnapshot({
      generatedAt: CREATED_AT,
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
    });

    const state = { snapshot, notificationPending: true };
    await Effect.runPromise(store.writeGitSnapshotState(SESSION_ID, state));
    assertEquals(await Effect.runPromise(store.readGitSnapshot(SESSION_ID)), snapshot);
    assertEquals(await Effect.runPromise(store.readGitSnapshotState(SESSION_ID)), state);
    const snapshotPath = join(
      workingDirectory,
      "sessions",
      SESSION_ID,
      "snapshots",
      "git-snapshot.json",
    );
    const info = await Deno.lstat(snapshotPath);
    assert(info.isFile);
    assertEquals(info.isSymlink, false);
    assertPrivateMode(info.mode, 0o600);

    await Deno.writeTextFile(
      snapshotPath,
      `${JSON.stringify({ ...state, unexpected: true })}\n`,
    );
    const invalid = await Effect.runPromise(Effect.flip(store.readGitSnapshot(SESSION_ID)));
    assertEquals(invalid._tag, "RunnerSessionStoreFailure");
    if (invalid._tag !== "RunnerSessionStoreFailure") throw invalid;
    assertEquals(invalid.operation, "read-git-snapshot");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("publishes only complete checkpoint candidates and safely replaces the current one", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(store.ensureSession(SESSION_ID, sessionDefinition(), CREATED_AT));
    await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
      state: "ready",
      checkoutState: "available",
    }));
    const acceptedAt = "2026-08-17T12:15:00Z";
    const run = await Effect.runPromise(store.startRun(SESSION_ID, RUN_ID, acceptedAt));
    assertEquals(run.metadata.lastAcceptedUserMessageAt, acceptedAt);
    await Effect.runPromise(store.settleRun(SESSION_ID, RUN_ID, run.startedBy));

    const first = await Effect.runPromise(store.beginCheckpoint(SESSION_ID));
    assertStringIncludes(first.path, join("sessions", SESSION_ID, "checkpoints"));
    assert(!first.path.includes(join("workspace", "checkpoints")));
    await Deno.writeTextFile(first.path, "first complete checkpoint");
    const firstMetadata = await Effect.runPromise(store.publishCheckpoint(
      SESSION_ID,
      first,
      checkpoint(first.path),
    ));
    assertEquals(firstMetadata.state, "stopped");
    assertEquals(firstMetadata.checkpoint?.file, first.file);
    assertEquals(firstMetadata.checkpointCandidate, undefined);
    assertEquals(
      await Effect.runPromise(store.readCurrentCheckpoint(SESSION_ID)),
      checkpoint(first.path),
    );

    await Effect.runPromise(store.updateSessionState(SESSION_ID, "ready"));
    const incomplete = await Effect.runPromise(store.beginCheckpoint(SESSION_ID));
    const failedPublication = await Effect.runPromise(
      Effect.flip(store.publishCheckpoint(SESSION_ID, incomplete, checkpoint(incomplete.path))),
    );
    assertEquals(failedPublication._tag, "RunnerSessionStoreFailure");
    const afterIncomplete = await Effect.runPromise(
      store.failCheckpoint(SESSION_ID, incomplete, false),
    );
    assertEquals(afterIncomplete.state, "ready");
    assertEquals(afterIncomplete.checkpoint?.file, first.file);
    assertEquals(
      await Effect.runPromise(store.readCurrentCheckpoint(SESSION_ID)),
      checkpoint(first.path),
    );

    const second = await Effect.runPromise(store.beginCheckpoint(SESSION_ID));
    assert(second.path !== first.path);
    await Deno.writeTextFile(second.path, "second complete checkpoint");
    const secondMetadata = await Effect.runPromise(store.publishCheckpoint(
      SESSION_ID,
      second,
      checkpoint(second.path),
    ));
    assertEquals(secondMetadata.checkpoint?.file, second.file);
    assertEquals(
      await Effect.runPromise(store.readCurrentCheckpoint(SESSION_ID)),
      checkpoint(second.path),
    );
    await assertPathMissing(first.path);
    assertEquals(await Deno.readTextFile(second.path), "second complete checkpoint");

    await Effect.runPromise(store.updateSessionState(SESSION_ID, "ready"));
    const consumedFailure = await Effect.runPromise(store.beginCheckpoint(SESSION_ID));
    await Deno.writeTextFile(consumedFailure.path, "partial after shutdown");
    const failedMetadata = await Effect.runPromise(
      store.failCheckpoint(SESSION_ID, consumedFailure, true),
    );
    assertEquals(failedMetadata.state, "error");
    assertEquals(failedMetadata.checkpoint?.file, second.file);
    assertEquals(
      await Effect.runPromise(store.readCurrentCheckpoint(SESSION_ID)),
      checkpoint(second.path),
    );
    await assertPathMissing(consumedFailure.path);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("restart reconciliation removes interrupted and obsolete checkpoint candidates", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(store.ensureSession(SESSION_ID, sessionDefinition(), CREATED_AT));
    await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
      state: "ready",
      checkoutState: "available",
    }));
    const current = await Effect.runPromise(store.beginCheckpoint(SESSION_ID));
    await Deno.writeTextFile(current.path, "published");
    await Effect.runPromise(
      store.publishCheckpoint(SESSION_ID, current, checkpoint(current.path)),
    );
    await Effect.runPromise(store.updateSessionState(SESSION_ID, "ready"));
    const interrupted = await Effect.runPromise(store.beginCheckpoint(SESSION_ID));
    await Deno.writeTextFile(interrupted.path, "partial");
    const obsoletePath = join(
      workingDirectory,
      "sessions",
      SESSION_ID,
      "checkpoints",
      `checkpoint-${crypto.randomUUID()}.qcow2`,
    );
    await Deno.writeTextFile(obsoletePath, "obsolete");

    const restarted = await makeStore(workingDirectory);
    const reconciled = await Effect.runPromise(restarted.reconcileCheckpoints(SESSION_ID));
    assertEquals(reconciled.state, "error");
    assertEquals(reconciled.checkpoint?.file, current.file);
    assertEquals(reconciled.checkpointCandidate, undefined);
    assertEquals(
      await Effect.runPromise(restarted.readCurrentCheckpoint(SESSION_ID)),
      checkpoint(current.path),
    );
    await assertPathMissing(interrupted.path);
    await assertPathMissing(obsoletePath);
    assertEquals(await Deno.readTextFile(current.path), "published");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("restart reconciliation records an interrupted active run with its initiating sequence", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(store.ensureSession(SESSION_ID, sessionDefinition(), CREATED_AT));
    await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
      state: "ready",
      checkoutState: "available",
    }));
    const started = await Effect.runPromise(store.startRun(SESSION_ID, RUN_ID));

    const restarted = await makeStore(workingDirectory);
    const reconciled = await Effect.runPromise(restarted.reconcileCheckpoints(SESSION_ID));
    assertEquals(reconciled.state, "ready");

    const events = await readLifecycleEvents(workingDirectory);
    const interrupted = events.at(-1);
    assertEquals(interrupted?.sequence, started.startedBy + 1);
    assertEquals(interrupted?.event, {
      type: "run.interrupted",
      runId: RUN_ID,
      startedBy: started.startedBy,
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("strictly validates persisted session lifecycle events", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(
      store.ensureSession(SESSION_ID, sessionDefinition(), CREATED_AT),
    );
    const lifecyclePath = join(workingDirectory, "sessions", SESSION_ID, "lifecycle.jsonl");
    const original = await Deno.readTextFile(lifecyclePath);
    await Deno.writeTextFile(lifecyclePath, `${original}{"version":1,"sequence":2}\n`);

    const missingFieldError = await Effect.runPromise(Effect.flip(store.readMetadata(SESSION_ID)));
    assertEquals(missingFieldError._tag, "RunnerSessionStoreFailure");
    if (missingFieldError._tag !== "RunnerSessionStoreFailure") throw missingFieldError;
    assertEquals(missingFieldError.operation, "read-metadata");

    await Deno.writeTextFile(
      lifecyclePath,
      `${original}{"version":1,"sequence":2,"event":{"type":"session.state-changed","state":"ready"},"unexpected":true}\n`,
    );
    const excessFieldError = await Effect.runPromise(Effect.flip(store.readMetadata(SESSION_ID)));
    assertEquals(excessFieldError._tag, "RunnerSessionStoreFailure");
    if (excessFieldError._tag !== "RunnerSessionStoreFailure") throw excessFieldError;
    assertEquals(excessFieldError.operation, "read-metadata");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("fails store construction when session storage cannot be initialized", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(workingDirectory, "sessions"), "not a directory");
    const error = await Effect.runPromise(Effect.flip(
      makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
        Effect.provide(DenoFileSystem.layer),
      ),
    ));
    assertEquals(error._tag, "RunnerSessionStoreFailure");
    if (error._tag !== "RunnerSessionStoreFailure") throw error;
    assertEquals(error.operation, "initialize");
    assertStringIncludes(error.message, "initialize runner session storage");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

function assertPrivateMode(mode: number | null, expected: number): void {
  if (Deno.build.os !== "windows" && mode !== null) assertEquals(mode & 0o777, expected);
}

function checkpoint(path: string) {
  return {
    path,
    guestAssetBuildId: GUEST_BUILD_ID,
    createdWithVmm: "qemu" as const,
    compatibleVmm: ["qemu" as const],
  };
}

async function readLifecycleEvents(workingDirectory: string): Promise<
  Array<{
    sequence: number;
    event: { type: string; runId?: string; startedBy?: number };
  }>
> {
  const text = await Deno.readTextFile(
    join(workingDirectory, "sessions", SESSION_ID, "lifecycle.jsonl"),
  );
  return text.trimEnd().split("\n").map((line) => JSON.parse(line));
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
    throw new Error(`Expected ${path} not to exist.`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function makeStore(workingDirectory: string) {
  return Effect.runPromise(
    makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
      Effect.provide(DenoFileSystem.layer),
    ),
  );
}
