/**
 * Application master key for the gateway secret store.
 *
 * The key is supplied through `OPENORB_MASTER_KEY` (or an equivalent
 * deployment-time secret injection). The gateway never generates or
 * persists it; startup fails visibly when it is missing or malformed.
 */
import { trySync } from "@openorb/result";

export const MASTER_KEY_ENV_VAR = "OPENORB_MASTER_KEY";
export const MASTER_KEY_BYTE_LENGTH = 32;
export const MASTER_KEY_VERSION = 1;

export interface MasterKey {
  readonly version: number;
  readonly key: CryptoKey;
}

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

/**
 * Loads and imports the master key from `OPENORB_MASTER_KEY`.
 *
 * Accepts the 256-bit key as 64 hexadecimal characters or base64 encoding 32
 * bytes. Error messages never include the submitted key material.
 */
export async function loadMasterKey(
  source: string | undefined = Deno.env.get(MASTER_KEY_ENV_VAR),
): Promise<MasterKey> {
  const candidate = source?.trim();
  if (!candidate) {
    throw new MasterKeyError(
      `${MASTER_KEY_ENV_VAR} is missing. Provide a 256-bit key (32 bytes) as ` +
        "64 hexadecimal characters or base64. The gateway never " +
        "generates or stores the master key.",
    );
  }
  return await importMasterKey(decodeMasterKey(candidate), MASTER_KEY_VERSION);
}

/** Imports raw key bytes as a non-exportable AES-GCM `CryptoKey`. */
export async function importMasterKey(
  bytes: Uint8Array<ArrayBuffer>,
  version: number = MASTER_KEY_VERSION,
): Promise<MasterKey> {
  if (bytes.byteLength !== MASTER_KEY_BYTE_LENGTH) {
    throw new MasterKeyError(
      `The ${MASTER_KEY_ENV_VAR} value must decode to exactly ${MASTER_KEY_BYTE_LENGTH} bytes.`,
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return { version, key };
}

/** Decodes a hex or base64 master-key value, throwing a redacted error. */
export function decodeMasterKey(source: string): Uint8Array<ArrayBuffer> {
  if (/^[0-9a-fA-F]{64}$/.test(source)) {
    // The regex guarantees well-formed, exactly-32-byte hex input, so
    // `fromHex` cannot throw here.
    return Uint8Array.fromHex(source);
  }

  const [bytes, decodeError] = trySync(
    () => Uint8Array.fromBase64(source),
    () => new MasterKeyError(`${MASTER_KEY_ENV_VAR} is not valid base64.`),
  );
  if (decodeError !== undefined) throw decodeError;
  if (bytes?.byteLength === MASTER_KEY_BYTE_LENGTH) return bytes;

  throw new MasterKeyError(
    `${MASTER_KEY_ENV_VAR} must be a 256-bit key: 64 hexadecimal characters ` +
      `or base64 encoding ${MASTER_KEY_BYTE_LENGTH} bytes.`,
  );
}
