import type { Database } from "remix/data-table";

import type { MasterKey } from "@/app/utils/master-key.ts";
import { encryptSecret, type SecretMetadata } from "@/app/utils/secret-cipher.ts";
import {
  encryptedSecretPurposes,
  type EncryptedSecretRow,
  encryptedSecrets,
} from "@/app/data/schema.ts";

export interface SecretEntry {
  key: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SecretRepository {
  listSecrets(userId: string): Promise<SecretEntry[]>;
  getSecret(userId: string, key: string): Promise<SecretEntry | null>;
  saveSecret(userId: string, key: string, value: string): Promise<SecretEntry>;
  deleteSecret(userId: string, key: string): Promise<boolean>;
}

export function createSecretRepository(
  database: Database,
  masterKey: MasterKey,
): SecretRepository {
  return {
    async listSecrets(userId) {
      const rows = await database.findMany(encryptedSecrets, {
        where: { user_id: userId, purpose: encryptedSecretPurposes.genericSecret },
        orderBy: ["key", "asc"],
      });
      return rows.map(mapRow);
    },

    async getSecret(userId, key) {
      const row = await database.findOne(encryptedSecrets, {
        where: { user_id: userId, key, purpose: encryptedSecretPurposes.genericSecret },
      });
      return row ? mapRow(row) : null;
    },

    async saveSecret(userId, key, value) {
      const now = new Date().toISOString();
      const metadata: SecretMetadata = { userId, key };
      const encrypted = await encryptSecret(masterKey, value, metadata);
      const row: EncryptedSecretRow = {
        id: crypto.randomUUID(),
        user_id: userId,
        key,
        purpose: encryptedSecretPurposes.genericSecret,
        key_version: encrypted.keyVersion,
        ciphertext: encrypted.ciphertext.toBase64(),
        created_at: now,
        updated_at: now,
      };

      await database.transaction(async (transaction) => {
        const existing = await transaction.findOne(encryptedSecrets, {
          where: { user_id: userId, key, purpose: encryptedSecretPurposes.genericSecret },
        });
        if (existing) {
          await transaction.update(encryptedSecrets, existing.id, {
            key_version: row.key_version,
            ciphertext: row.ciphertext,
            updated_at: now,
          });
        } else {
          await transaction.create(encryptedSecrets, row);
        }
      });

      return mapRow(row);
    },

    async deleteSecret(userId, key) {
      const result = await database.deleteMany(encryptedSecrets, {
        where: { user_id: userId, key, purpose: encryptedSecretPurposes.genericSecret },
      });
      return result.affectedRows > 0;
    },
  };
}

function mapRow(row: EncryptedSecretRow): SecretEntry {
  return {
    key: row.key,
    keyVersion: row.key_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
