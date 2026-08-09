import type { Database } from "remix/data-table";

import { hashPassword, verifyPassword } from "./password.ts";
import { passwordCredentials, users } from "./schema.ts";

export interface Administrator {
  id: number;
}

export interface AdministratorRepository {
  hasAdministrator(): Promise<boolean>;
  getAdministrator(id: number): Promise<Administrator | null>;
  createAdministrator(password: string): Promise<boolean>;
  verifyAdministratorPassword(password: string): Promise<Administrator | null>;
}

const ADMINISTRATOR_ID = 1;

export function createAdministratorRepository(database: Database): AdministratorRepository {
  return {
    async hasAdministrator() {
      return (await database.find(users, ADMINISTRATOR_ID)) !== null;
    },
    async getAdministrator(id) {
      if (id !== ADMINISTRATOR_ID) {
        return null;
      }

      return (await database.find(users, ADMINISTRATOR_ID)) === null
        ? null
        : { id: ADMINISTRATOR_ID };
    },
    async createAdministrator(password) {
      const passwordHash = await hashPassword(password);

      try {
        await database.transaction(async (transaction) => {
          await transaction.create(users, {
            id: ADMINISTRATOR_ID,
            created_at: new Date().toISOString(),
          });
          await transaction.create(passwordCredentials, {
            user_id: ADMINISTRATOR_ID,
            salt: passwordHash.salt.toString("base64"),
            derived_key: passwordHash.derivedKey.toString("base64"),
            algorithm: passwordHash.algorithm,
            memory_kib: passwordHash.memoryKib,
            passes: passwordHash.passes,
            parallelism: passwordHash.parallelism,
            key_length: passwordHash.keyLength,
            created_at: new Date().toISOString(),
          });
        });
        return true;
      } catch (error) {
        if (isConstraintViolation(error)) {
          return false;
        }
        throw error;
      }
    },
    async verifyAdministratorPassword(password) {
      const credential = await database.find(passwordCredentials, ADMINISTRATOR_ID);
      if (!credential) {
        return null;
      }

      const valid = await verifyPassword(password, {
        salt: Buffer.from(credential.salt, "base64"),
        derivedKey: Buffer.from(credential.derived_key, "base64"),
        algorithm: credential.algorithm,
        memoryKib: credential.memory_kib,
        passes: credential.passes,
        parallelism: credential.parallelism,
        keyLength: credential.key_length,
      });

      return valid ? { id: ADMINISTRATOR_ID } : null;
    },
  };
}

function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("code" in error && (error.code === "23505" || error.code === "23514")) {
    return true;
  }

  return "cause" in error && isConstraintViolation(error.cause);
}
