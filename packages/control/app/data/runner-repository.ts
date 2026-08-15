import { ENROLLMENT_PSK_PREFIX, RUNNER_TOKEN_PREFIX } from "@openorb/protocol";
import type { RunnerArchitecture, RunnerEnrollmentRequest } from "@openorb/protocol";
import type { Database } from "remix/data-table";
import { v7 } from "@std/uuid";

import { generateRunnerSecret, hashRunnerSecret } from "../utils/runner-token.ts";
import {
  type RunnerEnrollmentTokenRow,
  runnerEnrollmentTokens,
  type RunnerRow,
  runners,
} from "./schema.ts";

export interface RunnerEnrollmentToken {
  id: string;
  token: string | null;
  createdAt: Temporal.Instant;
  revokedAt: Temporal.Instant | null;
}

export type CreatedRunnerEnrollmentToken = RunnerEnrollmentToken & {
  token: string;
};

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

export interface RunnerRepository {
  createRunnerEnrollmentToken(userId: string): Promise<CreatedRunnerEnrollmentToken>;
  listRunnerEnrollmentTokens(userId: string): Promise<RunnerEnrollmentToken[]>;
  revokeRunnerEnrollmentToken(userId: string, id: string): Promise<RevokeResult>;
  enrollRunner(input: RunnerEnrollmentRequest): Promise<EnrolledRunner | null>;
  authenticateRunner(token: string): Promise<AuthenticatedRunner | null>;
  listRunners(userId: string): Promise<RunnerRecord[]>;
  revokeRunner(userId: string, id: string): Promise<RevokeResult>;
}

export function createRunnerRepository(database: Database): RunnerRepository {
  return {
    async createRunnerEnrollmentToken(userId) {
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
      return { ...mapEnrollmentToken(row), token };
    },

    async listRunnerEnrollmentTokens(userId) {
      const rows = await database.findMany(runnerEnrollmentTokens, {
        where: { user_id: userId },
        orderBy: ["created_at", "desc"],
      });
      return rows.map(mapEnrollmentToken);
    },

    async revokeRunnerEnrollmentToken(userId, id) {
      const row = await database.findOne(runnerEnrollmentTokens, {
        where: { id, user_id: userId },
      });
      if (!row) return "not-found";
      if (row.revoked_at === null) {
        await database.update(runnerEnrollmentTokens, row.id, {
          revoked_at: Temporal.Now.instant().toString(),
        });
      }
      return "revoked";
    },

    async enrollRunner(input) {
      const enrollmentToken = await database.findOne(runnerEnrollmentTokens, {
        where: { token_hash: await hashRunnerSecret(input.enrollmentPsk) },
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
      await database.create(runners, row);
      return { runnerId: row.id, runnerToken };
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
  };
}

function mapEnrollmentToken(row: RunnerEnrollmentTokenRow): RunnerEnrollmentToken {
  return {
    id: row.id,
    token: row.token,
    createdAt: Temporal.Instant.from(row.created_at),
    revokedAt: row.revoked_at === null ? null : Temporal.Instant.from(row.revoked_at),
  };
}

function mapRunner(row: RunnerRow): RunnerRecord {
  const capabilities: unknown = JSON.parse(row.capabilities);
  if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string")) {
    throw new Error(`Runner ${row.id} has invalid stored capabilities.`);
  }
  if (row.architecture !== "x64" && row.architecture !== "arm64") {
    throw new Error(`Runner ${row.id} has an invalid stored architecture.`);
  }
  return {
    id: row.id,
    name: row.name,
    architecture: row.architecture,
    capabilities,
    createdAt: Temporal.Instant.from(row.created_at),
    revokedAt: row.revoked_at === null ? null : Temporal.Instant.from(row.revoked_at),
  };
}

function mapAuthenticatedRunner(row: RunnerRow): AuthenticatedRunner {
  return { id: row.id, userId: row.user_id };
}
