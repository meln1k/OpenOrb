import type { Database } from "remix/data-table";
import { Schema } from "effect";
import { err, ok, type Result, trySync } from "@openorb/result";
import {
  isValidSessionSecretHost,
  MAX_SESSION_ENVIRONMENT_SECRETS,
  MAX_SESSION_SECRET_HOSTS,
  SessionEnvironmentSecret,
  SessionEnvironmentSecrets,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";

import type { MasterKey } from "@/app/utils/master-key.ts";
import { decryptSecret, encryptSecret, type SecretMetadata } from "@/app/utils/secret-cipher.ts";
import {
  encryptedSecretPurposes,
  type EncryptedSecretRow,
  encryptedSecrets,
} from "@/app/data/schema.ts";

export interface SecretEntry {
  key: string;
  keyVersion: number;
  allowedHosts?: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export type SaveSecretResult =
  | { status: "saved"; secret: SecretEntry }
  | { status: "limit-exceeded" }
  | { status: "rpc-frame-limit-exceeded" };

export class EnvironmentSecretReadError extends Error {
  constructor(override readonly cause?: unknown) {
    super("The saved environment secrets could not be read.", { cause });
    this.name = "EnvironmentSecretReadError";
  }
}

export interface SecretRepository {
  listSecrets(workspaceId: WorkspaceId): Promise<SecretEntry[]>;
  getSecret(workspaceId: WorkspaceId, key: string): Promise<SecretEntry | null>;
  getEnvironmentSecrets(
    workspaceId: WorkspaceId,
  ): Promise<Result<readonly SessionEnvironmentSecret[], EnvironmentSecretReadError>>;
  saveSecret(
    workspaceId: WorkspaceId,
    key: string,
    value: string,
    allowedHosts?: readonly string[],
  ): Promise<SaveSecretResult>;
  deleteSecret(workspaceId: WorkspaceId, key: string): Promise<boolean>;
}

export function createSecretRepository(
  database: Database,
  masterKey: MasterKey,
): SecretRepository {
  return {
    async listSecrets(workspaceId) {
      const rows = await database.findMany(encryptedSecrets, {
        where: { workspace_id: workspaceId, purpose: encryptedSecretPurposes.genericSecret },
        orderBy: ["key", "asc"],
      });
      return rows.map(mapRow);
    },

    async getSecret(workspaceId, key) {
      const row = await database.findOne(encryptedSecrets, {
        where: { workspace_id: workspaceId, key, purpose: encryptedSecretPurposes.genericSecret },
      });
      return row ? mapRow(row) : null;
    },

    async getEnvironmentSecrets(workspaceId) {
      const rows = await database.findMany(encryptedSecrets, {
        where: { workspace_id: workspaceId, purpose: encryptedSecretPurposes.genericSecret },
        orderBy: ["key", "asc"],
      });
      return resolveEnvironmentSecrets(rows, workspaceId, masterKey);
    },

    async saveSecret(workspaceId, key, value, allowedHosts) {
      const candidate = Schema.decodeUnknownSync(SessionEnvironmentSecret)({
        name: key,
        value,
        ...(allowedHosts === undefined ? {} : { allowedHosts }),
      });
      const now = new Date().toISOString();
      const metadata: SecretMetadata = { workspaceId, key };
      const encrypted = await encryptSecret(masterKey, value, metadata);
      const row: EncryptedSecretRow = {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        key,
        purpose: encryptedSecretPurposes.genericSecret,
        key_version: encrypted.keyVersion,
        ciphertext: encrypted.ciphertext.toBase64(),
        allowed_hosts: allowedHosts === undefined ? null : JSON.stringify(allowedHosts),
        created_at: now,
        updated_at: now,
      };

      const saved = await database.transaction(async (transaction) => {
        const rows = await transaction.findMany(encryptedSecrets, {
          where: { workspace_id: workspaceId, purpose: encryptedSecretPurposes.genericSecret },
          orderBy: ["key", "asc"],
        });
        const existing = rows.find((secret) => secret.key === key);
        if (existing) {
          rows.splice(rows.indexOf(existing), 1);
        } else if (rows.length >= MAX_SESSION_ENVIRONMENT_SECRETS) {
          return "limit-exceeded" as const;
        }
        const [current, readError] = await resolveEnvironmentSecrets(rows, workspaceId, masterKey);
        if (readError !== undefined) throw readError;
        if (
          Schema.decodeUnknownResult(SessionEnvironmentSecrets)([...current, candidate])._tag ===
            "Failure"
        ) {
          return "rpc-frame-limit-exceeded" as const;
        }
        if (existing) {
          await transaction.update(encryptedSecrets, existing.id, {
            key_version: row.key_version,
            ciphertext: row.ciphertext,
            allowed_hosts: row.allowed_hosts,
            updated_at: now,
          });
        } else {
          await transaction.create(encryptedSecrets, row);
        }
        return "saved" as const;
      }, { isolationLevel: "serializable" });

      return saved === "saved" ? { status: "saved", secret: mapRow(row) } : { status: saved };
    },

    async deleteSecret(workspaceId, key) {
      const result = await database.deleteMany(encryptedSecrets, {
        where: { workspace_id: workspaceId, key, purpose: encryptedSecretPurposes.genericSecret },
      });
      return result.affectedRows > 0;
    },
  };
}

async function resolveEnvironmentSecrets(
  rows: readonly EncryptedSecretRow[],
  workspaceId: WorkspaceId,
  masterKey: MasterKey,
): Promise<Result<readonly SessionEnvironmentSecret[], EnvironmentSecretReadError>> {
  const resolved: SessionEnvironmentSecret[] = [];
  for (const row of rows) {
    const [ciphertext, decodeError] = trySync(
      () => Uint8Array.fromBase64(row.ciphertext),
      (cause) => new EnvironmentSecretReadError(cause),
    );
    if (decodeError !== undefined) return err(decodeError);
    const [value, decryptionError] = await decryptSecret(
      masterKey,
      { keyVersion: row.key_version, ciphertext },
      { workspaceId, key: row.key },
    );
    if (decryptionError !== undefined) {
      return err(new EnvironmentSecretReadError(decryptionError));
    }
    const [allowedHosts, hostsError] = decodeAllowedHosts(row.allowed_hosts);
    if (hostsError !== undefined) return err(new EnvironmentSecretReadError(hostsError));
    resolved.push(
      new SessionEnvironmentSecret({
        name: row.key,
        value,
        ...(allowedHosts === undefined ? {} : { allowedHosts }),
      }),
    );
  }
  return trySync(
    () => Schema.decodeUnknownSync(SessionEnvironmentSecrets)(resolved),
    (cause) => new EnvironmentSecretReadError(cause),
  );
}

function mapRow(row: EncryptedSecretRow): SecretEntry {
  const [allowedHosts, error] = decodeAllowedHosts(row.allowed_hosts);
  if (error !== undefined) throw error;
  return {
    key: row.key,
    keyVersion: row.key_version,
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeAllowedHosts(
  encoded: string | null,
): Result<readonly string[] | undefined, EnvironmentSecretReadError> {
  if (encoded === null) return ok(undefined);
  return trySync(
    () => Schema.decodeUnknownSync(StoredAllowedHosts)(JSON.parse(encoded)),
    (cause) => new EnvironmentSecretReadError(cause),
  );
}

const StoredAllowedHosts = Schema.Array(Schema.String).check(
  Schema.isMaxLength(MAX_SESSION_SECRET_HOSTS),
  Schema.makeFilter((hosts) =>
    hosts.every(isValidSessionSecretHost)
      ? undefined
      : "Environment secret host metadata contains an invalid hostname."
  ),
  Schema.makeFilter((hosts) =>
    new Set(hosts.map((host) => host.toLowerCase())).size === hosts.length
      ? undefined
      : "Environment secret host metadata contains duplicate hostnames."
  ),
  Schema.makeFilter((hosts) =>
    !hosts.includes("*") || hosts.length === 1
      ? undefined
      : "Environment secret host metadata combines the wildcard with another hostname."
  ),
);
