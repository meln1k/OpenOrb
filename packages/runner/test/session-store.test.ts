import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Result } from "@openorb/result";
import { join } from "node:path";

import { RunnerSessionStore } from "@/src/session-store.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
const CREATED_AT = "2026-08-17T12:00:00Z";
const REPOSITORY_URL = "https://github.com/meln1k/openorb.git";
const REF = "main";
const BRANCH_NAME = "openorb/session-test";
const MODEL = "opencode-go/deepseek-v4-flash";

Deno.test("creates private runner session files and atomically reloads metadata", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
    const prompt = `  inspect\n\tthis   ${"😀".repeat(205)}  `;
    const metadata = success(
      await store.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        repositoryUrl: REPOSITORY_URL,
        ref: REF,
        branchName: BRANCH_NAME,
        initialPrompt: prompt,
        model: MODEL,
        createdAt: CREATED_AT,
      }),
    );
    assertEquals(metadata.state, "created");

    const sessionPath = join(workingDirectory, "sessions", SESSION_ID);
    for (const directory of ["workspace", "pi", "logs", "reports"]) {
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
    const restarted = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
    assertEquals(success(await restarted.readMetadata(SESSION_ID)), metadata);
    assertEquals(success(await restarted.updateSessionState(SESSION_ID, "error")).state, "error");
    assertEquals(success(await restarted.readMetadata(SESSION_ID)).state, "error");

    const inventory = success(await restarted.loadInventory());
    assertEquals(inventory.errors, []);
    assertEquals(inventory.sessions.length, 1);
    assertEquals(inventory.sessions[0], {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      createdAt: CREATED_AT,
      initialPromptPreview: `inspect this ${"😀".repeat(187)}`,
      model: MODEL,
      state: "error",
      lastEventCursor: 0,
    });
    assertEquals(Array.from(inventory.sessions[0]!.initialPromptPreview).length, 200);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("derives replay cursors using Pi's JSONL parsing semantics", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
    success(
      await store.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        repositoryUrl: REPOSITORY_URL,
        ref: REF,
        branchName: BRANCH_NAME,
        initialPrompt: "Inspect the repository",
        model: MODEL,
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

    assertEquals(success(await store.getSessionSnapshot(SESSION_ID)).lastEventCursor, 4);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(workingDirectory + "/sessions/" + SESSION_ID))).some(
        (entry) => entry.name === "events.jsonl",
      ),
      false,
    );

    await Deno.writeTextFile(sessionFile, "{", { append: true });
    const inventory = success(await store.loadInventory());
    assertEquals(inventory.sessions[0]?.state, "created");
    assertEquals(inventory.sessions[0]?.lastEventCursor, 4);
    assertEquals(inventory.errors, []);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("returns inventory-root access failures as the outer Result error", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(workingDirectory, "sessions"), "not a directory");
    const store = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
    const [inventory, error] = await store.loadInventory();
    assertEquals(inventory, undefined);
    assertEquals(error?.name, "RunnerSessionStoreError");
    assertEquals(error?.operation, "load-inventory");
    assertStringIncludes(error?.message ?? "", "inventory root");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

function assertPrivateMode(mode: number | null, expected: number): void {
  if (Deno.build.os !== "windows" && mode !== null) assertEquals(mode & 0o777, expected);
}

function success<T, E>(result: Result<T, E>): T {
  const [value, error] = result;
  assertEquals(error, undefined);
  assert(value !== undefined);
  return value;
}
