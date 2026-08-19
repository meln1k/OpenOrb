import { assert, assertEquals, assertInstanceOf, assertNotEquals } from "@std/assert";

import { importMasterKey } from "@/app/utils/master-key.ts";
import { decryptSecret, encryptSecret, SecretDecryptionError } from "@/app/utils/secret-cipher.ts";

const METADATA = { userId: "0198a5f8-3029-7000-8000-000000000011", key: "opencode-go" };
const SECRET = "oc-secret-api-key-7f3d9a";
const KEY_BYTES = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));

Deno.test("encrypts and decrypts a secret with authenticated metadata", async () => {
  const masterKey = await importMasterKey(KEY_BYTES);
  const encrypted = await encryptSecret(masterKey, SECRET, METADATA);
  assertEquals(encrypted.keyVersion, 1);
  // Output is nonce (12) || ciphertext || tag (16); opaque bytes.
  assert(encrypted.ciphertext.byteLength >= 12 + SECRET.length + 16);
  assertEquals(await decryptSecret(masterKey, encrypted, METADATA), [SECRET, undefined]);
});

Deno.test("each encryption uses a fresh random nonce", async () => {
  const masterKey = await importMasterKey(KEY_BYTES);
  const first = await encryptSecret(masterKey, SECRET, METADATA);
  const second = await encryptSecret(masterKey, SECRET, METADATA);
  assertNotEquals(first.ciphertext, second.ciphertext);
  assertEquals(await decryptSecret(masterKey, second, METADATA), [SECRET, undefined]);
});

Deno.test("tampered ciphertext, metadata, or key version fails authentication", async () => {
  const masterKey = await importMasterKey(KEY_BYTES);
  const encrypted = await encryptSecret(masterKey, SECRET, METADATA);

  const tamperedCiphertext = new Uint8Array(encrypted.ciphertext);
  tamperedCiphertext[28]! ^= 0xff;
  await assertDecryptionFails(
    decryptSecret(masterKey, { ...encrypted, ciphertext: tamperedCiphertext }, METADATA),
  );
  await assertDecryptionFails(
    decryptSecret(masterKey, encrypted, { ...METADATA, key: "OTHER_MODEL" }),
  );
  await assertDecryptionFails(
    decryptSecret(masterKey, encrypted, {
      ...METADATA,
      userId: "0198a5f8-3029-7000-8000-000000000012",
    }),
  );
  await assertDecryptionFails(
    decryptSecret(masterKey, { ...encrypted, keyVersion: 2 }, METADATA),
  );
});

Deno.test("a wrong master key fails without revealing or destroying data", async () => {
  const masterKey = await importMasterKey(KEY_BYTES);
  const wrongKey = await importMasterKey(new Uint8Array(32).fill(7));
  const encrypted = await encryptSecret(masterKey, SECRET, METADATA);

  const [, error] = await decryptSecret(wrongKey, encrypted, METADATA);
  if (error !== undefined) {
    assertInstanceOf(error, SecretDecryptionError);
    const message = error.message;
    assert(!message.includes(SECRET), `decryption error leaked the secret: ${message}`);
    // The original key still decrypts the untouched ciphertext.
    assertEquals(await decryptSecret(masterKey, encrypted, METADATA), [SECRET, undefined]);
    return;
  }
  throw new TypeError("Expected decryption to fail.");
});

async function assertDecryptionFails(result: ReturnType<typeof decryptSecret>): Promise<void> {
  const [, error] = await result;
  if (error !== undefined) {
    assertInstanceOf(error, SecretDecryptionError);
    return;
  }
  throw new TypeError("Expected decryption to fail.");
}
