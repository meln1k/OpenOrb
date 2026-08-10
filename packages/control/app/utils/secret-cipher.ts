import { decryptAesGcm, encryptAesGcm } from "@std/crypto/aes-gcm";

import type { MasterKey } from "./master-key.ts";

/** Immutable metadata authenticated (but not encrypted) with each secret. */
export interface SecretMetadata {
  /** The credential key in environment-variable style, e.g. `OPENCODE_API_KEY`. */
  key: string;
}

export interface EncryptedSecret {
  /** Opaque `nonce (12 bytes) || ciphertext || tag (16 bytes)` value. */
  ciphertext: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}

export class SecretDecryptionError extends Error {
  constructor() {
    super(
      "The stored credential cannot be decrypted. The master key may have changed or the stored data may be corrupted.",
    );
    this.name = "SecretDecryptionError";
  }
}

/**
 * Encrypts a secret with AES-GCM under the master key, authenticating the
 * immutable metadata and key version as additional authenticated data.
 */
export async function encryptSecret(
  masterKey: MasterKey,
  plaintext: string,
  metadata: SecretMetadata,
): Promise<EncryptedSecret> {
  const additionalData = secretAad(metadata, masterKey.version);
  const ciphertext = await encryptAesGcm(
    masterKey.key,
    new TextEncoder().encode(plaintext),
    { additionalData },
  );
  return { ciphertext, keyVersion: masterKey.version };
}

/**
 * Decrypts a secret. Fails with a redacted error on a wrong master key,
 * tampered ciphertext, or tampered metadata, without modifying any data.
 */
export async function decryptSecret(
  masterKey: MasterKey,
  encrypted: EncryptedSecret,
  metadata: SecretMetadata,
): Promise<string> {
  const additionalData = secretAad(metadata, encrypted.keyVersion);
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptAesGcm(masterKey.key, encrypted.ciphertext, {
      additionalData,
    });
  } catch {
    throw new SecretDecryptionError();
  }
  return new TextDecoder().decode(plaintext);
}

function secretAad(metadata: SecretMetadata, keyVersion: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({ key: metadata.key, keyVersion }),
  );
}
