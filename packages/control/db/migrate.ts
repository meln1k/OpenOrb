import { fileURLToPath } from "node:url";
import * as path from "node:path";

import type { Pool } from "pg";
import { createPostgresDatabaseAdapter } from "remix/data-table/postgres";
import { createMigrationRunner } from "remix/data-table/migrations";
import { loadMigrations } from "remix/data-table/migrations/node";

const MIGRATIONS_PATH = fileURLToPath(new URL("./migrations", import.meta.url));

export async function migrate(pool: Pool): Promise<void> {
  const adapter = createPostgresDatabaseAdapter(pool);
  const migrations = await loadMigrations(path.resolve(MIGRATIONS_PATH));
  const runner = createMigrationRunner(adapter, migrations);
  await runner.up();
}
