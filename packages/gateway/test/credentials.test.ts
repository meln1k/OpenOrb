import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertNotEquals,
  assertNotMatch,
} from "@std/assert";
import { array, number, object, parse, string } from "remix/data-schema";

import { ModelProviderCredentialReadError } from "@/app/data/model-provider-repository.ts";
import { createAppServices } from "@/app/middleware/services.ts";
import { createAppRouter } from "@/app/router.ts";
import { importMasterKey } from "@/app/utils/master-key.ts";
import { decryptSecret } from "@/app/utils/secret-cipher.ts";
import { createTestServer } from "@/test/http-test-server.ts";
import {
  createTestStore,
  TEST_MASTER_KEY_BYTES,
  TEST_MASTER_KEY_HEX,
} from "@/test/postgres-test.ts";

const OPENCODE_PROVIDER = "opencode-go";
const OPENCODE_VALUE = "oc-go-secret-7f3d9a";
const OPENAI_PROVIDER = "openai";
const OPENAI_VALUE = "sk-openai-secret-91e4b0";
const GENERIC_SECRET_KEY = "SERVICE_TOKEN";
const GENERIC_SECRET_VALUE = "generic-service-secret-42";

const storedProviderRowSchema = object({
  id: string(),
  provider_id: string(),
  encrypted_secret_id: string(),
  key: string(),
  purpose: string(),
  key_version: number(),
  ciphertext: string(),
  created_at: string(),
  updated_at: string(),
});

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
    const setupResponse = await fetch(setupUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(setupPage) },
      body: new URLSearchParams({
        _csrf: csrfFrom(await setupPage.text()),
        password: "[REDACTED:password] horse battery staple",
        confirmPassword: "[REDACTED:password] horse battery staple",
      }),
    });
    assertEquals(setupResponse.status, 303);

    const loginUrl = new URL("/auth/login", server.baseUrl);
    const loginPage = await fetch(loginUrl);
    const loginResponse = await fetch(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(loginPage) },
      body: new URLSearchParams({
        _csrf: csrfFrom(await loginPage.text()),
        password: "[REDACTED:password] horse battery staple",
      }),
    });
    assertEquals(loginResponse.status, 303);
    const user = await store.pool.query<{ id: string }>(
      "select id from users where is_administrator",
    );
    assertEquals(user.rows.length, 1);
    return {
      store,
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
  return fetch(new URL("/app/settings", client.server.baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: client.cookie },
    body: new URLSearchParams({ _csrf: csrfFrom(page), ...form }),
  });
}

Deno.test("configures Pi providers without exposing or keying records by API key", async () => {
  const client = await createAuthenticatedClient();
  try {
    const empty = await credentialsPage(client);
    assertMatch(empty, /<title>Settings<\/title>/);
    assertMatch(empty, /Model providers/);
    assertMatch(empty, /No model providers configured\./);
    assertMatch(empty, /name="providerId"/);
    assertMatch(empty, /value="opencode-go"/);
    assertMatch(empty, /name="apiKey"/);
    assertMatch(empty, /Generic secrets/);
    assertMatch(empty, /name="key"/);
    assertNotMatch(empty, /OPENCODE_API_KEY/);
    assertNotMatch(empty, new RegExp(OPENCODE_VALUE));

    for (
      const [providerId, apiKey] of [
        [OPENCODE_PROVIDER, OPENCODE_VALUE],
        [OPENAI_PROVIDER, OPENAI_VALUE],
      ] as const
    ) {
      const response = await submitCredentialsForm(client, {
        intent: "save-provider",
        providerId,
        apiKey,
      });
      assertEquals(response.status, 303);
      assertEquals(response.headers.get("location"), "/app/settings?tab=providers#providers");
    }

    const saved = await credentialsPage(client);
    assertMatch(saved, /opencode-go/);
    assertMatch(saved, /OpenAI/);
    assertMatch(saved, /Update provider key/);
    assertMatch(saved, /Delete provider credential\?/);
    assertNotMatch(saved, new RegExp(OPENCODE_VALUE));
    assertNotMatch(saved, new RegExp(OPENAI_VALUE));

    const rows = parse(
      array(storedProviderRowSchema),
      (await client.store.pool.query(
        `select mpc.id, mpc.provider_id, mpc.encrypted_secret_id,
              es.key, es.purpose, es.key_version, es.ciphertext,
              mpc.created_at, mpc.updated_at
         from model_provider_credentials mpc
         join encrypted_secrets es on es.id = mpc.encrypted_secret_id
        order by mpc.provider_id`,
      )).rows,
    );
    assertEquals(rows.length, 2);
    const byProvider = new Map(rows.map((row) => [row.provider_id, row]));
    const opencode = byProvider.get(OPENCODE_PROVIDER)!;
    const openai = byProvider.get(OPENAI_PROVIDER)!;
    assertEquals(opencode.purpose, "provider-api-key");
    assertEquals(openai.purpose, "provider-api-key");
    assertNotEquals(opencode.encrypted_secret_id, openai.encrypted_secret_id);
    assertNotEquals(opencode.key, OPENCODE_PROVIDER);
    assertNotEquals(openai.key, OPENAI_PROVIDER);
    assert(!opencode.ciphertext.includes(OPENCODE_VALUE));
    assert(!openai.ciphertext.includes(OPENAI_VALUE));

    const masterKey = await importMasterKey(TEST_MASTER_KEY_BYTES);
    for (const [row, apiKey] of [[opencode, OPENCODE_VALUE], [openai, OPENAI_VALUE]] as const) {
      assertEquals(
        await decryptSecret(
          masterKey,
          {
            ciphertext: Uint8Array.fromBase64(row.ciphertext),
            keyVersion: row.key_version,
          },
          { userId: client.userId, key: row.key },
        ),
        [apiKey, undefined],
      );
    }

    const replacement = "oc-go-replacement-secret-5c7e12";
    const replaceResponse = await submitCredentialsForm(client, {
      intent: "save-provider",
      providerId: OPENCODE_PROVIDER,
      apiKey: replacement,
    });
    assertEquals(replaceResponse.status, 303);
    const replaced = parse(
      storedProviderRowSchema,
      (await client.store.pool.query(
        `select mpc.id, mpc.provider_id, mpc.encrypted_secret_id,
              es.key, es.purpose, es.key_version, es.ciphertext,
              mpc.created_at, mpc.updated_at
         from model_provider_credentials mpc
         join encrypted_secrets es on es.id = mpc.encrypted_secret_id
        where mpc.provider_id = $1`,
        [OPENCODE_PROVIDER],
      )).rows[0],
    );
    assertEquals(replaced.id, opencode.id);
    assertEquals(replaced.encrypted_secret_id, opencode.encrypted_secret_id);
    assertNotEquals(replaced.ciphertext, opencode.ciphertext);
    assertEquals(await client.store.getModelProviderApiKey(client.userId, OPENCODE_PROVIDER), [
      replacement,
      undefined,
    ]);

    const deleteResponse = await submitCredentialsForm(client, {
      intent: "delete-provider",
      providerId: OPENAI_PROVIDER,
    });
    assertEquals(deleteResponse.status, 303);
    assertEquals(
      await client.store.getModelProviderCredential(client.userId, OPENAI_PROVIDER),
      null,
    );
    assertEquals(
      (await client.store.pool.query("select count(*)::integer as count from encrypted_secrets"))
        .rows[0]?.count,
      1,
    );
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("generic secrets remain independent from model provider credentials", async () => {
  const client = await createAuthenticatedClient();
  try {
    await client.store.saveModelProviderCredential(
      client.userId,
      OPENCODE_PROVIDER,
      OPENCODE_VALUE,
    );
    const saveResponse = await submitCredentialsForm(client, {
      intent: "save-secret",
      key: GENERIC_SECRET_KEY,
      value: GENERIC_SECRET_VALUE,
    });
    assertEquals(saveResponse.status, 303);
    assertEquals(saveResponse.headers.get("location"), "/app/settings?tab=secrets#secrets");

    assertEquals((await client.store.listSecrets(client.userId)).map((secret) => secret.key), [
      GENERIC_SECRET_KEY,
    ]);
    assertEquals(
      (await client.store.listModelProviderCredentials(client.userId)).map((credential) =>
        credential.providerId
      ),
      [OPENCODE_PROVIDER],
    );
    const rows = await client.store.pool.query<{ key: string; purpose: string }>(
      "select key, purpose from encrypted_secrets order by purpose",
    );
    assertEquals(rows.rows.map((row: { key: string; purpose: string }) => row.purpose), [
      "generic-secret",
      "provider-api-key",
    ]);
    assertEquals(
      rows.rows.find((row: { key: string; purpose: string }) => row.purpose === "generic-secret")
        ?.key,
      GENERIC_SECRET_KEY,
    );

    const page = await credentialsPage(client);
    assertMatch(page, new RegExp(GENERIC_SECRET_KEY));
    assertNotMatch(page, new RegExp(GENERIC_SECRET_VALUE));
    assertNotMatch(page, new RegExp(OPENCODE_VALUE));

    assertEquals(
      await client.store.deleteModelProviderCredential(client.userId, OPENCODE_PROVIDER),
      {
        status: "deleted",
      },
    );
    assert(await client.store.getSecret(client.userId, GENERIC_SECRET_KEY));

    const deleteResponse = await submitCredentialsForm(client, {
      intent: "delete-secret",
      key: GENERIC_SECRET_KEY,
    });
    assertEquals(deleteResponse.status, 303);
    assertEquals(await client.store.listSecrets(client.userId), []);
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("provider credentials remain decryptable across a gateway restart", async () => {
  const first = await createTestStore();
  assert(await first.createAdministrator("restart test password"));
  const user = await first.verifyAdministratorPassword("restart test password");
  assert(user);
  await first.saveModelProviderCredential(user.id, OPENCODE_PROVIDER, OPENCODE_VALUE);
  await first.saveModelProviderCredential(user.id, OPENAI_PROVIDER, OPENAI_VALUE);
  await first.close();

  const restarted = await createTestStore(undefined, false);
  try {
    assertEquals(
      (await restarted.listModelProviderCredentials(user.id)).map((credential) =>
        credential.providerId
      ),
      [OPENAI_PROVIDER, OPENCODE_PROVIDER],
    );
    assertEquals(await restarted.getModelProviderApiKey(user.id, OPENCODE_PROVIDER), [
      OPENCODE_VALUE,
      undefined,
    ]);
    assertEquals(await restarted.getModelProviderApiKey(user.id, OPENAI_PROVIDER), [
      OPENAI_VALUE,
      undefined,
    ]);
  } finally {
    await restarted.close();
  }
});

Deno.test("a wrong master key fails provider resolution without destroying stored data", async () => {
  const first = await createTestStore();
  assert(await first.createAdministrator("wrong key test password"));
  const user = await first.verifyAdministratorPassword("wrong key test password");
  assert(user);
  await first.saveModelProviderCredential(user.id, OPENCODE_PROVIDER, OPENCODE_VALUE);
  await first.close();

  const wrongKeyStore = await createTestStore(
    await importMasterKey(new Uint8Array(32).fill(9)),
    false,
  );
  try {
    const [value, error] = await wrongKeyStore.getModelProviderApiKey(
      user.id,
      OPENCODE_PROVIDER,
    );
    assertEquals(value, undefined);
    assertInstanceOf(error, ModelProviderCredentialReadError);
    assert(!error.message.includes(OPENCODE_VALUE));
    assertEquals(
      (await wrongKeyStore.pool.query(
        "select count(*)::integer as count from model_provider_credentials",
      )).rows[0]?.count,
      1,
    );
  } finally {
    await wrongKeyStore.close();
  }

  const restored = await createTestStore(undefined, false);
  try {
    assertEquals(await restored.getModelProviderApiKey(user.id, OPENCODE_PROVIDER), [
      OPENCODE_VALUE,
      undefined,
    ]);
  } finally {
    await restored.close();
  }
});

Deno.test("provider plaintext and master key never enter gateway rows", async () => {
  const client = await createAuthenticatedClient();
  try {
    await client.store.saveModelProviderCredential(
      client.userId,
      OPENCODE_PROVIDER,
      OPENCODE_VALUE,
    );
    for (
      const table of [
        "users",
        "password_credentials",
        "browser_sessions",
        "encrypted_secrets",
        "model_provider_credentials",
      ]
    ) {
      const rows = await client.store.pool.query(`select * from ${table}`);
      for (const row of rows.rows) {
        const serialized = JSON.stringify(row);
        assert(!serialized.includes(TEST_MASTER_KEY_HEX), `master key material found in ${table}`);
        assert(!serialized.includes(OPENCODE_VALUE), `provider plaintext found in ${table}`);
      }
    }
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("rejects unknown providers, unauthenticated access, and missing CSRF", async () => {
  const client = await createAuthenticatedClient();
  try {
    const invalidProvider = await submitCredentialsForm(client, {
      intent: "save-provider",
      providerId: "not-a-pi-provider",
      apiKey: OPENCODE_VALUE,
    });
    assertEquals(invalidProvider.status, 400);
    assertEquals(await client.store.listModelProviderCredentials(client.userId), []);

    const anonymous = await fetch(new URL("/app/settings", client.server.baseUrl), {
      redirect: "manual",
    });
    assertEquals(anonymous.status, 401);

    const missingCsrf = await fetch(new URL("/app/settings", client.server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        intent: "save-provider",
        providerId: OPENCODE_PROVIDER,
        apiKey: OPENCODE_VALUE,
      }),
    });
    assertEquals(missingCsrf.status, 403);
    assertEquals(await client.store.listModelProviderCredentials(client.userId), []);
  } finally {
    await client.server.close();
    await client.store.close();
  }
});
