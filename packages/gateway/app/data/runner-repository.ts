import { ENROLLMENT_PSK_PREFIX, RUNNER_TOKEN_PREFIX } from "@openorb/protocol";
import type { RunnerArchitecture, RunnerEnrollmentRequest } from "@openorb/protocol";
import { WorkspaceId } from "@openorb/protocol/runner-api";
import type { Database } from "remix/data-table";
import { v7 } from "@std/uuid";

import { generateRunnerSecret, hashRunnerSecret } from "@/app/utils/runner-token.ts";
import {
  type RunnerEnrollmentTokenRow,
  runnerEnrollmentTokens,
  type RunnerRow,
  runners,
} from "@/app/data/schema.ts";

export interface RunnerEnrollmentToken {
  id: string;
  token: string;
  createdAt: Temporal.Instant;
}

export interface RunnerRecord {
  id: string;
  name: string;
  architecture: RunnerArchitecture;
  createdAt: Temporal.Instant;
  revokedAt: Temporal.Instant | null;
}

export interface AuthenticatedRunner {
  id: string;
  workspaceId: WorkspaceId;
}

export interface EnrolledRunner {
  runnerId: string;
  runnerToken: string;
}

export type RevokeResult = "revoked" | "not-found";
export type DeleteRunnerResult = "deleted" | "not-found" | "not-revoked";

export interface RunnerRepository {
  getRunnerEnrollmentToken(workspaceId: WorkspaceId): Promise<RunnerEnrollmentToken>;
  regenerateRunnerEnrollmentToken(workspaceId: WorkspaceId): Promise<RunnerEnrollmentToken>;
  enrollRunner(input: RunnerEnrollmentRequest): Promise<EnrolledRunner | null>;
  authenticateRunner(token: string): Promise<AuthenticatedRunner | null>;
  listRunners(workspaceId: WorkspaceId): Promise<RunnerRecord[]>;
  revokeRunner(workspaceId: WorkspaceId, id: string): Promise<RevokeResult>;
  deleteRunner(workspaceId: WorkspaceId, id: string): Promise<DeleteRunnerResult>;
}

export function createRunnerRepository(database: Database): RunnerRepository {
  return {
    async getRunnerEnrollmentToken(workspaceId) {
      return await database.transaction(async (transaction) => {
        await lockEnrollmentTokenOwner(transaction, workspaceId);
        const active = await findActiveEnrollmentToken(transaction, workspaceId);
        if (active) return mapEnrollmentToken(active);
        return await createEnrollmentToken(transaction, workspaceId);
      });
    },

    async regenerateRunnerEnrollmentToken(workspaceId) {
      return await database.transaction(async (transaction) => {
        await lockEnrollmentTokenOwner(transaction, workspaceId);
        const active = await findActiveEnrollmentToken(transaction, workspaceId);
        if (active) await revokeEnrollmentToken(transaction, active);
        return await createEnrollmentToken(transaction, workspaceId);
      });
    },

    async enrollRunner(input) {
      const tokenHash = await hashRunnerSecret(input.enrollmentPsk);
      const candidate = await database.findOne(runnerEnrollmentTokens, {
        where: { token_hash: tokenHash },
      });
      if (!candidate || candidate.revoked_at !== null) return null;
      const workspaceId = WorkspaceId.make(candidate.workspace_id);

      return await database.transaction(async (transaction) => {
        await lockEnrollmentTokenOwner(transaction, workspaceId);
        const enrollmentToken = await transaction.findOne(runnerEnrollmentTokens, {
          where: { id: candidate.id, workspace_id: workspaceId, token_hash: tokenHash },
        });
        if (!enrollmentToken || enrollmentToken.revoked_at !== null) return null;

        const runnerToken = generateRunnerSecret(RUNNER_TOKEN_PREFIX);
        const row: RunnerRow = {
          id: v7.generate(),
          workspace_id: enrollmentToken.workspace_id,
          enrollment_token_id: enrollmentToken.id,
          name: input.name.trim(),
          architecture: input.architecture,
          token_hash: await hashRunnerSecret(runnerToken),
          created_at: Temporal.Now.instant().toString(),
          revoked_at: null,
        };
        await transaction.create(runners, row);
        return { runnerId: row.id, runnerToken };
      });
    },

    async authenticateRunner(token) {
      const row = await database.findOne(runners, {
        where: { token_hash: await hashRunnerSecret(token) },
      });
      return row && row.revoked_at === null ? mapAuthenticatedRunner(row) : null;
    },

    async listRunners(workspaceId) {
      const rows = await database.findMany(runners, {
        where: { workspace_id: workspaceId },
        orderBy: ["created_at", "desc"],
      });
      return rows.map(mapRunner);
    },

    async revokeRunner(workspaceId, id) {
      const row = await database.findOne(runners, { where: { id, workspace_id: workspaceId } });
      if (!row) return "not-found";
      if (row.revoked_at === null) {
        await database.update(runners, row.id, {
          revoked_at: Temporal.Now.instant().toString(),
        });
      }
      return "revoked";
    },

    async deleteRunner(workspaceId, id) {
      const row = await database.findOne(runners, { where: { id, workspace_id: workspaceId } });
      if (!row) return "not-found";
      if (row.revoked_at === null) return "not-revoked";
      return (await database.delete(runners, row.id)) ? "deleted" : "not-found";
    },
  };
}

async function lockEnrollmentTokenOwner(
  database: Database,
  workspaceId: WorkspaceId,
): Promise<void> {
  await database.exec("select id from workspaces where id = $1 for update", [workspaceId]);
}

async function findActiveEnrollmentToken(
  database: Database,
  workspaceId: WorkspaceId,
): Promise<RunnerEnrollmentTokenRow | undefined> {
  const rows = await database.findMany(runnerEnrollmentTokens, {
    where: { workspace_id: workspaceId },
  });
  return rows.find((row) => row.revoked_at === null);
}

async function createEnrollmentToken(
  database: Database,
  workspaceId: WorkspaceId,
): Promise<RunnerEnrollmentToken> {
  const token = generateRunnerSecret(ENROLLMENT_PSK_PREFIX);
  const row: RunnerEnrollmentTokenRow = {
    id: v7.generate(),
    workspace_id: workspaceId,
    token,
    token_hash: await hashRunnerSecret(token),
    created_at: Temporal.Now.instant().toString(),
    revoked_at: null,
  };
  await database.create(runnerEnrollmentTokens, row);
  return mapEnrollmentToken(row);
}

async function revokeEnrollmentToken(
  database: Database,
  row: RunnerEnrollmentTokenRow,
): Promise<void> {
  await database.update(runnerEnrollmentTokens, row.id, {
    revoked_at: Temporal.Now.instant().toString(),
  });
}

function mapEnrollmentToken(row: RunnerEnrollmentTokenRow): RunnerEnrollmentToken {
  return {
    id: row.id,
    token: row.token,
    createdAt: Temporal.Instant.from(row.created_at),
  };
}

function mapRunner(row: RunnerRow): RunnerRecord {
  if (row.architecture !== "x64" && row.architecture !== "arm64") {
    throw new RunnerPersistenceIntegrityError(
      `Runner ${row.id} has an invalid stored architecture.`,
    );
  }
  return {
    id: row.id,
    name: row.name,
    architecture: row.architecture,
    createdAt: Temporal.Instant.from(row.created_at),
    revokedAt: row.revoked_at === null ? null : Temporal.Instant.from(row.revoked_at),
  };
}

function mapAuthenticatedRunner(row: RunnerRow): AuthenticatedRunner {
  return { id: row.id, workspaceId: WorkspaceId.make(row.workspace_id) };
}

class RunnerPersistenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerPersistenceIntegrityError";
  }
}
