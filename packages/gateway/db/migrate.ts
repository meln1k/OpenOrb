import { fromFileUrl } from "@std/path";
import type { Pool } from "pg";
import { loadMigrations } from "remix/data-table/migrations/node";
import { createPostgresDatabase } from "remix/data-table/postgres";

const MIGRATIONS_DIRECTORY = fromFileUrl(new URL("./migrations/", import.meta.url));

export async function migrate(pool: Pool): Promise<void> {
  const database = createPostgresDatabase(pool);
  const migrations = await loadMigrations(MIGRATIONS_DIRECTORY);
  await database.migrate(migrations);
}
