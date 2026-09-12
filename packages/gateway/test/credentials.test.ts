import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertNotEquals,
  assertNotMatch,
} from "@std/assert";
import {
  MAX_SESSION_ENVIRONMENT_SECRETS,
  MAX_SESSION_SECRET_HOST_CHARACTERS,
  type UserId,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";
import { array, number, object, parse, string } from "remix/data-schema";

import { ModelProviderCredentialReadError } from "@/app/data/model-provider-repository.ts";
import { createAppServices } from "@/app/middleware/services.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
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
const PROVIDERS_SETTINGS_PATH = routes.app.settings.providers.index.href();
const RUNNERS_SETTINGS_PATH = routes.app.settings.runners.index.href();
const SECRETS_SETTINGS_PATH = routes.app.settings.secrets.index.href();

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
  userId: UserId;
  workspaceId: WorkspaceId;
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
    const loginRequest = new Request(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(loginPage) },
      body: new URLSearchParams({
        _csrf: csrfFrom(await loginPage.text()),
        password: "[REDACTED:password] horse battery staple",
      }),
    });
    const loginForm = await loginRequest.clone().formData();
    const loginResponse = await fetch(loginRequest);
    assertEquals(loginResponse.status, 303);
    const user = await store.verifyAdministratorPassword(
      String(loginForm.get("password")),
    );
    assert(user);
    assertNotEquals<string>(user.userId, user.workspaceId);
    return {
      store,
      server,
      cookie: cookieFrom(loginResponse),
      userId: user.userId,
      workspaceId: user.workspaceId,
    };
  } catch (error) {
    await server.close();
    await store.close();
    throw error;
  }
}

async function credentialsPage(
  client: AuthenticatedClient,
  path = PROVIDERS_SETTINGS_PATH,
): Promise<string> {
  const response = await fetch(new URL(path, client.server.baseUrl), {
    headers: { Cookie: client.cookie },
  });
  assertEquals(response.status, 200);
  return response.text();
}

async function submitCredentialsForm(
  client: AuthenticatedClient,
  path: string,
  form: Record<string, string>,
): Promise<Response> {
  const page = await credentialsPage(client, path);
  return fetch(new URL(path, client.server.baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: client.cookie },
    body: new URLSearchParams({ _csrf: csrfFrom(page), ...form }),
  });
}

Deno.test("configures Pi providers without exposing or keying records by API key", async () => {
  const client = await createAuthenticatedClient();
  try {
    const settingsIndex = await fetch(
      new URL(routes.app.settings.index.href(), client.server.baseUrl),
      { redirect: "manual", headers: { Cookie: client.cookie } },
    );
    assertEquals(settingsIndex.status, 302);
    assertEquals(settingsIndex.headers.get("location"), PROVIDERS_SETTINGS_PATH);

    const empty = await credentialsPage(client);
    assertMatch(empty, /<title>Settings<\/title>/);
    assertMatch(empty, /Model providers/);
    assertMatch(empty, /No model providers configured\./);
    assertMatch(empty, /name="providerId"/);
    assertMatch(empty, /value="opencode-go"/);
    assertMatch(empty, /name="apiKey"/);
    assertNotMatch(empty, /Generic secrets/);
    assertMatch(empty, /<nav aria-label="Settings sections"/);
    assertMatch(empty, /href="\/app\/settings\/providers" aria-current="page"/);
    assertNotMatch(empty, /rmx-document/);
    assertMatch(empty, /href="\/app" aria-label="Close settings"/);
    assertNotMatch(empty, /data-slot="tabs"/);
    assertNotMatch(empty, /\/assets\/app\/ui\/settings\//);
    assertNotMatch(empty, /OPENCODE_API_KEY/);
    assertNotMatch(empty, new RegExp(OPENCODE_VALUE));

    const secrets = await credentialsPage(client, SECRETS_SETTINGS_PATH);
    assertMatch(secrets, /Generic secrets/);
    assertMatch(secrets, /name="key"/);
    assertNotMatch(secrets, /Model providers/);

    const runners = await credentialsPage(client, RUNNERS_SETTINGS_PATH);
    assertMatch(runners, /Runner enrollment/);
    assertMatch(runners, /No runners enrolled/);
    assertNotMatch(runners, /Model providers/);
    assertNotMatch(runners, /Copy command/);

    for (
      const [providerId, apiKey] of [
        [OPENCODE_PROVIDER, OPENCODE_VALUE],
        [OPENAI_PROVIDER, OPENAI_VALUE],
      ] as const
    ) {
      const response = await submitCredentialsForm(
        client,
        PROVIDERS_SETTINGS_PATH,
        { intent: "save-provider", providerId, apiKey },
      );
      assertEquals(response.status, 303);
      assertEquals(response.headers.get("location"), PROVIDERS_SETTINGS_PATH);
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
          { workspaceId: client.workspaceId, key: row.key },
        ),
        [apiKey, undefined],
      );
    }

    const replacement = "oc-go-replacement-secret-5c7e12";
    const replaceResponse = await submitCredentialsForm(
      client,
      PROVIDERS_SETTINGS_PATH,
      {
        intent: "save-provider",
        providerId: OPENCODE_PROVIDER,
        apiKey: replacement,
      },
    );
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
    assertEquals(await client.store.getModelProviderApiKey(client.workspaceId, OPENCODE_PROVIDER), [
      replacement,
      undefined,
    ]);

    const deleteResponse = await submitCredentialsForm(
      client,
      PROVIDERS_SETTINGS_PATH,
      {
        intent: "delete-provider",
        providerId: OPENAI_PROVIDER,
      },
    );
    assertEquals(deleteResponse.status, 303);
    assertEquals(
      await client.store.getModelProviderCredential(client.workspaceId, OPENAI_PROVIDER),
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
      client.workspaceId,
      OPENCODE_PROVIDER,
      OPENCODE_VALUE,
    );
    const saveResponse = await submitCredentialsForm(
      client,
      SECRETS_SETTINGS_PATH,
      {
        intent: "save-secret",
        key: GENERIC_SECRET_KEY,
        value: GENERIC_SECRET_VALUE,
        allowedHosts: "api.example.com, *.service.example",
      },
    );
    assertEquals(saveResponse.status, 303);
    assertEquals(saveResponse.headers.get("location"), SECRETS_SETTINGS_PATH);

    assertEquals(await client.store.listSecrets(client.workspaceId), [{
      key: GENERIC_SECRET_KEY,
      keyVersion: 1,
      allowedHosts: ["api.example.com", "*.service.example"],
      createdAt: (await client.store.getSecret(client.workspaceId, GENERIC_SECRET_KEY))!.createdAt,
      updatedAt: (await client.store.getSecret(client.workspaceId, GENERIC_SECRET_KEY))!.updatedAt,
    }]);
    const [environmentSecrets, environmentSecretError] = await client.store.getEnvironmentSecrets(
      client.workspaceId,
    );
    assertEquals(environmentSecretError, undefined);
    assertEquals(
      environmentSecrets?.map(({ name, value, allowedHosts }) => ({ name, value, allowedHosts })),
      [{
        name: GENERIC_SECRET_KEY,
        value: GENERIC_SECRET_VALUE,
        allowedHosts: ["api.example.com", "*.service.example"],
      }],
    );
    assertEquals(
      (await client.store.listModelProviderCredentials(client.workspaceId)).map((credential) =>
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

    const page = await credentialsPage(client, SECRETS_SETTINGS_PATH);
    assertMatch(page, new RegExp(GENERIC_SECRET_KEY));
    assertMatch(page, /api\.example\.com, \*\.service\.example/);
    assertNotMatch(page, new RegExp(GENERIC_SECRET_VALUE));
    assertNotMatch(page, new RegExp(OPENCODE_VALUE));

    assertEquals(
      await client.store.deleteModelProviderCredential(client.workspaceId, OPENCODE_PROVIDER),
      {
        status: "deleted",
      },
    );
    assert(await client.store.getSecret(client.workspaceId, GENERIC_SECRET_KEY));

    const deleteResponse = await submitCredentialsForm(
      client,
      SECRETS_SETTINGS_PATH,
      {
        intent: "delete-secret",
        key: GENERIC_SECRET_KEY,
      },
    );
    assertEquals(deleteResponse.status, 303);
    assertEquals(await client.store.listSecrets(client.workspaceId), []);
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("generic secrets enforce protocol host boundaries", async () => {
  const client = await createAuthenticatedClient();
  try {
    const wildcardResponse = await submitCredentialsForm(client, SECRETS_SETTINGS_PATH, {
      intent: "save-secret",
      key: GENERIC_SECRET_KEY,
      value: GENERIC_SECRET_VALUE,
      allowedHosts: "",
    });
    assertEquals(wildcardResponse.status, 303);
    assertEquals(
      (await client.store.getSecret(client.workspaceId, GENERIC_SECRET_KEY))?.allowedHosts,
      undefined,
    );

    const maximumLengthHost = [
      "a".repeat(63),
      "b".repeat(63),
      "c".repeat(63),
      "d".repeat(61),
    ].join(".");
    assertEquals(maximumLengthHost.length, MAX_SESSION_SECRET_HOST_CHARACTERS);
    const maximumLengthResponse = await submitCredentialsForm(client, SECRETS_SETTINGS_PATH, {
      intent: "save-secret",
      key: "MAXIMUM_HOST_TOKEN",
      value: "maximum-host-secret",
      allowedHosts: maximumLengthHost,
    });
    assertEquals(maximumLengthResponse.status, 303);

    const excessiveLengthResponse = await submitCredentialsForm(client, SECRETS_SETTINGS_PATH, {
      intent: "save-secret",
      key: "EXCESSIVE_HOST_TOKEN",
      value: "excessive-host-secret",
      allowedHosts: `${maximumLengthHost}e`,
    });
    assertEquals(excessiveLengthResponse.status, 400);
    assertMatch(await excessiveLengthResponse.text(), /at most 253 characters/);
    assertEquals(await client.store.getSecret(client.workspaceId, "EXCESSIVE_HOST_TOKEN"), null);

    const invalidResponse = await submitCredentialsForm(client, SECRETS_SETTINGS_PATH, {
      intent: "save-secret",
      key: "OTHER_TOKEN",
      value: "other-secret",
      allowedHosts: "https://api.example.com/path",
    });
    assertEquals(invalidResponse.status, 400);
    assertMatch(await invalidResponse.text(), /Enter at most 32 hostnames/);
    assertEquals(await client.store.getSecret(client.workspaceId, "OTHER_TOKEN"), null);
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("generic secrets enforce the protocol count while allowing updates", async () => {
  const client = await createAuthenticatedClient();
  try {
    for (let index = 0; index < MAX_SESSION_ENVIRONMENT_SECRETS; index++) {
      const result = await client.store.saveSecret(
        client.workspaceId,
        `SERVICE_TOKEN_${index}`,
        `service-secret-${index}`,
      );
      assertEquals(result.status, "saved");
    }

    assertEquals(
      await client.store.saveSecret(
        client.workspaceId,
        "DIRECT_OVERFLOW_TOKEN",
        "direct-overflow-secret",
      ),
      { status: "limit-exceeded" },
    );
    const overflowResponse = await submitCredentialsForm(client, SECRETS_SETTINGS_PATH, {
      intent: "save-secret",
      key: "FORM_OVERFLOW_TOKEN",
      value: "form-overflow-secret",
      allowedHosts: "api.example.com",
    });
    assertEquals(overflowResponse.status, 400);
    assertMatch(await overflowResponse.text(), /at most 64 generic secrets/);
    assertEquals(await client.store.getSecret(client.workspaceId, "FORM_OVERFLOW_TOKEN"), null);

    const updateResponse = await submitCredentialsForm(client, SECRETS_SETTINGS_PATH, {
      intent: "save-secret",
      key: "SERVICE_TOKEN_0",
      value: "updated-service-secret",
      allowedHosts: "api.example.com",
    });
    assertEquals(updateResponse.status, 303);
    assertEquals((await client.store.listSecrets(client.workspaceId)).length, 64);
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("generic secrets reject aggregate RPC frame overflow", async () => {
  const client = await createAuthenticatedClient();
  try {
    const escapedValue = "\0".repeat(4_096);
    for (let index = 0; index < 31; index++) {
      const result = await client.store.saveSecret(
        client.workspaceId,
        `ESCAPED_TOKEN_${index}`,
        escapedValue,
      );
      assertEquals(result.status, "saved");
    }

    const overflowResponse = await submitCredentialsForm(client, SECRETS_SETTINGS_PATH, {
      intent: "save-secret",
      key: "ESCAPED_TOKEN_31",
      value: escapedValue,
      allowedHosts: "",
    });
    assertEquals(overflowResponse.status, 400);
    assertMatch(await overflowResponse.text(), /too large to send to a runner/);
    assertEquals(await client.store.getSecret(client.workspaceId, "ESCAPED_TOKEN_31"), null);
    assertEquals((await client.store.listSecrets(client.workspaceId)).length, 31);
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
  await first.saveModelProviderCredential(user.workspaceId, OPENCODE_PROVIDER, OPENCODE_VALUE);
  await first.saveModelProviderCredential(user.workspaceId, OPENAI_PROVIDER, OPENAI_VALUE);
  await first.close();

  const restarted = await createTestStore(undefined, false);
  try {
    assertEquals(
      (await restarted.listModelProviderCredentials(user.workspaceId)).map((credential) =>
        credential.providerId
      ),
      [OPENAI_PROVIDER, OPENCODE_PROVIDER],
    );
    assertEquals(await restarted.getModelProviderApiKey(user.workspaceId, OPENCODE_PROVIDER), [
      OPENCODE_VALUE,
      undefined,
    ]);
    assertEquals(await restarted.getModelProviderApiKey(user.workspaceId, OPENAI_PROVIDER), [
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
  await first.saveModelProviderCredential(user.workspaceId, OPENCODE_PROVIDER, OPENCODE_VALUE);
  await first.close();

  const wrongKeyStore = await createTestStore(
    await importMasterKey(new Uint8Array(32).fill(9)),
    false,
  );
  try {
    const [value, error] = await wrongKeyStore.getModelProviderApiKey(
      user.workspaceId,
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
    assertEquals(await restored.getModelProviderApiKey(user.workspaceId, OPENCODE_PROVIDER), [
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
      client.workspaceId,
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
    const invalidProvider = await submitCredentialsForm(
      client,
      PROVIDERS_SETTINGS_PATH,
      {
        intent: "save-provider",
        providerId: "not-a-pi-provider",
        apiKey: OPENCODE_VALUE,
      },
    );
    assertEquals(invalidProvider.status, 400);
    assertEquals(await client.store.listModelProviderCredentials(client.workspaceId), []);

    const anonymous = await fetch(new URL(PROVIDERS_SETTINGS_PATH, client.server.baseUrl), {
      redirect: "manual",
    });
    assertEquals(anonymous.status, 401);

    const missingCsrf = await fetch(new URL(PROVIDERS_SETTINGS_PATH, client.server.baseUrl), {
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
    assertEquals(await client.store.listModelProviderCredentials(client.workspaceId), []);
  } finally {
    await client.server.close();
    await client.store.close();
  }
});
