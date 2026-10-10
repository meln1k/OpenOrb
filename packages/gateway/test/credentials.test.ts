import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertNotMatch,
  assertRejects,
} from "@std/assert";
import {
  MAX_SESSION_ENVIRONMENT_SECRETS,
  MAX_SESSION_SECRET_HOST_CHARACTERS,
  type UserId,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";
import { resolveSessionModelRuntime } from "@/app/model-provider-runtime.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "@/app/model-provider-catalog.ts";
import { createAppRouter } from "@/test/workspace-test.ts";
import { routes } from "@/app/routes.ts";
import { importMasterKey } from "@/app/utils/master-key.ts";
import { decryptSecret } from "@/app/utils/secret-cipher.ts";
import { createTestServer } from "@/test/http-test-server.ts";
import {
  activate,
  createAppServices,
  type MemoryStorage,
  TEST_MASTER_KEY_BYTES,
  TEST_MASTER_KEY_HEX,
} from "@/test/workspace-test.ts";

const OPENCODE_PROVIDER = "opencode-go";
const OPENCODE_VALUE = "oc-go-secret-7f3d9a";
const OPENAI_PROVIDER = "openai";
const OPENAI_VALUE = "sk-openai-secret-91e4b0";
const GENERIC_SECRET_KEY = "SERVICE_TOKEN";
const GENERIC_SECRET_VALUE = "generic-service-secret-42";
const PROVIDERS_SETTINGS_PATH = routes.app.settings.providers.index.href();
const RUNNERS_SETTINGS_PATH = routes.app.settings.runners.index.href();
const SECRETS_SETTINGS_PATH = routes.app.settings.secrets.index.href();

interface StoredProvider {
  id: string;
  providerId: string;
  credentialType: "api_key" | "oauth";
  key: string;
  keyVersion: number;
  ciphertext: ArrayBuffer;
}

function storedProviders(storage: MemoryStorage, workspaceId: WorkspaceId): StoredProvider[] {
  return storage.rows<StoredProvider>(
    `
    SELECT p.id, p.providerId, p.credentialType, s.key, s.keyVersion, s.ciphertext
    FROM model_provider_credentials p
    JOIN encrypted_secrets s ON s.workspaceId = p.workspaceId AND s.key = p.secretKey
    WHERE p.workspaceId = ? ORDER BY p.providerId
  `,
    workspaceId,
  );
}

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
  store: ReturnType<typeof activate>["workspace"];
  storage: MemoryStorage;
  server: Awaited<ReturnType<typeof createTestServer>>;
  cookie: string;
  userId: UserId;
  workspaceId: WorkspaceId;
}

async function createAuthenticatedClient(): Promise<AuthenticatedClient> {
  const { workspace: store, storage } = activate();
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
      storage,
      server,
      cookie: cookieFrom(loginResponse),
      userId: user.userId,
      workspaceId: user.workspaceId,
    };
  } catch (error) {
    await server.close();
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
    assertNotMatch(empty, /\/assets\/app\/actions\/settings\//);
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

    const rows = storedProviders(client.storage, client.workspaceId);
    assertEquals(rows.length, 2);
    const byProvider = new Map(rows.map((row) => [row.providerId, row]));
    const opencode = byProvider.get(OPENCODE_PROVIDER)!;
    const openai = byProvider.get(OPENAI_PROVIDER)!;
    assertEquals(opencode.credentialType, "api_key");
    assertEquals(openai.credentialType, "api_key");
    assertNotEquals(opencode.id, openai.id);
    assertNotEquals(opencode.key, openai.key);
    assertNotEquals(opencode.key, OPENCODE_PROVIDER);
    assertNotEquals(openai.key, OPENAI_PROVIDER);
    assert(!client.storage.dump().includes(OPENCODE_VALUE));
    assert(!client.storage.dump().includes(OPENAI_VALUE));

    const masterKey = await importMasterKey(TEST_MASTER_KEY_BYTES);
    for (const [row, apiKey] of [[opencode, OPENCODE_VALUE], [openai, OPENAI_VALUE]] as const) {
      assert(row.ciphertext instanceof ArrayBuffer);
      assertEquals(
        await decryptSecret(
          masterKey,
          { keyVersion: row.keyVersion, ciphertext: new Uint8Array(row.ciphertext) },
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
    const replaced = storedProviders(client.storage, client.workspaceId).find(
      (row) => row.providerId === OPENCODE_PROVIDER,
    );
    assert(replaced);
    assertEquals(replaced.id, opencode.id);
    assertEquals(replaced.key, opencode.key);
    assertNotEquals(new Uint8Array(replaced.ciphertext), new Uint8Array(opencode.ciphertext));
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
      client.storage.rows("SELECT id FROM model_provider_credentials").length,
      1,
    );
  } finally {
    await client.server.close();
  }
});

Deno.test("ChatGPT device authorization persists encrypted Workspace OAuth and disconnects locally", async () => {
  const client = await createAuthenticatedClient();
  const credential = { access: accessToken("original"), refresh: "chatgpt-refresh-token-5c7e12" };
  let loginCalls = 0;
  let revokeCalls = 0;
  const restoreFetch = providerFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/accounts/deviceauth/usercode") {
      return Response.json({
        device_auth_id: `device-${loginCalls}`,
        user_code: loginCalls++ === 0 ? "ABCD-EFGH" : "WXYZ-1234",
        interval: 0,
      });
    }
    if (path === "/api/accounts/deviceauth/token") {
      return Response.json({ authorization_code: "code", code_verifier: "verifier" });
    }
    if (path === "/oauth/revoke") {
      revokeCalls++;
      assertEquals((await request.json()).token, credential.refresh);
      return new Response("revocation unavailable", { status: 503 });
    }
    assertEquals(path, "/oauth/token");
    return Response.json({
      access_token: credential.access,
      refresh_token: credential.refresh,
      expires_in: 3600,
    });
  });
  try {
    const initial = await credentialsPage(client);
    assertMatch(initial, /ChatGPT subscription/);
    assertMatch(initial, /Sign in with ChatGPT/);
    assertMatch(initial, /OpenAI Codex/);
    assertNotMatch(initial, /value="openai-codex"/);

    const start = await submitCredentialsForm(client, PROVIDERS_SETTINGS_PATH, {
      intent: "start-chatgpt",
    });
    assertEquals(start.status, 303);
    const pendingPage = await credentialsPage(client);
    assertMatch(pendingPage, /ABCD-EFGH/);
    assertMatch(pendingPage, /Waiting for authorization/);
    assertMatch(pendingPage, /https:\/\/auth\.openai\.com\/codex\/device/);

    const pending = await submitCredentialsForm(client, PROVIDERS_SETTINGS_PATH, {
      intent: "poll-chatgpt",
    });
    assertEquals(pending.status, 200);
    await activate(client.storage).workspace.alarm();
    const complete = await fetch(new URL(PROVIDERS_SETTINGS_PATH, client.server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(pendingPage),
        intent: "poll-chatgpt",
      }),
    });
    assertEquals(complete.status, 303);
    assertEquals(
      await client.store.resolveProviderAccessToken(client.workspaceId),
      credential.access,
    );

    const connectedPage = await credentialsPage(client);
    assertMatch(connectedPage, /Connected · updated/);
    assertNotMatch(connectedPage, new RegExp(credential.access));
    assertNotMatch(connectedPage, new RegExp(credential.refresh));
    const stored = storedProviders(client.storage, client.workspaceId).find(
      (row) => row.providerId === OPENAI_CODEX_PROVIDER_ID,
    );
    assert(stored);
    assertEquals(stored.credentialType, "oauth");
    assert(stored.ciphertext instanceof ArrayBuffer);
    assert(!client.storage.dump().includes(credential.access));
    assert(!client.storage.dump().includes(credential.refresh));

    const reconnect = await submitCredentialsForm(client, PROVIDERS_SETTINGS_PATH, {
      intent: "start-chatgpt",
    });
    assertEquals(reconnect.status, 303);
    assertEquals(
      await client.store.resolveProviderAccessToken(client.workspaceId),
      credential.access,
    );
    const cancel = await submitCredentialsForm(client, PROVIDERS_SETTINGS_PATH, {
      intent: "cancel-chatgpt",
    });
    assertEquals(cancel.status, 303);
    assertEquals(client.storage.alarm, null);
    assertEquals(
      client.storage.rows(
        "SELECT id FROM provider_authorizations WHERE workspaceId = ?",
        client.workspaceId,
      ),
      [],
    );
    await activate(client.storage).workspace.alarm();
    assertEquals(loginCalls, 2);

    const disconnect = await submitCredentialsForm(client, PROVIDERS_SETTINGS_PATH, {
      intent: "disconnect-chatgpt",
    });
    assertEquals(disconnect.status, 303);
    assertEquals(revokeCalls, 1);
    assertEquals(
      await client.store.getModelProviderCredential(
        client.workspaceId,
        OPENAI_CODEX_PROVIDER_ID,
      ),
      null,
    );
  } finally {
    await client.server.close();
    restoreFetch();
  }
});

Deno.test("ChatGPT runtime refreshes rotation once and sends only the access token", async () => {
  const client = await createAuthenticatedClient();
  const expired = { access: accessToken("expired"), refresh: "rotating-refresh-token" };
  const rotated = { access: accessToken("fresh"), refresh: "fresh-refresh-token" };
  let refreshCalls = 0;
  const restoreFetch = providerFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/accounts/deviceauth/usercode") {
      return Response.json({ device_auth_id: "device", user_code: "ABCD-EFGH", interval: 0 });
    }
    if (path === "/api/accounts/deviceauth/token") {
      return Response.json({ authorization_code: "code", code_verifier: "verifier" });
    }
    assertEquals(path, "/oauth/token");
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") === "refresh_token") {
      refreshCalls++;
      assertEquals(form.get("refresh_token"), expired.refresh);
      return Response.json({
        access_token: rotated.access,
        refresh_token: rotated.refresh,
        expires_in: 3600,
      });
    }
    return Response.json({
      access_token: expired.access,
      refresh_token: expired.refresh,
      expires_in: 1,
    });
  });
  try {
    await client.store.startProviderLogin(client.workspaceId);
    await client.store.alarm();
    const [runtime, error] = await resolveSessionModelRuntime(
      client.workspaceId,
      "openai-codex/gpt-5.2-codex",
      client.store,
    );
    assertEquals(error, undefined);
    assertEquals(runtime?.credential, { type: "access_token", value: rotated.access });
    assertNotMatch(JSON.stringify(runtime), new RegExp(rotated.refresh));
    assertEquals(
      await activate(client.storage).workspace.resolveProviderAccessToken(client.workspaceId),
      rotated.access,
    );

    const [reused, reuseError] = await resolveSessionModelRuntime(
      client.workspaceId,
      "openai-codex/gpt-5.2-codex",
      client.store,
    );
    assertEquals(reuseError, undefined);
    assertEquals(reused?.credential, { type: "access_token", value: rotated.access });
    assertEquals(refreshCalls, 1);
  } finally {
    await client.server.close();
    restoreFetch();
  }
});

function accessToken(marker: string): string {
  const payload = new TextEncoder().encode(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "gateway-test-account" },
    marker,
  })).toBase64({ alphabet: "base64url", omitPadding: true });
  return `e30.${payload}.unverified-signature`;
}

/** Mock the external HTTP boundary only; authorization and alarm persistence are real Workspace. */
function providerFetch(handler: (request: Request) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== "https://auth.openai.com") return original(input, init);
    assertEquals(request.method, "POST");
    assertEquals(init?.redirect, "error");
    assert(init?.signal instanceof AbortSignal);
    return handler(request);
  };
  return () => {
    globalThis.fetch = original;
  };
}

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
    assertEquals(
      client.storage.rows("SELECT key FROM encrypted_secrets WHERE purpose = 'generic-secret'")
        .length,
      1,
    );
    assertEquals(client.storage.rows("SELECT id FROM model_provider_credentials").length, 1);
    const persisted = client.storage.dump();
    assert(!persisted.includes(GENERIC_SECRET_VALUE));
    assert(!persisted.includes(OPENCODE_VALUE));

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
  }
});

Deno.test("provider credentials remain decryptable across a gateway restart", async () => {
  const { workspace: first, storage } = activate();
  assertEquals(await first.createAdministrator("restart test password"), [true, undefined]);
  const user = await first.verifyAdministratorPassword("restart test password");
  assert(user);
  await first.saveModelProviderCredential(user.workspaceId, OPENCODE_PROVIDER, OPENCODE_VALUE);
  await first.saveModelProviderCredential(user.workspaceId, OPENAI_PROVIDER, OPENAI_VALUE);

  const restarted = activate(storage).workspace;
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
});

Deno.test("a wrong master key fails provider resolution without destroying stored data", async () => {
  const { workspace: first, storage } = activate();
  assertEquals(await first.createAdministrator("wrong key test password"), [true, undefined]);
  const user = await first.verifyAdministratorPassword("wrong key test password");
  assert(user);
  await first.saveModelProviderCredential(user.workspaceId, OPENCODE_PROVIDER, OPENCODE_VALUE);

  const wrongKeyWorkspace = activate(storage, "09".repeat(32)).workspace;
  const before = storage.dump();
  const error = await assertRejects(
    () => wrongKeyWorkspace.getModelProviderApiKey(user.workspaceId, OPENCODE_PROVIDER),
    Error,
  );
  assert(!error.message.includes(OPENCODE_VALUE));
  assertEquals(storage.dump(), before);

  const restored = activate(storage).workspace;
  assertEquals(await restored.getModelProviderApiKey(user.workspaceId, OPENCODE_PROVIDER), [
    OPENCODE_VALUE,
    undefined,
  ]);
});

Deno.test("provider plaintext and master key never enter gateway rows", async () => {
  const client = await createAuthenticatedClient();
  try {
    await client.store.saveModelProviderCredential(
      client.workspaceId,
      OPENCODE_PROVIDER,
      OPENCODE_VALUE,
    );
    const persisted = client.storage.dump();
    assert(!persisted.includes(TEST_MASTER_KEY_HEX), "master key material found in persisted rows");
    assert(!persisted.includes(OPENCODE_VALUE), "provider plaintext found in persisted rows");
  } finally {
    await client.server.close();
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
    assertEquals(anonymous.status, 302);
    assertEquals(anonymous.headers.get("location"), "/");

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
  }
});
