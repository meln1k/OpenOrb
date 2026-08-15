import { assert, assertEquals, assertRejects } from "@std/assert";

import { createTestStore, createTestUser } from "@/test/postgres-test.ts";

const REJECT_REPLACEMENT_CONSTRAINT = "browser_sessions_reject_test_replacement";

Deno.test("keeps the old session when session rotation cannot persist its replacement", async () => {
  const store = await createTestStore();

  try {
    const original = await store.sessionStorage.read(null);
    original.set("state", "original");
    const originalId = await store.sessionStorage.save(original);
    assert(originalId);

    const replacement = await store.sessionStorage.read(originalId);
    replacement.regenerateId(true);
    replacement.set("state", "replacement");
    replacement.set("rejectTestReplacement", true);

    await store.pool.query(
      `alter table browser_sessions
       add constraint ${REJECT_REPLACEMENT_CONSTRAINT}
       check ((data -> 0 ->> 'rejectTestReplacement') is null)`,
    );

    const error = await assertRejects(() => store.sessionStorage.save(replacement));
    assertEquals((error as { code?: unknown }).code, "23514");
    assertEquals(
      (error as { constraint?: unknown }).constraint,
      REJECT_REPLACEMENT_CONSTRAINT,
    );

    const result = await store.pool.query<{ id: string }>(
      "select id from browser_sessions where id = any($1::text[]) order by id",
      [[originalId, replacement.id]],
    );
    assertEquals(result.rows, [{ id: originalId }]);
  } finally {
    await store.pool.query(
      `alter table browser_sessions drop constraint if exists ${REJECT_REPLACEMENT_CONSTRAINT}`,
    );
    await store.close();
  }
});

Deno.test("does not recreate a session deleted by a concurrent request", async () => {
  const store = await createTestStore();

  try {
    const userId = await createTestUser(store);
    const original = await store.sessionStorage.read(null);
    original.set("auth", { userId });
    const originalId = await store.sessionStorage.save(original);
    assert(originalId);

    const logoutRequest = await store.sessionStorage.read(originalId);
    const staleRequest = await store.sessionStorage.read(originalId);

    logoutRequest.destroy();
    assertEquals(await store.sessionStorage.save(logoutRequest), "");

    staleRequest.set("otherState", true);
    assertEquals(await store.sessionStorage.save(staleRequest), "");

    const persisted = await store.pool.query(
      "select id from browser_sessions where id = $1",
      [originalId],
    );
    assertEquals(persisted.rowCount, 0);

    const reloaded = await store.sessionStorage.read(originalId);
    assertEquals(reloaded.get("auth"), undefined);
  } finally {
    await store.close();
  }
});

Deno.test("binds authenticated session data to its persisted user owner", async () => {
  const store = await createTestStore();

  try {
    const userId = await createTestUser(store);
    const currentSession = await store.sessionStorage.read(null);
    currentSession.set("auth", { userId });
    const sessionId = await store.sessionStorage.save(currentSession);
    assert(sessionId);

    const persisted = await store.pool.query<{ user_id: string }>(
      "select user_id from browser_sessions where id = $1",
      [sessionId],
    );
    assertEquals(persisted.rows, [{ user_id: userId }]);

    await store.pool.query(
      "update browser_sessions set user_id = null where id = $1",
      [sessionId],
    );
    const rejected = await store.sessionStorage.read(sessionId);
    assertEquals(rejected.get("auth"), undefined);
    assertEquals(
      (await store.pool.query("select id from browser_sessions where id = $1", [sessionId]))
        .rowCount,
      0,
    );
  } finally {
    await store.close();
  }
});

Deno.test("rejects invalid authentication instead of treating it as anonymous", async () => {
  const store = await createTestStore();

  try {
    const currentSession = await store.sessionStorage.read(null);
    currentSession.set("auth", { userId: "1770199d-f6b8-4bd8-851f-7bcffc1bb7f8" });
    await assertRejects(
      () => store.sessionStorage.save(currentSession),
      Error,
      "Cannot persist malformed browser session authentication.",
    );
    assertEquals(
      (await store.pool.query("select id from browser_sessions where id = $1", [currentSession.id]))
        .rowCount,
      0,
    );

    await store.pool.query(
      `insert into browser_sessions (id, user_id, data, expires_at, created_at, updated_at)
       values ('malformed-auth-session', null,
         '[{"auth":{"userId":"not-a-uuid"}}, {}]'::jsonb,
         now() + interval '1 hour', now(), now())`,
    );
    const rejected = await store.sessionStorage.read("malformed-auth-session");
    assertEquals(rejected.get("auth"), undefined);
    assertEquals(
      (await store.pool.query(
        "select id from browser_sessions where id = 'malformed-auth-session'",
      )).rowCount,
      0,
    );
  } finally {
    await store.close();
  }
});

Deno.test("does not reassign an existing browser session to another user", async () => {
  const store = await createTestStore();

  try {
    const firstUserId = await createTestUser(store);
    const secondUserId = await createTestUser(store);
    const currentSession = await store.sessionStorage.read(null);
    currentSession.set("auth", { userId: firstUserId });
    const sessionId = await store.sessionStorage.save(currentSession);
    assert(sessionId);

    const loaded = await store.sessionStorage.read(sessionId);
    loaded.set("auth", { userId: secondUserId });
    assertEquals(await store.sessionStorage.save(loaded), "");

    const persisted = await store.pool.query<{ user_id: string; data: unknown }>(
      "select user_id, data from browser_sessions where id = $1",
      [sessionId],
    );
    assertEquals(persisted.rows[0]?.user_id, firstUserId);
    assertEquals(persisted.rows[0]?.data, [{ auth: { userId: firstUserId } }, {}]);
  } finally {
    await store.close();
  }
});

Deno.test("removes abandoned expired sessions during the next session write", async () => {
  const store = await createTestStore();

  try {
    await store.pool.query(
      `insert into browser_sessions (id, data, expires_at, created_at, updated_at)
       values ('abandoned-expired-session', '[{}, {}]'::jsonb, now() - interval '1 day', now(), now())`,
    );

    const currentSession = await store.sessionStorage.read(null);
    currentSession.set("state", "current");
    await store.sessionStorage.save(currentSession);

    const expired = await store.pool.query(
      "select id from browser_sessions where id = 'abandoned-expired-session'",
    );
    assertEquals(expired.rowCount, 0);
  } finally {
    await store.close();
  }
});
