import { assertEquals, assertNotEquals } from "@std/assert";

import {
  hashPassword,
  PASSWORD_ALGORITHM,
  PASSWORD_HASH,
  PASSWORD_ITERATIONS,
  PASSWORD_KEY_LENGTH_BITS,
  verifyPassword,
} from "@/app/utils/password.ts";

Deno.test("hashes and verifies passwords with the fixed PBKDF2 profile", async () => {
  const stored = await hashPassword("correct horse battery staple");

  assertEquals(stored.algorithm, PASSWORD_ALGORITHM);
  assertEquals(stored.hash, PASSWORD_HASH);
  assertEquals(stored.iterations, PASSWORD_ITERATIONS);
  assertEquals(stored.keyLengthBits, PASSWORD_KEY_LENGTH_BITS);
  assertEquals(stored.salt.byteLength, 16);
  assertEquals(stored.derivedKey.byteLength, 32);
  assertEquals(await verifyPassword("correct horse battery staple", stored), true);
  assertEquals(await verifyPassword("incorrect", stored), false);
});

Deno.test("uses a unique random salt for each password credential", async () => {
  const first = await hashPassword("same password");
  const second = await hashPassword("same password");
  assertNotEquals(first.salt.toHex(), second.salt.toHex());
});
