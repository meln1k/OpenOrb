import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "@openorb/result";
import { join } from "node:path";

import type { SessionProvisioningEvent } from "@openorb/protocol";
import { RunnerSessionStore } from "@/src/session-store.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
const CREATED_AT = "2026-08-17T12:00:00Z";
const REPOSITORY_URL = "https://github.com/meln1k/openorb.git";
const REF = "main";
const BRANCH_NAME = "openorb/session-test";

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
    for (const file of ["metadata.json", "events.jsonl", join("pi", "session.jsonl")]) {
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
      state: "error",
      lastEventCursor: 0,
    });
    assertEquals(Array.from(inventory.sessions[0]!.initialPromptPreview).length, 200);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("appends monotonic events and exposes a corrupt final append without guessing", async () => {
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
        createdAt: CREATED_AT,
      }),
    );

    assertEquals(
      (await Promise.all([
        store.appendEvent(SESSION_ID, {
          type: "session.state",
          stage: "created",
          checkoutState: "pending",
        }),
        store.appendEvent(SESSION_ID, {
          type: "provisioning.log",
          stream: "stdout",
          text: "starting",
        }),
      ])).map(success),
      [1, 2],
    );
    const restarted = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
    assertEquals(success(await restarted.readEvents(SESSION_ID)), [
      {
        cursor: 1,
        event: { type: "session.state", stage: "created", checkoutState: "pending" },
      },
      {
        cursor: 2,
        event: { type: "provisioning.log", stream: "stdout", text: "starting" },
      },
    ]);

    await Deno.writeTextFile(
      join(workingDirectory, "sessions", SESSION_ID, "events.jsonl"),
      '{"cursor":3,"event":{"type":"session.state"}',
      { append: true },
    );
    const inventory = success(await restarted.loadInventory());
    assertEquals(inventory.sessions[0]?.state, "error");
    assertEquals(inventory.sessions[0]?.lastEventCursor, 2);
    assertEquals(inventory.errors.length, 1);
    assertStringIncludes(inventory.errors[0]!.message, "final append is incomplete");
    const [, appendError] = await restarted.appendEvent(SESSION_ID, {
      type: "session.state",
      stage: "ready",
      checkoutState: "available",
    });
    assertEquals(appendError?.name, "RunnerSessionStoreError");
    assertEquals(appendError?.operation, "append-event");
    assertStringIncludes(appendError?.message ?? "", "event log is corrupt");
    const [, readError] = await restarted.readEvents(SESSION_ID);
    assertEquals(readError?.name, "RunnerSessionStoreError");
    assertEquals(readError?.operation, "read-events");
    assertStringIncludes(readError?.message ?? "", "event log is corrupt");
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("continues serialized appends after a failed prior append", async () => {
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
        createdAt: CREATED_AT,
      }),
    );

    // SAFETY: This intentionally bypasses the event type to exercise durable schema rejection.
    const failed = store.appendEvent(SESSION_ID, {} as SessionProvisioningEvent);
    const succeeded = store.appendEvent(SESSION_ID, {
      type: "provisioning.log",
      stream: "stdout",
      text: "continued",
    });
    assertEquals((await failed)[1]?.operation, "append-event");
    assertEquals(success(await succeeded), 1);
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
