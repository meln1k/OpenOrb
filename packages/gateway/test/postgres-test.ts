import { v7 } from "@std/uuid";
import { UserId, WorkspaceId } from "@openorb/protocol/runner-api";

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
      "truncate table deleted_sessions, sessions, runners, runner_enrollment_tokens, projects, model_provider_credentials, git_credentials, git_author_configuration, browser_sessions, password_credentials, users, encrypted_secrets, workspaces restart identity",
    );
  }
  return store;
}

export async function createTestWorkspace(store: PostgresStore): Promise<WorkspaceId> {
  const id = WorkspaceId.make(v7.generate());
  await store.pool.query("insert into workspaces (id, created_at) values ($1, $2)", [
    id,
    new Date().toISOString(),
  ]);
  return id;
}

/** Returns the user ID, never the workspace ID. */
export async function createTestUser(
  store: PostgresStore,
  workspaceId?: WorkspaceId,
): Promise<UserId> {
  const result = await store.pool.query<{ id: string }>(
    "insert into users (id, workspace_id, is_administrator, created_at) values ($1, $2, false, $3) returning id",
    [v7.generate(), workspaceId ?? await createTestWorkspace(store), new Date().toISOString()],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Test user was not created.");
  return UserId.make(row.id);
}

export async function getTestUserWorkspaceId(
  store: PostgresStore,
  userId: UserId,
): Promise<WorkspaceId> {
  const result = await store.pool.query<{ workspace_id: string }>(
    "select workspace_id from users where id = $1",
    [userId],
  );
  if (!result.rows[0]) throw new Error("Test user not found.");
  return WorkspaceId.make(result.rows[0].workspace_id);
}
