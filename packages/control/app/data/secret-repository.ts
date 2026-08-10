import type { Database } from "remix/data-table";

import type { MasterKey } from "../utils/master-key.ts";
import { encryptSecret, type SecretMetadata } from "../utils/secret-cipher.ts";
import { type EncryptedSecretRow, encryptedSecrets } from "./schema.ts";

export interface SecretEntry {
  key: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SecretRepository {
  listSecrets(): Promise<SecretEntry[]>;
  getSecret(key: string): Promise<SecretEntry | null>;
  saveSecret(key: string, value: string): Promise<SecretEntry>;
  deleteSecret(key: string): Promise<boolean>;
}

export function createSecretRepository(
  database: Database,
  masterKey: MasterKey,
): SecretRepository {
  return {
    async listSecrets() {
      const rows = await database.findMany(encryptedSecrets, {
        orderBy: ["key", "asc"],
      });
      return rows.map(mapRow);
    },

    async getSecret(key) {
      const row = await database.findOne(encryptedSecrets, { where: { key } });
      return row ? mapRow(row) : null;
    },

    async saveSecret(key, value) {
      const now = new Date().toISOString();
      const metadata: SecretMetadata = { key };
      const encrypted = await encryptSecret(masterKey, value, metadata);
      const row: EncryptedSecretRow = {
        id: crypto.randomUUID(),
        key,
        key_version: encrypted.keyVersion,
        ciphertext: encrypted.ciphertext.toBase64(),
        created_at: now,
        updated_at: now,
      };

      await database.transaction(async (transaction) => {
        const existing = await transaction.findOne(encryptedSecrets, { where: { key } });
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

    async deleteSecret(key) {
      const result = await database.deleteMany(encryptedSecrets, { where: { key } });
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
