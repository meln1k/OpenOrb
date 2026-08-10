import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  decodeMasterKey,
  importMasterKey,
  loadMasterKey,
  MASTER_KEY_BYTE_LENGTH,
  MasterKeyError,
} from "./master-key.ts";

const HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const BASE64 = Uint8Array.fromHex(HEX).toBase64();

Deno.test("loads a 256-bit master key from hex or base64", async () => {
  for (const source of [HEX, BASE64]) {
    const masterKey = await loadMasterKey(source);
    assertEquals(masterKey.version, 1);
    assertEquals(masterKey.key.algorithm.name, "AES-GCM");
    assertEquals(masterKey.key.extractable, false);
    assertEquals([...masterKey.key.usages].sort(), ["decrypt", "encrypt"]);
  }
});

Deno.test("fails visibly when the master key is missing or malformed", async () => {
  await assertRejects(() => loadMasterKey(undefined), MasterKeyError);
  await assertRejects(() => loadMasterKey(""), MasterKeyError);
  await assertRejects(() => loadMasterKey("   "), MasterKeyError);
  await assertRejects(() => loadMasterKey("short"), MasterKeyError);
  await assertRejects(() => loadMasterKey("zz".repeat(32)), MasterKeyError);
  await assertRejects(() => loadMasterKey("00".repeat(31)), MasterKeyError);
  await assertRejects(() => loadMasterKey("00".repeat(33)), MasterKeyError);
  await assertRejects(() => loadMasterKey(HEX.repeat(2)), MasterKeyError);
});

Deno.test("rejects imported keys of the wrong length", async () => {
  await assertRejects(() => importMasterKey(new Uint8Array(31)), MasterKeyError);
  await assertRejects(() => importMasterKey(new Uint8Array(33)), MasterKeyError);
  const masterKey = await importMasterKey(new Uint8Array(MASTER_KEY_BYTE_LENGTH).fill(1));
  assertEquals(masterKey.version, 1);
});

Deno.test("error messages never include the submitted key material", async () => {
  const attempts = ["short", "not-a-valid-key-0000000000000000000000000000", "00".repeat(31)];
  for (const attempt of attempts) {
    let message = "";
    try {
      await loadMasterKey(attempt);
      assert(false, `expected ${JSON.stringify(attempt)} to be rejected`);
    } catch (error) {
      assert(error instanceof MasterKeyError);
      message = error.message;
    }
    assert(!message.includes(attempt), `error message leaked key material: ${message}`);
  }
});

Deno.test("decodeMasterKey parses exactly 32 bytes from hex and base64", () => {
  const fromHex = decodeMasterKey(HEX);
  assertEquals(fromHex.byteLength, 32);
  assertEquals(fromHex[0], 0x00);
  assertEquals(fromHex[31], 0x1f);
  assertEquals(decodeMasterKey(BASE64), fromHex);
});
