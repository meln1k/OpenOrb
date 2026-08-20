import type { Database } from "remix/data-table";
import { err, ok, type Result, trySync } from "@openorb/result";

import type { MasterKey } from "@/app/utils/master-key.ts";
import { decryptSecret, encryptSecret, type SecretMetadata } from "@/app/utils/secret-cipher.ts";
import {
  encryptedSecretPurposes,
  type EncryptedSecretRow,
  encryptedSecrets,
  type ModelProviderCredentialRow,
  modelProviderCredentials,
} from "@/app/data/schema.ts";

export interface ModelProviderCredential {
  id: string;
  providerId: string;
  createdAt: string;
  updatedAt: string;
}

export class ModelProviderCredentialReadError extends Error {
  constructor(override readonly cause?: unknown) {
    super("The saved model provider credential could not be read.", { cause });
    this.name = "ModelProviderCredentialReadError";
  }
}

export type DeleteModelProviderCredentialResult =
  | { status: "deleted" }
  | { status: "not-found" };

export interface ModelProviderRepository {
  listModelProviderCredentials(userId: string): Promise<ModelProviderCredential[]>;
  getModelProviderCredential(
    userId: string,
    providerId: string,
  ): Promise<ModelProviderCredential | null>;
  getModelProviderApiKey(
    userId: string,
    providerId: string,
  ): Promise<Result<string | null, ModelProviderCredentialReadError>>;
  saveModelProviderCredential(
    userId: string,
    providerId: string,
    apiKey: string,
  ): Promise<ModelProviderCredential>;
  deleteModelProviderCredential(
    userId: string,
    providerId: string,
  ): Promise<DeleteModelProviderCredentialResult>;
}

export function createModelProviderRepository(
  database: Database,
  masterKey: MasterKey,
): ModelProviderRepository {
  return {
    async listModelProviderCredentials(userId) {
      const rows = await database.findMany(modelProviderCredentials, {
        where: { user_id: userId },
        orderBy: ["provider_id", "asc"],
      });
      return rows.map(mapCredential);
    },

    async getModelProviderCredential(userId, providerId) {
      const row = await database.findOne(modelProviderCredentials, {
        where: { user_id: userId, provider_id: providerId },
      });
      return row ? mapCredential(row) : null;
    },

    async getModelProviderApiKey(userId, providerId) {
      const credential = await database.findOne(modelProviderCredentials, {
        where: { user_id: userId, provider_id: providerId },
      });
      if (!credential) return ok(null);
      const secret = await database.findOne(encryptedSecrets, {
        where: {
          id: credential.encrypted_secret_id,
          user_id: userId,
          purpose: encryptedSecretPurposes.providerApiKey,
        },
      });
      if (!secret) return err(new ModelProviderCredentialReadError());
      const [ciphertext, decodeError] = trySync(
        () => Uint8Array.fromBase64(secret.ciphertext),
        (cause) => new ModelProviderCredentialReadError(cause),
      );
      if (decodeError !== undefined) return err(decodeError);
      const [apiKey, decryptionError] = await decryptSecret(
        masterKey,
        { keyVersion: secret.key_version, ciphertext },
        { userId, key: secret.key },
      );
      if (decryptionError !== undefined) {
        return err(new ModelProviderCredentialReadError(decryptionError));
      }
      return ok(apiKey);
    },

    saveModelProviderCredential(userId, providerId, apiKey) {
      const now = new Date().toISOString();
      return database.transaction(async (transaction) => {
        const existing = await transaction.findOne(modelProviderCredentials, {
          where: { user_id: userId, provider_id: providerId },
        });
        if (existing) {
          const secret = await transaction.find(encryptedSecrets, existing.encrypted_secret_id);
          assertCredentialSecret(secret, userId);
          const encrypted = await encryptSecret(masterKey, apiKey, {
            userId,
            key: secret.key,
          });
          await transaction.update(encryptedSecrets, secret.id, {
            key_version: encrypted.keyVersion,
            ciphertext: encrypted.ciphertext.toBase64(),
            updated_at: now,
          });
          const updated = await transaction.update(modelProviderCredentials, existing.id, {
            updated_at: now,
          });
          return mapCredential(updated);
        }

        const credentialId = crypto.randomUUID();
        const secretKey = crypto.randomUUID();
        const metadata: SecretMetadata = { userId, key: secretKey };
        const encrypted = await encryptSecret(masterKey, apiKey, metadata);
        const secret: EncryptedSecretRow = {
          id: crypto.randomUUID(),
          user_id: userId,
          key: secretKey,
          purpose: encryptedSecretPurposes.providerApiKey,
          key_version: encrypted.keyVersion,
          ciphertext: encrypted.ciphertext.toBase64(),
          created_at: now,
          updated_at: now,
        };
        const credential: ModelProviderCredentialRow = {
          id: credentialId,
          user_id: userId,
          provider_id: providerId,
          encrypted_secret_id: secret.id,
          created_at: now,
          updated_at: now,
        };
        await transaction.create(encryptedSecrets, secret);
        await transaction.create(modelProviderCredentials, credential);
        return mapCredential(credential);
      });
    },

    async deleteModelProviderCredential(userId, providerId) {
      return await database.transaction(async (transaction) => {
        const credential = await transaction.findOne(modelProviderCredentials, {
          where: { user_id: userId, provider_id: providerId },
        });
        if (!credential) return { status: "not-found" } as const;
        await transaction.delete(modelProviderCredentials, credential.id);
        await transaction.delete(encryptedSecrets, credential.encrypted_secret_id);
        return { status: "deleted" } as const;
      });
    },
  };
}

function assertCredentialSecret(
  secret: EncryptedSecretRow | null,
  userId: string,
): asserts secret is EncryptedSecretRow {
  if (!secret) {
    throw new ModelProviderCredentialIntegrityError("The provider credential secret is missing.");
  }
  if (secret.user_id !== userId) {
    throw new ModelProviderCredentialIntegrityError(
      "The provider credential secret has an invalid owner.",
    );
  }
  if (secret.purpose !== encryptedSecretPurposes.providerApiKey) {
    throw new ModelProviderCredentialIntegrityError(
      "The provider credential secret has an invalid purpose.",
    );
  }
}

class ModelProviderCredentialIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderCredentialIntegrityError";
  }
}

function mapCredential(row: ModelProviderCredentialRow): ModelProviderCredential {
  return {
    id: row.id,
    providerId: row.provider_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
