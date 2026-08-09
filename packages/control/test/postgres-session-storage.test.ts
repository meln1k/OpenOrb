import assert from "node:assert/strict";
import test from "node:test";

import { createTestStore } from "./postgres-test.ts";

const REJECT_REPLACEMENT_CONSTRAINT = "browser_sessions_reject_test_replacement";

test("keeps the old session when session rotation cannot persist its replacement", async () => {
  const store = await createTestStore();

  try {
    const original = await store.sessionStorage.read(null);
    original.set("state", "original");
    const originalId = await store.sessionStorage.save(original);
    assert.ok(originalId);

    const replacement = await store.sessionStorage.read(originalId);
    replacement.regenerateId(true);
    replacement.set("state", "replacement");
    replacement.set("rejectTestReplacement", true);

    await store.pool.query(
      `alter table browser_sessions
       add constraint ${REJECT_REPLACEMENT_CONSTRAINT}
       check ((data -> 0 ->> 'rejectTestReplacement') is null)`,
    );

    await assert.rejects(store.sessionStorage.save(replacement), {
      code: "23514",
      constraint: REJECT_REPLACEMENT_CONSTRAINT,
    });

    const result = await store.pool.query<{ id: string }>(
      "select id from browser_sessions where id = any($1::text[]) order by id",
      [[originalId, replacement.id]],
    );
    assert.deepEqual(result.rows, [{ id: originalId }]);
  } finally {
    await store.pool.query(
      `alter table browser_sessions drop constraint if exists ${REJECT_REPLACEMENT_CONSTRAINT}`,
    );
    await store.close();
  }
});

test("does not recreate a session deleted by a concurrent request", async () => {
  const store = await createTestStore();

  try {
    const original = await store.sessionStorage.read(null);
    original.set("auth", { userId: 1 });
    const originalId = await store.sessionStorage.save(original);
    assert.ok(originalId);

    const logoutRequest = await store.sessionStorage.read(originalId);
    const staleRequest = await store.sessionStorage.read(originalId);

    logoutRequest.destroy();
    assert.equal(await store.sessionStorage.save(logoutRequest), "");

    staleRequest.set("otherState", true);
    assert.equal(await store.sessionStorage.save(staleRequest), "");

    const persisted = await store.pool.query("select id from browser_sessions where id = $1", [
      originalId,
    ]);
    assert.equal(persisted.rowCount, 0);

    const reloaded = await store.sessionStorage.read(originalId);
    assert.equal(reloaded.get("auth"), undefined);
  } finally {
    await store.close();
  }
});

test("removes abandoned expired sessions during the next session write", async () => {
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
    assert.equal(expired.rowCount, 0);
  } finally {
    await store.close();
  }
});
