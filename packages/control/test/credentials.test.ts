import { assert, assertEquals, assertMatch, assertNotEquals, assertNotMatch } from "@std/assert";

import { createAppServices } from "../app/middleware/services.ts";
import { createAppRouter } from "../app/router.ts";
import { importMasterKey } from "../app/utils/master-key.ts";
import { decryptSecret, SecretDecryptionError } from "../app/utils/secret-cipher.ts";
import { createTestServer } from "./http-test-server.ts";
import { createTestStore, TEST_MASTER_KEY_BYTES, TEST_MASTER_KEY_HEX } from "./postgres-test.ts";

const OPENCODE_KEY = "OPENCODE_API_KEY";
const OPENCODE_VALUE = "oc-go-secret-7f3d9a";
const OPENAI_VALUE = "sk-openai-secret-91e4b0";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert(value, "expected a Set-Cookie header");
  return value.split(";", 1)[0]!;
}

function csrfFrom(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert(match, "expected a CSRF form field");
  return match[1]!;
}

interface AuthenticatedClient {
  store: Awaited<ReturnType<typeof createTestStore>>;
  router: ReturnType<typeof createAppRouter>;
  server: Awaited<ReturnType<typeof createTestServer>>;
  cookie: string;
  userId: string;
}

async function createAuthenticatedClient(): Promise<AuthenticatedClient> {
  const store = await createTestStore();
  const router = createAppRouter(createAppServices(store));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const setupUrl = new URL("/auth/setup", server.baseUrl);
    const setupPage = await fetch(setupUrl);
    const setupToken = csrfFrom(await setupPage.text());
    const setupResponse = await fetch(setupUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(setupPage) },
      body: new URLSearchParams({
        _csrf: setupToken,
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
      }),
    });
    assertEquals(setupResponse.status, 303);

    const loginUrl = new URL("/auth/login", server.baseUrl);
    const loginPage = await fetch(loginUrl);
    const loginToken = csrfFrom(await loginPage.text());
    const loginResponse = await fetch(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(loginPage) },
      body: new URLSearchParams({
        _csrf: loginToken,
        password: "correct horse battery staple",
      }),
    });
    assertEquals(loginResponse.status, 303);
    assertEquals(loginResponse.headers.get("location"), "/app");
    const user = await store.pool.query<{ id: string }>(
      "select id from users where is_administrator",
    );
    assertEquals(user.rows.length, 1);
    return {
      store,
      router,
      server,
      cookie: cookieFrom(loginResponse),
      userId: user.rows[0]!.id,
    };
  } catch (error) {
    await server.close();
    await store.close();
    throw error;
  }
}

async function credentialsPage(client: AuthenticatedClient): Promise<string> {
  const response = await fetch(new URL("/app/settings", client.server.baseUrl), {
    headers: { Cookie: client.cookie },
  });
  assertEquals(response.status, 200);
  return response.text();
}

async function submitCredentialsForm(
  client: AuthenticatedClient,
  form: Record<string, string>,
): Promise<Response> {
  const page = await credentialsPage(client);
  const token = csrfFrom(page);
  return fetch(new URL("/app/settings", client.server.baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: client.cookie },
    body: new URLSearchParams({ _csrf: token, ...form }),
  });
}

Deno.test("saves, replaces, and deletes provider credentials without exposing values", async () => {
  const client = await createAuthenticatedClient();
  try {
    const empty = await credentialsPage(client);
    assertMatch(empty, /<title>Settings<\/title>/);
    assertMatch(empty, /<script type="module" src="\/assets\/app\/assets\/client\.ts">/);
    assertMatch(empty, /<div aria-label="Settings sections"[^>]+role="tablist"/);
    const secretsTab = empty.match(
      /<button[^>]+aria-controls="([^"]+)"[^>]+aria-selected="true"[^>]+data-state="active"[^>]+id="([^"]+)"[^>]+role="tab"[^>]*>Secrets<\/button>/,
    );
    assert(secretsTab, "expected an active Secrets tab");
    const githubTab = empty.match(
      /<button[^>]+aria-controls="([^"]+)"[^>]+aria-selected="false"[^>]+data-state="inactive"[^>]+id="([^"]+)"[^>]+role="tab"[^>]*>GitHub<\/button>/,
    );
    assert(githubTab, "expected an inactive GitHub tab");
    assertMatch(
      empty,
      new RegExp(
        `aria-labelledby="${githubTab[2]}" data-state="inactive" hidden id="${
          githubTab[1]
        }" inert role="tabpanel"`,
      ),
    );
    assertMatch(empty, /href="\/app" aria-label="Close settings"/);
    assertNotMatch(empty, /aria-label="Primary navigation"|>Overview<|>Settings<\/span>/);
    assertMatch(empty, /data-slot="table"/);
    assertMatch(empty, /Stored secrets/);
    assertMatch(empty, /No secrets configured\./);
    assertMatch(empty, /commandfor="[^"]+-add-secret" command="show-modal"/);
    assertMatch(empty, />Add<\/button>/);
    assertMatch(empty, /OPENCODE_API_KEY/);
    assertNotMatch(empty, /oc-go-secret/);

    for (
      const [key, value] of [
        [OPENCODE_KEY, OPENCODE_VALUE],
        ["OPENAI_API_KEY", OPENAI_VALUE],
      ] as const
    ) {
      const saveResponse = await submitCredentialsForm(client, {
        intent: "save",
        key,
        value,
      });
      assertEquals(saveResponse.status, 303);
      assertEquals(
        saveResponse.headers.get("location"),
        "/app/settings?tab=secrets#secrets",
      );
    }

    const saved = await credentialsPage(client);
    assertMatch(saved, new RegExp(OPENCODE_KEY));
    assertMatch(saved, /OPENAI_API_KEY/);
    assertMatch(saved, /data-slot="table"/);
    assertMatch(saved, /aria-label="Open actions for OPENCODE_API_KEY"/);
    assertMatch(saved, />Edit<\/button>/);
    assertMatch(saved, />Delete<\/button>/);
    assertMatch(saved, /role="alertdialog"/);
    assertMatch(saved, /Edit secret/);
    assertMatch(saved, /Delete secret\?/);
    assertNotMatch(saved, /Encrypted · version/);
    assertNotMatch(saved, /oc-go-secret/);
    assertNotMatch(saved, /sk-openai-secret/);

    const rows = await client.store.pool.query(
      "select id, key, purpose, key_version, ciphertext from encrypted_secrets order by key",
    );
    assertEquals(rows.rows.length, 2);
    // Ascending key order: "OPENAI_API_KEY" < "OPENCODE_API_KEY".
    const openaiRow = rows.rows[0]! as Record<string, string | number>;
    const opencodeRow = rows.rows[1]! as Record<string, string | number>;
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assertMatch(opencodeRow.id as string, UUID_PATTERN);
    assertMatch(openaiRow.id as string, UUID_PATTERN);
    assertNotEquals(opencodeRow.id, openaiRow.id);
    assertEquals(opencodeRow.key, OPENCODE_KEY);
    assertEquals(openaiRow.key, "OPENAI_API_KEY");
    assertEquals(opencodeRow.purpose, "provider-api-key");
    assertEquals(openaiRow.purpose, "provider-api-key");
    assertEquals(opencodeRow.key_version, 1);
    for (
      const [key, value] of [
        [opencodeRow, OPENCODE_VALUE],
        [openaiRow, OPENAI_VALUE],
      ] as const
    ) {
      const ciphertext = key.ciphertext as string;
      assert(!ciphertext.includes(value), "ciphertext contains the plaintext value");
      assert(
        Uint8Array.fromBase64(ciphertext).byteLength >= value.length + 28,
        "ciphertext is not encrypted",
      );
    }
    const opencodeCiphertextBefore = opencodeRow.ciphertext as string;

    const replacement = "oc-go-replacement-secret-5c7e12";
    const replaceResponse = await submitCredentialsForm(client, {
      intent: "save",
      key: OPENCODE_KEY,
      value: replacement,
    });
    assertEquals(replaceResponse.status, 303);

    const replaced = await credentialsPage(client);
    assertNotMatch(replaced, /oc-go-secret-7f3d9a/);
    assertNotMatch(replaced, /oc-go-replacement-secret/);
    const replacedRows = await client.store.pool.query(
      "select id, ciphertext from encrypted_secrets where key = $1",
      [OPENCODE_KEY],
    );
    const replacedCiphertext = replacedRows.rows[0]!.ciphertext as string;
    assertNotEquals(replacedCiphertext, opencodeCiphertextBefore);
    // Replacing a value keeps the row identity; only the ciphertext rotates.
    assertEquals(replacedRows.rows[0]!.id, opencodeRow.id);
    assert(
      !replacedCiphertext.includes(replacement),
      "replaced ciphertext contains the plaintext value",
    );

    const deleteResponse = await submitCredentialsForm(client, {
      intent: "delete",
      key: "OPENAI_API_KEY",
    });
    assertEquals(deleteResponse.status, 303);
    const afterDelete = await credentialsPage(client);
    assertNotMatch(afterDelete, /sk-openai-secret/);
    const remaining = await client.store.pool.query(
      "select key from encrypted_secrets order by key",
    );
    assertEquals(
      remaining.rows.map((row: { key: string }) => row.key),
      [OPENCODE_KEY],
    );

    const deleteLastResponse = await submitCredentialsForm(client, {
      intent: "delete",
      key: OPENCODE_KEY,
    });
    assertEquals(deleteLastResponse.status, 303);
    assertMatch(await credentialsPage(client), /No secrets configured\./);
    const count = await client.store.pool.query(
      "select count(*)::integer as count from encrypted_secrets",
    );
    assertEquals(count.rows[0]?.count, 0);
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("restarting with the same master key preserves decryptability", async () => {
  const first = await createTestStore();
  assert(await first.createAdministrator("restart test password"));
  const user = await first.verifyAdministratorPassword("restart test password");
  assert(user);
  const userId = user.id;
  await first.saveSecret(userId, OPENCODE_KEY, OPENCODE_VALUE);
  await first.saveSecret(userId, "OPENAI_API_KEY", OPENAI_VALUE);
  const rows = (await first.pool.query(
    "select key, key_version, ciphertext, created_at, updated_at from encrypted_secrets order by key",
  )).rows as Array<{
    key: string;
    key_version: number;
    ciphertext: string;
    created_at: string;
    updated_at: string;
  }>;
  await first.close();

  // A fresh store over the same database simulates a control-panel restart;
  // it must not wipe the previously committed rows.
  const restarted = await createTestStore(undefined, false);
  try {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    // Ascending key order: "OPENAI_API_KEY" < "OPENCODE_API_KEY".
    assertEquals(await restarted.listSecrets(userId), [
      {
        key: "OPENAI_API_KEY",
        keyVersion: 1,
        createdAt: byKey.get("OPENAI_API_KEY")!.created_at,
        updatedAt: byKey.get("OPENAI_API_KEY")!.updated_at,
      },
      {
        key: OPENCODE_KEY,
        keyVersion: 1,
        createdAt: byKey.get(OPENCODE_KEY)!.created_at,
        updatedAt: byKey.get(OPENCODE_KEY)!.updated_at,
      },
    ]);
    const masterKey = await importMasterKey(TEST_MASTER_KEY_BYTES);
    for (
      const [key, value] of [
        [OPENCODE_KEY, OPENCODE_VALUE],
        ["OPENAI_API_KEY", OPENAI_VALUE],
      ] as const
    ) {
      const row = byKey.get(key)!;
      assertEquals(
        await decryptSecret(
          masterKey,
          {
            ciphertext: Uint8Array.fromBase64(row.ciphertext),
            keyVersion: row.key_version,
          },
          { userId, key },
        ),
        value,
      );
    }
  } finally {
    await restarted.close();
  }
});

Deno.test("a wrong master key fails visibly without destroying the stored data", async () => {
  const first = await createTestStore();
  assert(await first.createAdministrator("wrong key test password"));
  const user = await first.verifyAdministratorPassword("wrong key test password");
  assert(user);
  const userId = user.id;
  await first.saveSecret(userId, OPENCODE_KEY, OPENCODE_VALUE);
  await first.close();

  const wrongKey = await importMasterKey(new Uint8Array(32).fill(9));
  // Do not reset the database: the row written with the correct key must
  // survive and remain decryptable after the wrong-key attempt.
  const wrongKeyStore = await createTestStore(wrongKey, false);
  try {
    const row = (await wrongKeyStore.pool.query(
      "select key, key_version, ciphertext from encrypted_secrets",
    )).rows[0]! as { key: string; key_version: number; ciphertext: string };
    let message = "";
    try {
      await decryptSecret(
        wrongKey,
        {
          ciphertext: Uint8Array.fromBase64(row.ciphertext),
          keyVersion: row.key_version,
        },
        { userId, key: row.key },
      );
      assert(false, "expected decryption with the wrong key to fail");
    } catch (error) {
      assert(error instanceof SecretDecryptionError);
      message = error.message;
    }
    assert(!message.includes(OPENCODE_VALUE));
    const count = await wrongKeyStore.pool.query(
      "select count(*)::integer as count from encrypted_secrets",
    );
    assertEquals(count.rows[0]?.count, 1, "wrong-key decryption destroyed the stored row");
  } finally {
    await wrongKeyStore.close();
  }

  const restored = await createTestStore(undefined, false);
  try {
    assertEquals((await restored.getSecret(userId, OPENCODE_KEY))?.keyVersion, 1);
  } finally {
    await restored.close();
  }
});

Deno.test("no control-panel row contains the master key or the plaintext values", async () => {
  const client = await createAuthenticatedClient();
  try {
    await submitCredentialsForm(client, {
      intent: "save",
      key: OPENCODE_KEY,
      value: OPENCODE_VALUE,
    });
    await submitCredentialsForm(client, {
      intent: "save",
      key: "OPENAI_API_KEY",
      value: OPENAI_VALUE,
    });

    const tables = ["users", "password_credentials", "browser_sessions", "encrypted_secrets"];
    for (const table of tables) {
      const rows = await client.store.pool.query(`select * from ${table}`);
      for (const value of Object.values(rows.rows)) {
        const serialized = JSON.stringify(value);
        assert(
          !serialized.includes(TEST_MASTER_KEY_HEX),
          `master key material found in ${table}`,
        );
        assert(!serialized.includes(OPENCODE_VALUE), `plaintext value found in ${table}`);
        assert(!serialized.includes(OPENAI_VALUE), `plaintext value found in ${table}`);
      }
    }
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("rejects invalid keys, unauthenticated access, and un-CSRF'd saves", async () => {
  const client = await createAuthenticatedClient();
  try {
    const invalidKey = await submitCredentialsForm(client, {
      intent: "save",
      key: "Bad Key!",
      value: OPENCODE_VALUE,
    });
    assertEquals(invalidKey.status, 400);

    // Portable environment variable names may be lowercase, but cannot start
    // with a digit.
    const lowercaseKey = await submitCredentialsForm(client, {
      intent: "save",
      key: "opencode",
      value: OPENCODE_VALUE,
    });
    assertEquals(lowercaseKey.status, 303);

    const leadingDigitKey = await submitCredentialsForm(client, {
      intent: "save",
      key: "1API_KEY",
      value: OPENCODE_VALUE,
    });
    assertEquals(leadingDigitKey.status, 400);
    assertEquals(
      (await client.store.pool.query("select count(*)::integer as count from encrypted_secrets"))
        .rows[0]?.count,
      1,
    );

    const anonymous = await fetch(new URL("/app/settings", client.server.baseUrl), {
      redirect: "manual",
    });
    assertEquals(anonymous.status, 401);

    // Without a session, the auth boundary rejects before CSRF is evaluated.
    const anonymousPost = await fetch(new URL("/app/settings", client.server.baseUrl), {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ intent: "save", key: "OPENAI_API_KEY", value: OPENAI_VALUE }),
    });
    assertEquals(anonymousPost.status, 401);

    // With a session but no CSRF token, the state change is rejected.
    const missingCsrf = await fetch(new URL("/app/settings", client.server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ intent: "save", key: "OPENAI_API_KEY", value: OPENAI_VALUE }),
    });
    assertEquals(missingCsrf.status, 403);
    assertEquals(
      (await client.store.pool.query("select count(*)::integer as count from encrypted_secrets"))
        .rows[0]?.count,
      1,
      "rejected requests must not create additional rows",
    );
  } finally {
    await client.server.close();
    await client.store.close();
  }
});
