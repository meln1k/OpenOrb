import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";

import { importMasterKey } from "./master-key.ts";
import { decryptSecret, encryptSecret, SecretDecryptionError } from "./secret-cipher.ts";

const METADATA = { key: "opencode-go" };
const SECRET = "oc-secret-api-key-7f3d9a";
const KEY_BYTES = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));

Deno.test("encrypts and decrypts a secret with authenticated metadata", async () => {
  const masterKey = await importMasterKey(KEY_BYTES);
  const encrypted = await encryptSecret(masterKey, SECRET, METADATA);
  assertEquals(encrypted.keyVersion, 1);
  // Output is nonce (12) || ciphertext || tag (16); opaque bytes.
  assert(encrypted.ciphertext.byteLength >= 12 + SECRET.length + 16);
  assertEquals(await decryptSecret(masterKey, encrypted, METADATA), SECRET);
});

Deno.test("each encryption uses a fresh random nonce", async () => {
  const masterKey = await importMasterKey(KEY_BYTES);
  const first = await encryptSecret(masterKey, SECRET, METADATA);
  const second = await encryptSecret(masterKey, SECRET, METADATA);
  assertNotEquals(first.ciphertext, second.ciphertext);
  assertEquals(await decryptSecret(masterKey, second, METADATA), SECRET);
});

Deno.test("tampered ciphertext, metadata, or key version fails authentication", async () => {
  const masterKey = await importMasterKey(KEY_BYTES);
  const encrypted = await encryptSecret(masterKey, SECRET, METADATA);

  const tamperedCiphertext = new Uint8Array(encrypted.ciphertext);
  tamperedCiphertext[28]! ^= 0xff;
  await assertRejects(
    () => decryptSecret(masterKey, { ...encrypted, ciphertext: tamperedCiphertext }, METADATA),
    SecretDecryptionError,
  );

  await assertRejects(
    () => decryptSecret(masterKey, encrypted, { key: "OTHER_MODEL" }),
    SecretDecryptionError,
  );
  await assertRejects(
    () => decryptSecret(masterKey, encrypted, { key: "ANOTHER_PROVIDER" }),
    SecretDecryptionError,
  );
  await assertRejects(
    () => decryptSecret(masterKey, { ...encrypted, keyVersion: 2 }, METADATA),
    SecretDecryptionError,
  );
});

Deno.test("a wrong master key fails without revealing or destroying data", async () => {
  const masterKey = await importMasterKey(KEY_BYTES);
  const wrongKey = await importMasterKey(new Uint8Array(32).fill(7));
  const encrypted = await encryptSecret(masterKey, SECRET, METADATA);

  let message = "";
  try {
    await decryptSecret(wrongKey, encrypted, METADATA);
    assert(false, "expected decryption with the wrong key to fail");
  } catch (error) {
    assert(error instanceof SecretDecryptionError);
    message = error.message;
  }
  assert(!message.includes(SECRET), `decryption error leaked the secret: ${message}`);

  // The original key still decrypts the untouched ciphertext.
  assertEquals(await decryptSecret(masterKey, encrypted, METADATA), SECRET);
});
