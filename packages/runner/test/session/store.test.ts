import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import {
  GitAuthor,
  ProjectId,
  RunnerId,
  RunnerSessionSnapshot,
  SessionGitSnapshot,
  SessionId,
  UserId,
} from "@openorb/protocol/runner-api";
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
const USER_ID = Schema.decodeUnknownSync(UserId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c12",
);
const CREATED_AT = "2026-08-17T12:00:00Z";
const MODEL = "opencode-go/deepseek-v4-flash";
const GUEST_BUILD_ID = "02e784cb-e063-5138-b1c4-334e8a3307a9";

interface TestStore {
  readonly store: RunnerSessionStore;
  readonly session: SessionFixture;
}

function sessionDefinition(
  initialPrompt = "Inspect the repository",
  orbSize: "small" | "medium" = "small",
): RunnerSessionDefinition {
  return new RunnerSessionDefinition({
    userId: USER_ID,
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
    for (const directory of ["workspace", "pi", "logs", "snapshots", "checkpoints"]) {
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
        lastEventCursor: 0,
      }),
    ]);
    assertEquals(Array.from(manifest.sessions[0]!.initialPromptPreview).length, 200);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("clears untrusted workspace contents without following symlinks", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    await Effect.runPromise(session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    const workspace = join(workingDirectory, "sessions", SESSION_ID, "workspace");
    const hostMarker = join(workingDirectory, "host-marker");
    await Deno.writeTextFile(hostMarker, "keep");
    await Deno.mkdir(join(workspace, "nested"));
    await Deno.writeTextFile(join(workspace, "nested", "guest-file"), "remove");
    await Deno.symlink(hostMarker, join(workspace, "host-marker-link"));

    await Effect.runPromise(store.clearSessionWorkspace(SESSION_ID));

    assertEquals(await Array.fromAsync(Deno.readDir(workspace)), []);
    assertEquals(await Deno.readTextFile(hostMarker), "keep");
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
    assertEquals(invalid.operation, "read-git-snapshot");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("manages checkpoint files without owning checkpoint state transitions", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const { store, session } = await makeStore(workingDirectory);
    await Effect.runPromise(session.create(SESSION_ID, sessionDefinition(), CREATED_AT));
    await Effect.runPromise(session.completeInitialRun(SESSION_ID));

    const candidate = await Effect.runPromise(store.allocateCheckpoint(SESSION_ID));
    assertStringIncludes(candidate.path, join("sessions", SESSION_ID, "checkpoints"));
    assertEquals(
      await Effect.runPromise(store.checkpointExists(SESSION_ID, candidate.file)),
      false,
    );
    await Deno.writeTextFile(candidate.path, "complete checkpoint");
    assertEquals(await Effect.runPromise(store.checkpointExists(SESSION_ID, candidate.file)), true);

    await Effect.runPromise(session.append(SESSION_ID, {
      type: "checkpoint.started",
      file: candidate.file,
    }));
    await Effect.runPromise(store.validateCheckpoint(
      SESSION_ID,
      candidate,
      environmentCheckpoint(candidate.path),
    ));
    await Effect.runPromise(session.append(SESSION_ID, {
      type: "checkpoint.published",
      checkpoint: persistedCheckpoint(candidate.file),
    }));
    assertEquals(
      await Effect.runPromise(store.readCurrentCheckpoint(SESSION_ID)),
      environmentCheckpoint(candidate.path),
    );

    const obsolete = await Effect.runPromise(store.allocateCheckpoint(SESSION_ID));
    await Deno.writeTextFile(obsolete.path, "obsolete");
    await Effect.runPromise(store.cleanupCheckpoints(SESSION_ID, candidate.file));
    assertEquals(await Effect.runPromise(store.checkpointExists(SESSION_ID, candidate.file)), true);
    assertEquals(await Effect.runPromise(store.checkpointExists(SESSION_ID, obsolete.file)), false);

    const invalid = await Effect.runPromise(Effect.flip(
      store.checkpointExists(SESSION_ID, "../checkpoint.qcow2"),
    ));
    assertEquals(invalid.operation, "inspect-checkpoint");
    await Effect.runPromise(store.discardCheckpoint(SESSION_ID, candidate.file));
    assertEquals(
      await Effect.runPromise(store.checkpointExists(SESSION_ID, candidate.file)),
      false,
    );
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
        ["workspace", "source.ts"],
        ["pi", "history.jsonl"],
        ["logs", "runner.log"],
        ["snapshots", "git-snapshot.json"],
        ["checkpoints", "candidate.qcow2"],
      ] as const
    ) {
      await Deno.writeTextFile(join(sessionPath, directory, file), directory);
    }
    await Deno.mkdir(join(sessionPath, "workspace", "nested"));
    await Deno.writeTextFile(join(sessionPath, "workspace", "nested", "file.txt"), "nested");
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
    await Deno.remove(join(queuedPath, "workspace"), { recursive: true });

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

function persistedCheckpoint(file: string) {
  return {
    file,
    guestAssetBuildId: GUEST_BUILD_ID,
    createdWithVmm: "qemu" as const,
    compatibleVmm: ["qemu" as const],
  };
}

function environmentCheckpoint(path: string) {
  return {
    path,
    guestAssetBuildId: GUEST_BUILD_ID,
    createdWithVmm: "qemu" as const,
    compatibleVmm: ["qemu" as const],
  };
}

function assertPrivateMode(mode: number | null, expected: number): void {
  if (Deno.build.os !== "windows" && mode !== null) assertEquals(mode & 0o777, expected);
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
