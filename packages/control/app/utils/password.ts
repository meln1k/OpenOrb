import { timingSafeEqual } from "@std/crypto/timing-safe-equal";

export const PASSWORD_ALGORITHM = "PBKDF2" as const;
export const PASSWORD_HASH = "SHA-256" as const;
export const PASSWORD_ITERATIONS = 600_000 as const;
export const PASSWORD_SALT_LENGTH = 16 as const;
export const PASSWORD_KEY_LENGTH_BITS = 256 as const;

export interface PasswordHash {
  salt: Uint8Array;
  derivedKey: Uint8Array;
  algorithm: typeof PASSWORD_ALGORITHM;
  hash: typeof PASSWORD_HASH;
  iterations: typeof PASSWORD_ITERATIONS;
  keyLengthBits: typeof PASSWORD_KEY_LENGTH_BITS;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_LENGTH));
  return {
    salt,
    derivedKey: await derive(password, salt),
    algorithm: PASSWORD_ALGORITHM,
    hash: PASSWORD_HASH,
    iterations: PASSWORD_ITERATIONS,
    keyLengthBits: PASSWORD_KEY_LENGTH_BITS,
  };
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash,
): Promise<boolean> {
  let derivedKey: Uint8Array;
  try {
    derivedKey = await derive(password, stored.salt);
  } catch {
    return false;
  }

  if (derivedKey.byteLength !== stored.derivedKey.byteLength) return false;
  return timingSafeEqual(derivedKey, stored.derivedKey);
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: PASSWORD_HASH,
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
      iterations: PASSWORD_ITERATIONS,
    },
    passwordKey,
    PASSWORD_KEY_LENGTH_BITS,
  );
  return new Uint8Array(derived);
}
