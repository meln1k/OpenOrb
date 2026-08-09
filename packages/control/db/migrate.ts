import { fromFileUrl } from "@std/path";
import type { Pool } from "pg";
import { createMigrationRunner } from "remix/data-table/migrations";
import { loadMigrations } from "remix/data-table/migrations/node";
import { createPostgresDatabaseAdapter } from "remix/data-table/postgres";

const MIGRATIONS_DIRECTORY = fromFileUrl(new URL("./migrations/", import.meta.url));

export async function migrate(pool: Pool): Promise<void> {
  const adapter = createPostgresDatabaseAdapter(pool);
  const migrations = await loadMigrations(MIGRATIONS_DIRECTORY);
  const runner = createMigrationRunner(adapter, migrations);
  await runner.up();
}
