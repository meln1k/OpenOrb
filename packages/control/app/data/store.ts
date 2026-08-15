import { Pool } from "pg";
import { createDatabase } from "remix/data-table";
import { createPostgresDatabaseAdapter } from "remix/data-table/postgres";
import type { SessionStorage } from "remix/session";

import { BROWSER_SESSION_MAX_AGE_SECONDS } from "../utils/session-policy.ts";
import {
  type AdministratorRepository,
  createAdministratorRepository,
} from "./administrator-repository.ts";
import {
  createGitConfigurationRepository,
  type GitConfigurationRepository,
} from "./git-configuration-repository.ts";
import { loadMasterKey, type MasterKey } from "../utils/master-key.ts";
import { createProjectRepository, type ProjectRepository } from "./project-repository.ts";
import { createRunnerRepository, type RunnerRepository } from "./runner-repository.ts";
import { createSecretRepository, type SecretRepository } from "./secret-repository.ts";
import { PostgresSessionStorage } from "./postgres-session-storage.ts";

export interface Store
  extends
    AdministratorRepository,
    SecretRepository,
    GitConfigurationRepository,
    ProjectRepository,
    RunnerRepository {
  readonly sessionStorage: SessionStorage;
  close(): Promise<void>;
}

export interface PostgresStore extends Store {
  readonly pool: Pool;
}

export function createPostgresStore(databaseUrl: string, masterKey: MasterKey): PostgresStore {
  const pool = new Pool({ connectionString: databaseUrl });
  const database = createDatabase(createPostgresDatabaseAdapter(pool));

  return {
    pool,
    ...createAdministratorRepository(database),
    ...createSecretRepository(database, masterKey),
    ...createGitConfigurationRepository(database, masterKey),
    ...createProjectRepository(database),
    ...createRunnerRepository(database),
    sessionStorage: new PostgresSessionStorage(pool, BROWSER_SESSION_MAX_AGE_SECONDS),
    async close() {
      await pool.end();
    },
  };
}

export async function createDefaultStore(): Promise<PostgresStore> {
  const databaseUrl = Deno.env.get("DATABASE_URL") ??
    (Deno.env.get("NODE_ENV") === "test" ? "postgres://localhost/openorb-test" : undefined);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required outside tests.");
  }

  // Fails startup visibly when the master key is missing or invalid.
  const masterKey = await loadMasterKey();
  return createPostgresStore(databaseUrl, masterKey);
}
