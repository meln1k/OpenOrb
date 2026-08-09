import { randomBytes, timingSafeEqual } from "node:crypto";
import * as crypto from "node:crypto";

const ARGON2_ALGORITHM = "argon2id" as const;
const ARGON2_MEMORY_KIB = 19_456;
const ARGON2_PASSES = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_KEY_LENGTH = 32;
const ARGON2_SALT_LENGTH = 16;

type Argon2Parameters = {
  message: string | Uint8Array;
  nonce: Uint8Array;
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
};

type Argon2 = (
  algorithm: "argon2id",
  parameters: Argon2Parameters,
  callback: (error: Error | null, derivedKey?: Buffer) => void,
) => void;

const nodeArgon2 = (crypto as typeof crypto & { argon2?: Argon2 }).argon2;

if (!nodeArgon2) {
  throw new Error("OpenOrb requires Node.js 24.7 or newer with crypto.argon2().");
}

export interface PasswordHash {
  salt: Buffer;
  derivedKey: Buffer;
  algorithm: typeof ARGON2_ALGORITHM;
  memoryKib: number;
  passes: number;
  parallelism: number;
  keyLength: number;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(ARGON2_SALT_LENGTH);
  const derivedKey = await derive(password, salt, {
    memoryKib: ARGON2_MEMORY_KIB,
    passes: ARGON2_PASSES,
    parallelism: ARGON2_PARALLELISM,
    keyLength: ARGON2_KEY_LENGTH,
  });

  return {
    salt,
    derivedKey,
    algorithm: ARGON2_ALGORITHM,
    memoryKib: ARGON2_MEMORY_KIB,
    passes: ARGON2_PASSES,
    parallelism: ARGON2_PARALLELISM,
    keyLength: ARGON2_KEY_LENGTH,
  };
}

export async function verifyPassword(
  password: string,
  stored: {
    salt: Buffer;
    derivedKey: Buffer;
    algorithm: string;
    memoryKib: number;
    passes: number;
    parallelism: number;
    keyLength: number;
  },
): Promise<boolean> {
  if (stored.algorithm !== ARGON2_ALGORITHM || stored.keyLength <= 0) {
    return false;
  }

  let derivedKey: Buffer;
  try {
    derivedKey = await derive(password, stored.salt, {
      memoryKib: stored.memoryKib,
      passes: stored.passes,
      parallelism: stored.parallelism,
      keyLength: stored.keyLength,
    });
  } catch {
    return false;
  }

  return (
    derivedKey.length === stored.derivedKey.length && timingSafeEqual(derivedKey, stored.derivedKey)
  );
}

const argon2 = nodeArgon2;

async function derive(
  password: string,
  salt: Buffer,
  options: {
    memoryKib: number;
    passes: number;
    parallelism: number;
    keyLength: number;
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      ARGON2_ALGORITHM,
      {
        message: password,
        nonce: salt,
        memory: options.memoryKib,
        passes: options.passes,
        parallelism: options.parallelism,
        tagLength: options.keyLength,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
        } else if (!derivedKey) {
          reject(new Error("Node crypto.argon2() did not return a derived key."));
        } else {
          resolve(derivedKey);
        }
      },
    );
  });
}
