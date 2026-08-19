import type { Database } from "remix/data-table";
import { v7 } from "@std/uuid";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

import {
  hashPassword,
  PASSWORD_ALGORITHM,
  PASSWORD_HASH,
  PASSWORD_ITERATIONS,
  PASSWORD_KEY_LENGTH_BITS,
  PASSWORD_SALT_LENGTH,
  type PasswordHash,
  verifyPassword,
} from "@/app/utils/password.ts";
import { type PasswordCredential, passwordCredentials, users } from "@/app/data/schema.ts";
import { hasPostgresErrorCode } from "@/app/data/postgres-error.ts";

export interface Administrator {
  id: string;
}

export class AdministratorPersistenceError extends Error {
  constructor(override readonly cause: unknown) {
    super("Administrator persistence failed.", { cause });
    this.name = "AdministratorPersistenceError";
  }
}

export interface AdministratorRepository {
  hasAdministrator(): Promise<boolean>;
  getAdministrator(id: string): Promise<Administrator | null>;
  createAdministrator(password: string): Promise<Result<boolean, AdministratorPersistenceError>>;
  verifyAdministratorPassword(password: string): Promise<Administrator | null>;
}

export function createAdministratorRepository(database: Database): AdministratorRepository {
  return {
    async hasAdministrator() {
      return (await database.findOne(users, { where: { is_administrator: true } })) !== null;
    },
    async getAdministrator(id) {
      const user = await database.findOne(users, {
        where: { id, is_administrator: true },
      });
      return user ? { id: user.id } : null;
    },
    async createAdministrator(password) {
      const passwordHash = await hashPassword(password);

      const [, persistenceError] = await tryAsync(
        database.transaction(async (transaction) => {
          const user = await transaction.create(
            users,
            {
              id: v7.generate(),
              is_administrator: true,
              created_at: new Date().toISOString(),
            },
            { returnRow: true },
          );
          await transaction.create(passwordCredentials, {
            user_id: user.id,
            salt: passwordHash.salt.toBase64(),
            derived_key: passwordHash.derivedKey.toBase64(),
            algorithm: passwordHash.algorithm,
            hash: passwordHash.hash,
            iterations: passwordHash.iterations,
            key_length_bits: passwordHash.keyLengthBits,
            created_at: new Date().toISOString(),
          });
        }),
        (cause) => new AdministratorPersistenceError(cause),
      );
      if (persistenceError !== undefined) {
        if (isConstraintViolation(persistenceError.cause)) return ok(false);
        return err(persistenceError);
      }
      return ok(true);
    },
    async verifyAdministratorPassword(password) {
      const administrator = await database.findOne(users, {
        where: { is_administrator: true },
      });
      if (!administrator) {
        return null;
      }
      const credential = await database.find(passwordCredentials, administrator.id);
      if (!credential) {
        return null;
      }

      const passwordHash = decodePasswordHash(credential);
      if (!passwordHash) return null;

      const valid = await verifyPassword(password, passwordHash);
      return valid ? { id: administrator.id } : null;
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

  const [decoded, decodeError] = trySync(() => {
    return {
      salt: Uint8Array.fromBase64(credential.salt),
      derivedKey: Uint8Array.fromBase64(credential.derived_key),
    };
  }, () => new Error("Invalid password hash"));
  if (decodeError !== undefined) return null;
  if (
    decoded.salt.byteLength !== PASSWORD_SALT_LENGTH ||
    decoded.derivedKey.byteLength * 8 !== PASSWORD_KEY_LENGTH_BITS
  ) {
    return null;
  }

  return {
    ...decoded,
    algorithm: credential.algorithm,
    hash: credential.hash,
    iterations: credential.iterations,
    keyLengthBits: credential.key_length_bits,
  };
}

function isConstraintViolation(error: unknown): boolean {
  return hasPostgresErrorCode(error, "23505", "23514");
}
