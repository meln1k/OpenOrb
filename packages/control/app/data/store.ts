import { Pool } from "pg";
import { createDatabase } from "remix/data-table";
import { createPostgresDatabaseAdapter } from "remix/data-table/postgres";
import type { SessionStorage } from "remix/session";

import { BROWSER_SESSION_MAX_AGE_SECONDS } from "../session-policy.ts";
import {
  createAdministratorRepository,
  type AdministratorRepository,
} from "./administrator-repository.ts";
import { PostgresSessionStorage } from "./postgres-session-storage.ts";

export interface Store extends AdministratorRepository {
  readonly sessionStorage: SessionStorage;
  close(): Promise<void>;
}

export interface PostgresStore extends Store {
  readonly pool: Pool;
}

export function createPostgresStore(databaseUrl: string): PostgresStore {
  const pool = new Pool({ connectionString: databaseUrl });
  const database = createDatabase(createPostgresDatabaseAdapter(pool));

  return {
    pool,
    ...createAdministratorRepository(database),
    sessionStorage: new PostgresSessionStorage(pool, BROWSER_SESSION_MAX_AGE_SECONDS),
    async close() {
      await pool.end();
    },
  };
}

export function createDefaultStore(): PostgresStore {
  const databaseUrl =
    process.env.DATABASE_URL ??
    (process.env.NODE_ENV === "test" ? "postgres://localhost/openorb-test" : undefined);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required outside tests.");
  }

  return createPostgresStore(databaseUrl);
}
