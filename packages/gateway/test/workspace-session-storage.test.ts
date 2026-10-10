import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { activate, createAppServices, createWorkspace } from "@/test/workspace-test.ts";

Deno.test("failed session rotation rolls back deletion of the original", async () => {
  const { workspace, storage } = activate();
  const sessions = createAppServices(workspace).sessionStorage;
  const original = await sessions.read(null);
  original.set("state", "original");
  const originalId = await sessions.save(original);
  assert(originalId);
  const originalRecord = await workspace.readBrowserSession(originalId);
  assert(originalRecord);
  const replacement = await sessions.read(originalId);
  replacement.regenerateId(true);
  replacement.set("state", "replacement");
  // Abort only after rotation has deleted the sole original row, not before deletion.
  storage.sql.exec(`CREATE TRIGGER reject_browser_replacement BEFORE INSERT ON browser_sessions
    WHEN NOT EXISTS (SELECT 1 FROM browser_sessions)
    BEGIN SELECT RAISE(ABORT, 'replacement write failed'); END;`);
  await assertRejects(() => sessions.save(replacement), Error, "replacement write failed");
  assertEquals((await sessions.read(originalId)).get("state"), "original");
  assertEquals(await activate(storage).workspace.readBrowserSession(originalId), originalRecord);
  assertEquals(await workspace.readBrowserSession(replacement.id), null);
  assertEquals(storage.rows("SELECT id FROM browser_sessions"), [{ id: originalId }]);
});

Deno.test("Workspace sessions rotate identity and never resurrect after logout or expiry", async () => {
  const { workspace, storage, administrator } = await createWorkspace();
  const sessions = createAppServices(workspace).sessionStorage;
  const original = await sessions.read(null);
  original.set("state", "before login");
  const originalId = await sessions.save(original);
  assert(originalId);
  const anonymous = await workspace.readBrowserSession(originalId);
  assert(anonymous);
  assertEquals([anonymous.userId, anonymous.workspaceId], [null, null]);
  const stale = await sessions.read(originalId);
  const login = await sessions.read(originalId);
  login.regenerateId(true);
  login.set("auth", administrator);
  const loginId = await sessions.save(login);
  assert(loginId);
  assertNotEquals(loginId, originalId);
  const record = await workspace.readBrowserSession(loginId);
  assert(record);
  assertEquals([record.userId, record.workspaceId], [
    administrator.userId,
    administrator.workspaceId,
  ]);
  assertEquals((await sessions.read(loginId)).get("auth"), administrator);
  stale.set("state", "stale update");
  assertEquals(await sessions.save(stale), "");
  stale.regenerateId(true);
  assertEquals(await sessions.save(stale), "");

  const logout = await sessions.read(loginId);
  const staleAuthenticated = await sessions.read(loginId);
  logout.destroy();
  assertEquals(await sessions.save(logout), "");
  staleAuthenticated.set("otherState", true);
  assertEquals(await sessions.save(staleAuthenticated), "");
  staleAuthenticated.regenerateId(true);
  assertEquals(await sessions.save(staleAuthenticated), "");
  assertEquals(await activate(storage).workspace.readBrowserSession(loginId), null);
  assertEquals(storage.rows("SELECT id FROM browser_sessions"), []);

  const expiring = await sessions.read(null);
  expiring.set("auth", administrator);
  const expiringId = await sessions.save(expiring);
  assert(expiringId);
  const expiredRotation = await sessions.read(expiringId);
  const expired = await workspace.readBrowserSession(expiringId);
  assert(expired);
  storage.sql.exec(
    "UPDATE browser_sessions SET expiresAt = ? WHERE id = ?",
    Date.now() - 1,
    expiringId,
  );
  expiredRotation.regenerateId(true);
  assertEquals(await sessions.save(expiredRotation), "");
  assertEquals(await workspace.readBrowserSession(expiringId), null);
  assertEquals(storage.rows("SELECT id FROM browser_sessions"), []);
});

Deno.test("Workspace rejects malformed, foreign, and mismatched browser identities without changing stored identity", async () => {
  const { workspace, storage, administrator } = await createWorkspace();
  const foreign = await createWorkspace();
  const sessions = createAppServices(workspace).sessionStorage;
  for (
    const auth of [
      { userId: administrator.userId },
      { userId: "not-a-uuid", workspaceId: administrator.workspaceId },
      foreign.administrator,
      { ...administrator, workspaceId: foreign.workspaceId },
      { ...foreign.administrator, workspaceId: administrator.workspaceId },
    ]
  ) {
    const session = await sessions.read(null);
    session.set("auth", auth);
    await assertRejects(() => sessions.save(session));
    assertEquals(await workspace.readBrowserSession(session.id), null);
  }
  const session = await sessions.read(null);
  session.set("auth", administrator);
  const id = await sessions.save(session);
  assert(id);
  const loaded = await sessions.read(id);
  loaded.set("auth", foreign.administrator);
  await assertRejects(() => sessions.save(loaded));
  assertEquals((await sessions.read(id)).get("auth"), administrator);
  loaded.unset("auth");
  assertEquals(await sessions.save(loaded), "");
  assertEquals((await sessions.read(id)).get("auth"), administrator);
  assertEquals(storage.rows("SELECT id FROM browser_sessions"), [{ id }]);
});

Deno.test("Workspace removes abandoned expired browser sessions on the next write", async () => {
  const { workspace, storage } = activate();
  await workspace.health();
  storage.sql.exec(
    `INSERT INTO browser_sessions (id, data, userId, workspaceId, expiresAt)
    VALUES (?, ?, NULL, NULL, ?)`,
    "abandoned",
    JSON.stringify([{}, {}]),
    Date.now() - 1,
  );
  const sessions = createAppServices(workspace).sessionStorage;
  const current = await sessions.read(null);
  current.set("state", "current");
  const id = await sessions.save(current);
  assert(id);
  assertEquals(storage.rows("SELECT id FROM browser_sessions WHERE id = ?", "abandoned"), []);
  assertEquals((await sessions.read(id)).get("state"), "current");
});
