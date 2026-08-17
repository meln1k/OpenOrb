import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "node:path";

import { RunnerSessionStore } from "@/src/session-store.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
const CREATED_AT = "2026-08-17T12:00:00Z";

Deno.test("creates private runner session files and atomically reloads metadata", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
    const prompt = `  inspect\n\tthis   ${"😀".repeat(205)}  `;
    const metadata = await store.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      initialPrompt: prompt,
      createdAt: CREATED_AT,
    });
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
    assertEquals(await restarted.readMetadata(SESSION_ID), metadata);
    assertEquals((await restarted.updateSessionState(SESSION_ID, "error")).state, "error");
    assertEquals((await restarted.readMetadata(SESSION_ID)).state, "error");

    const inventory = await restarted.loadInventory();
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
    await store.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      initialPrompt: "Inspect the repository",
      createdAt: CREATED_AT,
    });

    assertEquals(
      await Promise.all([
        store.appendEvent(SESSION_ID, { type: "session.state", state: "created" }),
        store.appendEvent(SESSION_ID, { type: "provisioning.log", text: "starting" }),
      ]),
      [1, 2],
    );
    const restarted = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
    assertEquals(await restarted.readEvents(SESSION_ID), [
      { cursor: 1, event: { type: "session.state", state: "created" } },
      { cursor: 2, event: { type: "provisioning.log", text: "starting" } },
    ]);

    await Deno.writeTextFile(
      join(workingDirectory, "sessions", SESSION_ID, "events.jsonl"),
      '{"cursor":3,"event":{"type":"session.state"}',
      { append: true },
    );
    const inventory = await restarted.loadInventory();
    assertEquals(inventory.sessions[0]?.state, "error");
    assertEquals(inventory.sessions[0]?.lastEventCursor, 2);
    assertEquals(inventory.errors.length, 1);
    assertStringIncludes(inventory.errors[0]!.message, "final append is incomplete");
    await assertRejects(
      () => restarted.appendEvent(SESSION_ID, { type: "session.state", state: "ready" }),
      Error,
      "event log is corrupt",
    );
    await assertRejects(
      () => restarted.readEvents(SESSION_ID),
      Error,
      "event log is corrupt",
    );
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

function assertPrivateMode(mode: number | null, expected: number): void {
  if (Deno.build.os !== "windows" && mode !== null) assertEquals(mode & 0o777, expected);
}
