import { assert, assertEquals, assertNotEquals } from "@std/assert";

import { createTestStore, createTestUser } from "@/test/postgres-test.ts";

Deno.test("always provides one PSK and serializes concurrent regeneration", async () => {
  const store = await createTestStore();

  try {
    const userId = await createTestUser(store);
    const provisioned = await Promise.all(
      Array.from({ length: 8 }, () => store.getRunnerEnrollmentToken(userId)),
    );
    assertEquals(new Set(provisioned.map((token) => token.id)).size, 1);
    assertEquals(new Set(provisioned.map((token) => token.token)).size, 1);

    const regenerated = await Promise.all(
      Array.from({ length: 8 }, () => store.regenerateRunnerEnrollmentToken(userId)),
    );
    assertEquals(new Set(regenerated.map((token) => token.id)).size, 8);
    const current = await store.getRunnerEnrollmentToken(userId);
    assert(regenerated.some((token) => token.id === current.id));
    assertNotEquals(current.id, provisioned[0]!.id);

    const stored = await store.pool.query<{ id: string; revoked_at: string | null }>(
      "select id, revoked_at from runner_enrollment_tokens where user_id = $1",
      [userId],
    );
    assertEquals(stored.rows.length, 9);
    assertEquals(
      stored.rows
        .filter((token: { revoked_at: string | null }) => token.revoked_at === null)
        .map((token: { id: string }) => token.id),
      [current.id],
    );
  } finally {
    await store.close();
  }
});
