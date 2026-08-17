import { ENROLLMENT_PSK_PREFIX, RUNNER_TOKEN_PREFIX } from "@openorb/protocol";
import type { RunnerArchitecture, RunnerEnrollmentRequest } from "@openorb/protocol";
import { array, parseSafe, string } from "remix/data-schema";
import type { Database } from "remix/data-table";
import { v7 } from "@std/uuid";

import { generateRunnerSecret, hashRunnerSecret } from "@/app/utils/runner-token.ts";
import {
  type RunnerEnrollmentTokenRow,
  runnerEnrollmentTokens,
  type RunnerRow,
  runners,
} from "@/app/data/schema.ts";

const runnerCapabilitiesSchema = array(string());

export interface RunnerEnrollmentToken {
  id: string;
  token: string;
  createdAt: Temporal.Instant;
}

export interface RunnerRecord {
  id: string;
  name: string;
  architecture: RunnerArchitecture;
  capabilities: string[];
  createdAt: Temporal.Instant;
  revokedAt: Temporal.Instant | null;
}

export interface AuthenticatedRunner {
  id: string;
  userId: string;
}

export interface EnrolledRunner {
  runnerId: string;
  runnerToken: string;
}

export type RevokeResult = "revoked" | "not-found";
export type DeleteRunnerResult = "deleted" | "not-found" | "not-revoked";

export interface RunnerRepository {
  getRunnerEnrollmentToken(userId: string): Promise<RunnerEnrollmentToken>;
  regenerateRunnerEnrollmentToken(userId: string): Promise<RunnerEnrollmentToken>;
  enrollRunner(input: RunnerEnrollmentRequest): Promise<EnrolledRunner | null>;
  authenticateRunner(token: string): Promise<AuthenticatedRunner | null>;
  listRunners(userId: string): Promise<RunnerRecord[]>;
  revokeRunner(userId: string, id: string): Promise<RevokeResult>;
  deleteRunner(userId: string, id: string): Promise<DeleteRunnerResult>;
}

export function createRunnerRepository(database: Database): RunnerRepository {
  return {
    async getRunnerEnrollmentToken(userId) {
      return await database.transaction(async (transaction) => {
        await lockEnrollmentTokenOwner(transaction, userId);
        const active = await findActiveEnrollmentToken(transaction, userId);
        if (active?.token) return mapEnrollmentToken(active);

        if (active) await revokeEnrollmentToken(transaction, active);
        return await createEnrollmentToken(transaction, userId);
      });
    },

    async regenerateRunnerEnrollmentToken(userId) {
      return await database.transaction(async (transaction) => {
        await lockEnrollmentTokenOwner(transaction, userId);
        const active = await findActiveEnrollmentToken(transaction, userId);
        if (active) await revokeEnrollmentToken(transaction, active);
        return await createEnrollmentToken(transaction, userId);
      });
    },

    async enrollRunner(input) {
      const tokenHash = await hashRunnerSecret(input.enrollmentPsk);
      const candidate = await database.findOne(runnerEnrollmentTokens, {
        where: { token_hash: tokenHash },
      });
      if (!candidate || candidate.revoked_at !== null) return null;

      return await database.transaction(async (transaction) => {
        await lockEnrollmentTokenOwner(transaction, candidate.user_id);
        const enrollmentToken = await transaction.findOne(runnerEnrollmentTokens, {
          where: { id: candidate.id, user_id: candidate.user_id, token_hash: tokenHash },
        });
        if (!enrollmentToken || enrollmentToken.revoked_at !== null) return null;

        const runnerToken = generateRunnerSecret(RUNNER_TOKEN_PREFIX);
        const row: RunnerRow = {
          id: v7.generate(),
          user_id: enrollmentToken.user_id,
          enrollment_token_id: enrollmentToken.id,
          name: input.name.trim(),
          architecture: input.architecture,
          capabilities: JSON.stringify(input.capabilities),
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

    async listRunners(userId) {
      const rows = await database.findMany(runners, {
        where: { user_id: userId },
        orderBy: ["created_at", "desc"],
      });
      return rows.map(mapRunner);
    },

    async revokeRunner(userId, id) {
      const row = await database.findOne(runners, { where: { id, user_id: userId } });
      if (!row) return "not-found";
      if (row.revoked_at === null) {
        await database.update(runners, row.id, {
          revoked_at: Temporal.Now.instant().toString(),
        });
      }
      return "revoked";
    },

    async deleteRunner(userId, id) {
      const row = await database.findOne(runners, { where: { id, user_id: userId } });
      if (!row) return "not-found";
      if (row.revoked_at === null) return "not-revoked";
      return (await database.delete(runners, row.id)) ? "deleted" : "not-found";
    },
  };
}

async function lockEnrollmentTokenOwner(database: Database, userId: string): Promise<void> {
  await database.exec("select id from users where id = $1 for update", [userId]);
}

async function findActiveEnrollmentToken(
  database: Database,
  userId: string,
): Promise<RunnerEnrollmentTokenRow | undefined> {
  const rows = await database.findMany(runnerEnrollmentTokens, { where: { user_id: userId } });
  return rows.find((row) => row.revoked_at === null);
}

async function createEnrollmentToken(
  database: Database,
  userId: string,
): Promise<RunnerEnrollmentToken> {
  const token = generateRunnerSecret(ENROLLMENT_PSK_PREFIX);
  const row: RunnerEnrollmentTokenRow = {
    id: v7.generate(),
    user_id: userId,
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
  if (!row.token) throw new Error(`Enrollment token ${row.id} does not have a stored PSK.`);
  return {
    id: row.id,
    token: row.token,
    createdAt: Temporal.Instant.from(row.created_at),
  };
}

function mapRunner(row: RunnerRow): RunnerRecord {
  const capabilities = parseSafe(runnerCapabilitiesSchema, JSON.parse(row.capabilities));
  if (!capabilities.success) {
    throw new Error(`Runner ${row.id} has invalid stored capabilities.`);
  }
  if (row.architecture !== "x64" && row.architecture !== "arm64") {
    throw new Error(`Runner ${row.id} has an invalid stored architecture.`);
  }
  return {
    id: row.id,
    name: row.name,
    architecture: row.architecture,
    capabilities: capabilities.value,
    createdAt: Temporal.Instant.from(row.created_at),
    revokedAt: row.revoked_at === null ? null : Temporal.Instant.from(row.revoked_at),
  };
}

function mapAuthenticatedRunner(row: RunnerRow): AuthenticatedRunner {
  return { id: row.id, userId: row.user_id };
}
