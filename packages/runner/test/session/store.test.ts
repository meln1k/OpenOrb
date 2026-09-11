import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import {
  GitAuthor,
  GitMutationRevision,
  ProjectId,
  RunnerId,
  RunnerSessionSnapshot,
  SessionGitSnapshot,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { SessionGitSnapshotId } from "@openorb/protocol/runner-bulk-api";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { join } from "node:path";

import { Journal } from "@/src/session/persistent-actor/journal.ts";
import { RunnerSessionDefinition } from "@/src/session/definition.ts";
import { sessionJournalLayer } from "@/src/session/persistent-actor/session-journal.ts";
import { sessionMetadata } from "@/src/session/actor/state.ts";
import {
  makeRunnerSessionStore,
  RunnerSessionStore,
  runnerSessionStoreLayer,
} from "@/src/session/store.ts";
import { makeSessionFixture, type SessionFixture } from "./session-fixture.ts";

const RUNNER_ID = Schema.decodeUnknownSync(RunnerId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c09",
);
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c11",
);
const WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c12",
);
const CREATED_AT = "2026-08-17T12:00:00Z";
const MODEL = "opencode-go/deepseek-v4-flash";

interface TestStore {
  readonly store: RunnerSessionStore;
  readonly session: SessionFixture;
}

function sessionDefinition(
  initialPrompt = "Inspect the repository",
  orbSize: "small" | "medium" = "small",
): RunnerSessionDefinition {
  return new RunnerSessionDefinition({
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    ref: "main",
    branchName: "openorb/session-test",
    gitAuthor: new GitAuthor({ name: "OpenOrb User", email: "user@example.com" }),
    initialPrompt,
    model: MODEL,
    orbSize,
  });
}

Deno.test("creates private session storage and recovers cold session state", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    const prompt = `  inspect\n\tthis   ${"😀".repeat(205)}  `;
    const state = await Effect.runPromise(
      session.create(SESSION_ID, sessionDefinition(prompt), CREATED_AT),
    );
    const metadata = sessionMetadata(state);
    assertEquals(metadata.state, "provisioning");
    assertEquals(
      await Effect.runPromise(store.ensureSessionStorage(SESSION_ID)),
      "existing",
    );

    const sessionPath = join(workingDirectory, "sessions", SESSION_ID);
    for (const directory of ["pi", "logs", "snapshots"]) {
      const info = await Deno.lstat(join(sessionPath, directory));
      assert(info.isDirectory);
      assertEquals(info.isSymlink, false);
      assertPrivateMode(info.mode, 0o700);
    }
    for (const file of ["events.jsonl", join("pi", "session.jsonl")]) {
      const info = await Deno.lstat(join(sessionPath, file));
      assert(info.isFile);
      assertEquals(info.isSymlink, false);
      assertPrivateMode(info.mode, 0o600);
    }
    assertEquals(
      await Effect.runPromise(store.getSessionRootDiskPath(SESSION_ID)),
      join(sessionPath, "root-disk.qcow2"),
    );
    await assertPathMissing(join(sessionPath, "root-disk.qcow2"));
    const deletionQueue = await Deno.lstat(join(workingDirectory, "session-deletions"));
    assert(deletionQueue.isDirectory);
    assertEquals(deletionQueue.isSymlink, false);
    assertPrivateMode(deletionQueue.mode, 0o700);

    const restarted = await makeStore(workingDirectory);
    assertEquals(
      await Effect.runPromise(restarted.store.readMetadata(SESSION_ID)),
      metadata,
    );
    const manifest = await Effect.runPromise(restarted.store.loadSessionManifest());
    assertEquals(manifest.errors, []);
    assertEquals(manifest.sessions, [
      new RunnerSessionSnapshot({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        createdAt: CREATED_AT,
        initialPromptPreview: `inspect this ${"😀".repeat(187)}`,
        model: MODEL,
        orbSize: "small",
        state: "provisioning",
        issues: [],
        lastEventCursor: 0,
      }),
    ]);
    assertEquals(Array.from(manifest.sessions[0]!.initialPromptPreview).length, 200);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("derives replay cursors using Pi JSONL parsing semantics", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    await Effect.runPromise(
      session.create(
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
    await Deno.writeTextFile(sessionFile, "{", { append: true });
    const manifest = await Effect.runPromise(store.loadSessionManifest());
    assertEquals(manifest.sessions[0]?.lastEventCursor, 4);
    assertEquals(manifest.errors, []);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("atomically stores private validated Git Snapshots outside the workspace", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    await Effect.runPromise(session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    const snapshotId = Schema.decodeUnknownSync(SessionGitSnapshotId)("a".repeat(64));
    const patch = "diff --git a/src/main.ts b/src/main.ts\n+hello 🌍\n";
    const snapshot = new SessionGitSnapshot({
      snapshotId,
      generatedAt: CREATED_AT,
      completeness: "complete",
      stale: false,
      truncated: false,
      sections: {
        staged: { files: [], patch: "", fullPatchBytes: 0, truncated: false },
        unstaged: {
          files: [{
            kind: "tracked",
            path: "src/main.ts",
            displayPath: "src/main.ts",
            status: "modified",
            diffState: "available",
          }],
          patch: "diff --git a/src/main.ts b/src/main.ts\n",
          fullPatchBytes: new TextEncoder().encode(patch).byteLength,
          truncated: false,
        },
      },
    });
    const state = {
      snapshot,
      mutationRevision: GitMutationRevision.make(0),
      notificationPending: true,
    };

    await Effect.runPromise(store.writeGitSnapshotState(SESSION_ID, state, {
      snapshotId,
      staged: "",
      unstaged: patch,
    }));
    assertEquals(await Effect.runPromise(store.readGitSnapshot(SESSION_ID)), snapshot);
    assertEquals(await Effect.runPromise(store.readGitSnapshotState(SESSION_ID)), state);
    const first = await Effect.runPromise(
      store.readGitSnapshotPatchChunk(SESSION_ID, snapshotId, "unstaged", 0, 17),
    );
    const second = await Effect.runPromise(
      store.readGitSnapshotPatchChunk(SESSION_ID, snapshotId, "unstaged", first.nextOffset, 1_000),
    );
    assertEquals(first.done, false);
    assertEquals(second.done, true);
    assertEquals(
      new TextDecoder().decode(new Uint8Array([...first.bytes, ...second.bytes])),
      patch,
    );
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
    assertEquals(invalid.operation, "read-git-snapshot");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("Git mutation revisions decode legacy state and survive store restarts", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const initial = await makeStore(workingDirectory);
    await Effect.runPromise(initial.session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    const snapshotId = Schema.decodeUnknownSync(SessionGitSnapshotId)("a".repeat(64));
    await Effect.runPromise(
      initial.store.writeGitSnapshotState(
        SESSION_ID,
        gitSnapshotState(snapshotId, "", false),
      ),
    );
    const snapshotPath = join(
      workingDirectory,
      "sessions",
      SESSION_ID,
      "snapshots",
      "git-snapshot.json",
    );
    // SAFETY: The test reads the JSON object that the typed store wrote immediately above.
    const legacyState = JSON.parse(await Deno.readTextFile(snapshotPath)) as {
      mutationRevision?: unknown;
    };
    delete legacyState.mutationRevision;
    await Deno.writeTextFile(snapshotPath, `${JSON.stringify(legacyState)}\n`);

    const legacyRestart = await makeStore(workingDirectory);
    assertEquals(
      (await Effect.runPromise(legacyRestart.store.readGitSnapshotState(SESSION_ID)))
        .mutationRevision,
      GitMutationRevision.make(0),
    );
    assertEquals(
      await Effect.runPromise(legacyRestart.store.advanceGitMutationRevision(SESSION_ID)),
      GitMutationRevision.make(1),
    );

    const durableRestart = await makeStore(workingDirectory);
    assertEquals(
      (await Effect.runPromise(durableRestart.store.readGitSnapshotState(SESSION_ID)))
        .mutationRevision,
      GitMutationRevision.make(1),
    );
    assertEquals(
      await Effect.runPromise(durableRestart.store.advanceGitMutationRevision(SESSION_ID)),
      GitMutationRevision.make(2),
    );
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("a later Git Snapshot write retries failed patch retirement", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const initial = await makeStore(workingDirectory);
    await Effect.runPromise(initial.session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    const firstId = Schema.decodeUnknownSync(SessionGitSnapshotId)("a".repeat(64));
    const secondId = Schema.decodeUnknownSync(SessionGitSnapshotId)("b".repeat(64));
    const first = gitSnapshotState(firstId, "first patch", true);
    const second = gitSnapshotState(secondId, "second patch", true);
    await Effect.runPromise(initial.store.writeGitSnapshotState(SESSION_ID, first, {
      snapshotId: firstId,
      staged: "",
      unstaged: "first patch",
    }));

    const firstStagedPatch = gitPatchPath(workingDirectory, firstId, "staged");
    const firstUnstagedPatch = gitPatchPath(workingDirectory, firstId, "unstaged");
    const failing = await makeStore(workingDirectory, failRemovalAt(firstStagedPatch));
    const failure = await Effect.runPromise(Effect.flip(
      failing.store.writeGitSnapshotState(SESSION_ID, second, {
        snapshotId: secondId,
        staged: "",
        unstaged: "second patch",
      }),
    ));
    assertEquals(failure.operation, "write-git-snapshot");

    const restarted = await makeStore(workingDirectory);
    assertEquals(await Effect.runPromise(restarted.store.readGitSnapshotState(SESSION_ID)), second);
    await Effect.runPromise(restarted.store.writeGitSnapshotState(SESSION_ID, {
      ...second,
      notificationPending: false,
    }));
    await assertPathMissing(firstStagedPatch);
    await assertPathMissing(firstUnstagedPatch);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("Git Snapshot storage does not replay session metadata", async () => {
  const workingDirectory = await Deno.makeTempDir();
  const journalPath = join(workingDirectory, "sessions", SESSION_ID, "events.jsonl");
  let journalReads = 0;
  try {
    const { store, session } = await makeStore(
      workingDirectory,
      observeReadAt(journalPath, () => journalReads++),
    );
    await Effect.runPromise(session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    await Deno.remove(journalPath);
    const snapshotId = Schema.decodeUnknownSync(SessionGitSnapshotId)("a".repeat(64));
    const state = gitSnapshotState(snapshotId, "patch", false);
    journalReads = 0;
    await Effect.runPromise(store.writeGitSnapshotState(SESSION_ID, state, {
      snapshotId,
      staged: "",
      unstaged: "patch",
    }));
    assertEquals(await Effect.runPromise(store.readGitSnapshotState(SESSION_ID)), state);
    await Effect.runPromise(
      store.readGitSnapshotPatchChunk(SESSION_ID, snapshotId, "unstaged", 0, 1),
    );
    assertEquals(journalReads, 0);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("syncs a regular persistent session root disk", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    await Effect.runPromise(session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    const rootDiskPath = join(
      workingDirectory,
      "sessions",
      SESSION_ID,
      "root-disk.qcow2",
    );
    await Deno.writeTextFile(rootDiskPath, "persistent guest state");

    await Effect.runPromise(store.syncSessionRootDisk(SESSION_ID));

    assertEquals(await Deno.readTextFile(rootDiskPath), "persistent guest state");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("rejects a missing or non-regular session root disk", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    await Effect.runPromise(session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    const rootDiskPath = join(
      workingDirectory,
      "sessions",
      SESSION_ID,
      "root-disk.qcow2",
    );

    const missing = await Effect.runPromise(Effect.flip(store.syncSessionRootDisk(SESSION_ID)));
    assertEquals(missing.operation, "sync-root-disk");

    await Deno.mkdir(rootDiskPath);
    const notRegular = await Effect.runPromise(
      Effect.flip(store.syncSessionRootDisk(SESSION_ID)),
    );
    assertEquals(notRegular.operation, "sync-root-disk");
    assertStringIncludes(notRegular.message, "root disk must be a regular file");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("reports invalid session entries without hiding valid manifest sessions", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    await Effect.runPromise(session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    await Deno.writeTextFile(join(workingDirectory, "sessions", "invalid-entry"), "invalid");

    const manifest = await Effect.runPromise(store.loadSessionManifest());
    assertEquals(manifest.sessions.length, 1);
    assertEquals(manifest.errors.length, 1);
    assertEquals(manifest.errors[0]?.sessionDirectory, "invalid-entry");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("fails cold reads when persisted session events are invalid", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    await Effect.runPromise(session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    await Deno.writeTextFile(
      join(workingDirectory, "sessions", SESSION_ID, "events.jsonl"),
      '{"version":1,"sequence":2,"event":{"type":"unknown"}}\n',
      { append: true },
    );

    const invalid = await Effect.runPromise(Effect.flip(store.readMetadata(SESSION_ID)));
    assertEquals(invalid.operation, "read-metadata");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("idempotently removes every session-owned storage path", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store } = await makeStore(workingDirectory);
    assertEquals(await Effect.runPromise(store.ensureSessionStorage(SESSION_ID)), "created");
    const sessionPath = join(workingDirectory, "sessions", SESSION_ID);
    for (
      const [directory, file] of [
        ["pi", "history.jsonl"],
        ["logs", "runner.log"],
        ["snapshots", "git-snapshot.json"],
      ] as const
    ) {
      await Deno.writeTextFile(join(sessionPath, directory, file), directory);
    }
    await Deno.writeTextFile(join(sessionPath, "root-disk.qcow2"), "root disk");
    await Deno.mkdir(join(sessionPath, "obsolete"));
    await Deno.writeTextFile(join(sessionPath, "obsolete", "vm-state"), "obsolete");

    await Effect.runPromise(store.removeSessionStorage(SESSION_ID));
    await assertPathMissing(sessionPath);
    await Effect.runPromise(store.removeSessionStorage(SESSION_ID));
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("failed cleanup leaves an admitted deletion queued for startup recovery", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const initial = await makeStore(workingDirectory);
    await Effect.runPromise(initial.session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    const sessionPath = join(workingDirectory, "sessions", SESSION_ID);
    const queuedPath = join(workingDirectory, "session-deletions", SESSION_ID);
    const failing = await makeStore(workingDirectory, failRemovalAt(queuedPath));

    const failure = await Effect.runPromise(Effect.flip(
      failing.store.removeSessionStorage(SESSION_ID),
    ));

    assertEquals(failure.operation, "remove-session-storage");
    await assertPathMissing(sessionPath);
    assert((await Deno.lstat(queuedPath)).isDirectory);
    assert((await Deno.lstat(join(queuedPath, "events.jsonl"))).isFile);

    const restarted = await makeStore(workingDirectory);
    await assertPathMissing(queuedPath);
    assertEquals(await Effect.runPromise(restarted.store.loadSessionManifest()), {
      sessions: [],
      errors: [],
    });
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("startup sweeps a partially removed queued deletion without its journal", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const initial = await makeStore(workingDirectory);
    await Effect.runPromise(initial.session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    const sessionPath = join(workingDirectory, "sessions", SESSION_ID);
    const queuedPath = join(workingDirectory, "session-deletions", SESSION_ID);
    await Deno.rename(sessionPath, queuedPath);
    await Deno.remove(join(queuedPath, "events.jsonl"));
    await Deno.remove(join(queuedPath, "snapshots"), { recursive: true });

    const restarted = await makeStore(workingDirectory);

    await assertPathMissing(queuedPath);
    assertEquals(await Effect.runPromise(restarted.store.loadSessionManifest()), {
      sessions: [],
      errors: [],
    });
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
        Effect.provide(sessionPersistenceLayer(workingDirectory)),
      ),
    ));
    assertEquals(error.operation, "initialize");
    assertStringIncludes(error.message, "initialize runner session storage");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

function assertPrivateMode(mode: number | null, expected: number): void {
  if (Deno.build.os !== "windows" && mode !== null) assertEquals(mode & 0o777, expected);
}

function gitSnapshotState(
  snapshotId: typeof SessionGitSnapshotId.Type,
  patch: string,
  notificationPending: boolean,
) {
  return {
    snapshot: new SessionGitSnapshot({
      snapshotId,
      generatedAt: CREATED_AT,
      completeness: "complete",
      stale: false,
      truncated: false,
      sections: {
        staged: { files: [], patch: "", fullPatchBytes: 0, truncated: false },
        unstaged: {
          files: [],
          patch: "",
          fullPatchBytes: new TextEncoder().encode(patch).byteLength,
          truncated: false,
        },
      },
    }),
    mutationRevision: GitMutationRevision.make(0),
    notificationPending,
  };
}

function gitPatchPath(
  workingDirectory: string,
  snapshotId: typeof SessionGitSnapshotId.Type,
  section: "staged" | "unstaged",
) {
  return join(
    workingDirectory,
    "sessions",
    SESSION_ID,
    "snapshots",
    `git-snapshot-${snapshotId}-${section}.patch`,
  );
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
    throw new Error(`Expected ${path} not to exist.`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function makeStore(
  workingDirectory: string,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = DenoFileSystem.layer,
): Promise<TestStore> {
  const storeLive = runnerSessionStoreLayer({ workingDirectory, runnerId: RUNNER_ID }).pipe(
    Layer.provideMerge(sessionPersistenceLayer(workingDirectory, fileSystemLayer)),
  );
  return Effect.runPromise(Effect.scoped(Layer.build(storeLive))).then((context) => {
    const journal = Context.get(context, Journal);
    const store = Context.get(context, RunnerSessionStore);
    return { store, session: makeSessionFixture(store, journal, RUNNER_ID) };
  });
}

function sessionPersistenceLayer(
  workingDirectory: string,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = DenoFileSystem.layer,
) {
  const platform = Layer.merge(fileSystemLayer, DenoPath.layer);
  return sessionJournalLayer(workingDirectory).pipe(Layer.provideMerge(platform));
}

function failRemovalAt(target: string): Layer.Layer<FileSystem.FileSystem> {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fileSystem) =>
      FileSystem.FileSystem.of({
        ...fileSystem,
        remove: (path, options) =>
          path === target
            ? fileSystem.remove(`${target}.injected-missing`)
            : fileSystem.remove(path, options),
      })),
  ).pipe(Layer.provide(DenoFileSystem.layer));
}

function observeReadAt(
  target: string,
  observe: () => void,
): Layer.Layer<FileSystem.FileSystem> {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fileSystem) =>
      FileSystem.FileSystem.of({
        ...fileSystem,
        readFile: (path) => {
          if (path === target) observe();
          return fileSystem.readFile(path);
        },
      })),
  ).pipe(Layer.provide(DenoFileSystem.layer));
}
