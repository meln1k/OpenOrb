import type { Database } from "remix/data-table";

import {
  hashPassword,
  PASSWORD_ALGORITHM,
  PASSWORD_HASH,
  PASSWORD_ITERATIONS,
  PASSWORD_KEY_LENGTH_BITS,
  PASSWORD_SALT_LENGTH,
  type PasswordHash,
  verifyPassword,
} from "./password.ts";
import { type PasswordCredential, passwordCredentials, users } from "./schema.ts";

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
            salt: passwordHash.salt.toBase64(),
            derived_key: passwordHash.derivedKey.toBase64(),
            algorithm: passwordHash.algorithm,
            hash: passwordHash.hash,
            iterations: passwordHash.iterations,
            key_length_bits: passwordHash.keyLengthBits,
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

      const passwordHash = decodePasswordHash(credential);
      if (!passwordHash) return null;

      const valid = await verifyPassword(password, passwordHash);
      return valid ? { id: ADMINISTRATOR_ID } : null;
    },
  };
}

function decodePasswordHash(credential: PasswordCredential): PasswordHash | null {
  if (
    credential.algorithm !== PASSWORD_ALGORITHM ||
    credential.hash !== PASSWORD_HASH ||
    credential.iterations !== PASSWORD_ITERATIONS ||
    credential.key_length_bits !== PASSWORD_KEY_LENGTH_BITS
  ) {
    return null;
  }

  try {
    const salt = Uint8Array.fromBase64(credential.salt);
    const derivedKey = Uint8Array.fromBase64(credential.derived_key);
    if (
      salt.byteLength !== PASSWORD_SALT_LENGTH ||
      derivedKey.byteLength * 8 !== PASSWORD_KEY_LENGTH_BITS
    ) {
      return null;
    }

    return {
      salt,
      derivedKey,
      algorithm: credential.algorithm,
      hash: credential.hash,
      iterations: credential.iterations,
      keyLengthBits: credential.key_length_bits,
    };
  } catch {
    return null;
  }
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
