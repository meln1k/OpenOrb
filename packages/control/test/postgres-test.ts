import { v7 } from "@std/uuid";

import { importMasterKey, type MasterKey } from "@/app/utils/master-key.ts";
import { createPostgresStore, type PostgresStore } from "@/app/data/store.ts";
import { migrate } from "@/db/migrate.ts";

export const testDatabaseUrl = Deno.env.get("OPENORB_TEST_DATABASE_URL") ??
  "postgres://localhost/openorb-test";

/** Deterministic 32-byte test master key: bytes 0x00 through 0x1f. */
export const TEST_MASTER_KEY_BYTES = Uint8Array.from(
  Array.from({ length: 32 }, (_, index) => index),
);
export const TEST_MASTER_KEY_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

export async function createTestStore(
  masterKey?: MasterKey,
  reset = true,
): Promise<PostgresStore> {
  const key = masterKey ?? (await importMasterKey(TEST_MASTER_KEY_BYTES));
  const store = createPostgresStore(testDatabaseUrl, key);
  await migrate(store.pool);
  if (reset) {
    await store.pool.query(
      "truncate table deleted_sessions, sessions, runners, runner_enrollment_tokens, projects, git_credentials, git_author_configuration, browser_sessions, password_credentials, users, encrypted_secrets restart identity",
    );
  }
  return store;
}

export async function createTestUser(store: PostgresStore): Promise<string> {
  const result = await store.pool.query<{ id: string }>(
    "insert into users (id, is_administrator, created_at) values ($1, false, $2) returning id",
    [v7.generate(), new Date().toISOString()],
  );
  return result.rows[0]!.id;
}
