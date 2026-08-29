import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import {
  ProjectId,
  RunnerSessionSnapshot,
  SessionGitSnapshot,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Effect, Schema } from "effect";
import { join } from "node:path";

import { makeRunnerSessionStore } from "@/src/session/store.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c11",
);
const CREATED_AT = "2026-08-17T12:00:00Z";
const REPOSITORY_URL = "https://github.com/meln1k/openorb.git";
const REF = "main";
const BRANCH_NAME = "openorb/session-test";
const MODEL = "opencode-go/deepseek-v4-flash";

Deno.test("creates private runner session files and atomically reloads metadata", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    const prompt = `  inspect\n\tthis   ${"😀".repeat(205)}  `;
    const metadata = await Effect.runPromise(
      store.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        repositoryUrl: REPOSITORY_URL,
        ref: REF,
        branchName: BRANCH_NAME,
        initialPrompt: prompt,
        model: MODEL,
        orbSize: "small",
        createdAt: CREATED_AT,
      }),
    );
    assertEquals(metadata.state, "created");
    assertEquals(metadata.orbSize, "small");

    const sessionPath = join(workingDirectory, "sessions", SESSION_ID);
    for (const directory of ["workspace", "pi", "logs", "snapshots"]) {
      const info = await Deno.lstat(join(sessionPath, directory));
      assert(info.isDirectory);
      assertEquals(info.isSymlink, false);
      assertPrivateMode(info.mode, 0o700);
    }
    for (const file of ["metadata.json", join("pi", "session.jsonl")]) {
      const info = await Deno.lstat(join(sessionPath, file));
      assert(info.isFile);
      assertEquals(info.isSymlink, false);
      assertPrivateMode(info.mode, 0o600);
    }

    await Deno.writeTextFile(join(sessionPath, "metadata.json.interrupted.tmp"), "{");
    const restarted = await makeStore(workingDirectory);
    assertEquals(await Effect.runPromise(restarted.readMetadata(SESSION_ID)), metadata);
    assertEquals(
      (await Effect.runPromise(restarted.updateSessionState(SESSION_ID, "error"))).state,
      "error",
    );
    assertEquals((await Effect.runPromise(restarted.readMetadata(SESSION_ID))).state, "error");
    const duplicateError = await Effect.runPromise(Effect.flip(restarted.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      repositoryUrl: REPOSITORY_URL,
      ref: REF,
      branchName: BRANCH_NAME,
      initialPrompt: "Duplicate session",
      model: MODEL,
      orbSize: "small",
      createdAt: CREATED_AT,
    })));
    assertEquals(duplicateError._tag, "RunnerSessionAlreadyExists");
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

Deno.test("derives replay cursors using Pi's JSONL parsing semantics", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(
      store.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        repositoryUrl: REPOSITORY_URL,
        ref: REF,
        branchName: BRANCH_NAME,
        initialPrompt: "Inspect the repository",
        model: MODEL,
        orbSize: "medium",
        createdAt: CREATED_AT,
      }),
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
    await Effect.runPromise(store.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      repositoryUrl: REPOSITORY_URL,
      ref: REF,
      branchName: BRANCH_NAME,
      initialPrompt: "Inspect the repository",
      model: MODEL,
      orbSize: "small",
      createdAt: CREATED_AT,
    }));
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

Deno.test("strictly validates persisted session metadata", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await makeStore(workingDirectory);
    await Effect.runPromise(
      store.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        repositoryUrl: REPOSITORY_URL,
        ref: REF,
        branchName: BRANCH_NAME,
        initialPrompt: "Inspect the repository",
        model: MODEL,
        orbSize: "small",
        createdAt: CREATED_AT,
      }),
    );
    const metadataPath = join(workingDirectory, "sessions", SESSION_ID, "metadata.json");
    const metadata = await Effect.runPromise(
      store.readMetadata(SESSION_ID),
    );
    const { orbSize: _orbSize, ...missingOrbSize } = metadata;
    await Deno.writeTextFile(metadataPath, `${JSON.stringify(missingOrbSize)}\n`);

    const missingFieldError = await Effect.runPromise(Effect.flip(store.readMetadata(SESSION_ID)));
    assertEquals(missingFieldError._tag, "RunnerSessionStoreFailure");
    if (missingFieldError._tag !== "RunnerSessionStoreFailure") throw missingFieldError;
    assertEquals(missingFieldError.operation, "read-metadata");

    await Deno.writeTextFile(
      metadataPath,
      `${JSON.stringify({ ...metadata, unexpected: true })}\n`,
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

function makeStore(workingDirectory: string) {
  return Effect.runPromise(
    makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
      Effect.provide(DenoFileSystem.layer),
    ),
  );
}
