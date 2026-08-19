import { Pool } from "pg";
import { createPostgresDatabase } from "remix/data-table/postgres";
import type { SessionStorage } from "remix/session";

import { BROWSER_SESSION_MAX_AGE_SECONDS } from "@/app/utils/session-policy.ts";
import {
  type AdministratorRepository,
  createAdministratorRepository,
} from "@/app/data/administrator-repository.ts";
import {
  createGitConfigurationRepository,
  type GitConfigurationRepository,
} from "@/app/data/git-configuration-repository.ts";
import { loadMasterKey, type MasterKey } from "@/app/utils/master-key.ts";
import { createProjectRepository, type ProjectRepository } from "@/app/data/project-repository.ts";
import { createRunnerRepository, type RunnerRepository } from "@/app/data/runner-repository.ts";
import { createSecretRepository, type SecretRepository } from "@/app/data/secret-repository.ts";
import {
  createSessionCatalogRepository,
  type SessionCatalogRepository,
} from "@/app/data/session-catalog-repository.ts";
import { PostgresSessionStorage } from "@/app/data/postgres-session-storage.ts";

export interface Store
  extends
    AdministratorRepository,
    SecretRepository,
    GitConfigurationRepository,
    ProjectRepository,
    RunnerRepository,
    SessionCatalogRepository {
  readonly sessionStorage: SessionStorage;
  close(): Promise<void>;
}

export interface PostgresStore extends Store {
  readonly pool: Pool;
}

export function createPostgresStore(databaseUrl: string, masterKey: MasterKey): PostgresStore {
  const pool = new Pool({ connectionString: databaseUrl });
  const database = createPostgresDatabase(pool);

  return {
    pool,
    ...createAdministratorRepository(database),
    ...createSecretRepository(database, masterKey),
    ...createGitConfigurationRepository(database, masterKey),
    ...createProjectRepository(database),
    ...createRunnerRepository(database),
    ...createSessionCatalogRepository(database),
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
    throw new StoreConfigurationError("DATABASE_URL is required outside tests.");
  }

  // Fails startup visibly when the master key is missing or invalid.
  const masterKey = await loadMasterKey();
  return createPostgresStore(databaseUrl, masterKey);
}

class StoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConfigurationError";
  }
}
