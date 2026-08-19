import type { Database } from "remix/data-table";
import { err, ok, type Result, trySync } from "@openorb/result";

import type { MasterKey } from "@/app/utils/master-key.ts";
import { decryptSecret, encryptSecret, type SecretMetadata } from "@/app/utils/secret-cipher.ts";
import {
  encryptedSecretPurposes,
  type EncryptedSecretRow,
  encryptedSecrets,
  gitAuthorConfiguration,
  type GitAuthorConfigurationRow,
  type GitCredentialRow,
  gitCredentials,
} from "@/app/data/schema.ts";

const GITHUB_HOST = "github.com";
const GITHUB_SECRET_KEY_PREFIX = "OPENORB_GITHUB_TOKEN_";

export interface GitAuthorConfiguration {
  authorName: string;
  authorEmail: string;
  updatedAt: string;
}

export interface GitCredential {
  id: string;
  host: typeof GITHUB_HOST;
  createdAt: string;
  updatedAt: string;
}

export type DeleteGitCredentialResult =
  | { status: "deleted" }
  | { status: "not-found" };

export class GitCredentialReadError extends Error {
  constructor(override readonly cause?: unknown) {
    super("The saved GitHub credential could not be read.", { cause });
    this.name = "GitCredentialReadError";
  }
}

export interface GitConfigurationRepository {
  getGitAuthorConfiguration(userId: string): Promise<GitAuthorConfiguration | null>;
  saveGitAuthorConfiguration(userId: string, input: {
    authorName: string;
    authorEmail: string;
  }): Promise<GitAuthorConfiguration>;
  getGitHubCredential(userId: string): Promise<GitCredential | null>;
  getGitHubToken(userId: string): Promise<Result<string | null, GitCredentialReadError>>;
  saveGitHubCredential(userId: string, token: string): Promise<GitCredential>;
  deleteGitHubCredential(userId: string): Promise<DeleteGitCredentialResult>;
}

export function createGitConfigurationRepository(
  database: Database,
  masterKey: MasterKey,
): GitConfigurationRepository {
  return {
    async getGitAuthorConfiguration(userId) {
      const row = await database.find(gitAuthorConfiguration, userId);
      return row ? mapGitAuthorConfiguration(row) : null;
    },

    async saveGitAuthorConfiguration(userId, input) {
      const now = new Date().toISOString();
      const existing = await database.find(gitAuthorConfiguration, userId);
      const row = existing
        ? await database.update(gitAuthorConfiguration, userId, {
          author_name: input.authorName,
          author_email: input.authorEmail,
          updated_at: now,
        })
        : await database.create(
          gitAuthorConfiguration,
          {
            user_id: userId,
            author_name: input.authorName,
            author_email: input.authorEmail,
            updated_at: now,
          },
          { returnRow: true },
        );

      return mapGitAuthorConfiguration(row);
    },

    async getGitHubCredential(userId) {
      const row = await database.findOne(gitCredentials, {
        where: { user_id: userId, host: GITHUB_HOST },
      });
      return row ? mapGitCredential(row) : null;
    },

    async getGitHubToken(userId) {
      const credential = await database.findOne(gitCredentials, {
        where: { user_id: userId, host: GITHUB_HOST },
      });
      if (!credential) return ok(null);
      const secret = await database.findOne(encryptedSecrets, {
        where: {
          id: credential.encrypted_secret_id,
          user_id: userId,
          purpose: encryptedSecretPurposes.gitCredential,
        },
      });
      if (!secret) return err(new GitCredentialReadError());
      const [ciphertext, decodeError] = trySync(
        () => Uint8Array.fromBase64(secret.ciphertext),
        (cause) => new GitCredentialReadError(cause),
      );
      if (decodeError !== undefined) return err(decodeError);
      const [token, decryptionError] = await decryptSecret(
        masterKey,
        {
          keyVersion: secret.key_version,
          ciphertext,
        },
        { userId, key: secret.key },
      );
      if (decryptionError !== undefined) return err(new GitCredentialReadError(decryptionError));
      return ok(token);
    },

    saveGitHubCredential(userId, token) {
      const now = new Date().toISOString();
      return database.transaction(async (transaction) => {
        const existing = await transaction.findOne(gitCredentials, {
          where: { user_id: userId, host: GITHUB_HOST },
        });

        if (existing) {
          const secret = await transaction.find(encryptedSecrets, existing.encrypted_secret_id);
          if (!secret) {
            throw new GitCredentialIntegrityError("The GitHub credential secret is missing.");
          }
          if (secret.purpose !== encryptedSecretPurposes.gitCredential) {
            throw new GitCredentialIntegrityError(
              "The GitHub credential secret has an invalid purpose.",
            );
          }
          if (secret.user_id !== userId) {
            throw new GitCredentialIntegrityError(
              "The GitHub credential secret has an invalid owner.",
            );
          }
          const encrypted = await encryptSecret(masterKey, token, { userId, key: secret.key });
          await transaction.update(encryptedSecrets, secret.id, {
            key_version: encrypted.keyVersion,
            ciphertext: encrypted.ciphertext.toBase64(),
            updated_at: now,
          });
          const updated = await transaction.update(gitCredentials, existing.id, {
            updated_at: now,
          });
          return mapGitCredential(updated);
        }

        const credentialId = crypto.randomUUID();
        const secretKey = `${GITHUB_SECRET_KEY_PREFIX}${
          credentialId.replaceAll("-", "").toUpperCase()
        }`;
        const metadata: SecretMetadata = { userId, key: secretKey };
        const encrypted = await encryptSecret(masterKey, token, metadata);
        const secret: EncryptedSecretRow = {
          id: crypto.randomUUID(),
          user_id: userId,
          key: secretKey,
          purpose: encryptedSecretPurposes.gitCredential,
          key_version: encrypted.keyVersion,
          ciphertext: encrypted.ciphertext.toBase64(),
          created_at: now,
          updated_at: now,
        };
        const credential: GitCredentialRow = {
          id: credentialId,
          user_id: userId,
          host: GITHUB_HOST,
          encrypted_secret_id: secret.id,
          created_at: now,
          updated_at: now,
        };

        await transaction.create(encryptedSecrets, secret);
        await transaction.create(gitCredentials, credential);
        return mapGitCredential(credential);
      });
    },

    async deleteGitHubCredential(userId) {
      return await database.transaction(async (transaction) => {
        const credential = await transaction.findOne(gitCredentials, {
          where: { user_id: userId, host: GITHUB_HOST },
        });
        if (!credential) return { status: "not-found" } as const;

        await transaction.delete(gitCredentials, credential.id);
        await transaction.delete(encryptedSecrets, credential.encrypted_secret_id);
        return { status: "deleted" } as const;
      });
    },
  };
}

class GitCredentialIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCredentialIntegrityError";
  }
}

function mapGitAuthorConfiguration(
  row: GitAuthorConfigurationRow,
): GitAuthorConfiguration {
  return {
    authorName: row.author_name,
    authorEmail: row.author_email,
    updatedAt: row.updated_at,
  };
}

function mapGitCredential(row: GitCredentialRow): GitCredential {
  return {
    id: row.id,
    host: GITHUB_HOST,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isReservedGitCredentialSecretKey(key: string): boolean {
  return key.startsWith(GITHUB_SECRET_KEY_PREFIX);
}
