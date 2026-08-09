import { createPostgresStore, type PostgresStore } from "../app/data/store.ts";
import { migrate } from "../db/migrate.ts";

export const testDatabaseUrl = Deno.env.get("OPENORB_TEST_DATABASE_URL") ??
  "postgres://localhost/openorb-test";

export async function createTestStore(): Promise<PostgresStore> {
  const store = createPostgresStore(testDatabaseUrl);
  await migrate(store.pool);
  await store.pool.query("truncate table browser_sessions, password_credentials, users");
  return store;
}
