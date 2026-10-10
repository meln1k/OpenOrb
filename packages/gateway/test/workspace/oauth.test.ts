import { assert, assertEquals, assertMatch, assertNotMatch, assertRejects } from "@std/assert";
import {
  type DeviceLogin,
  type OAuthCredential,
  pollDeviceLogin,
  refreshOAuthCredential,
  revokeOAuthCredential,
  startDeviceLogin,
} from "../../app/cells/workspace/oauth.ts";

const NOW = 1_700_000_000_000;
const clock = () => NOW;
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const login: DeviceLogin = {
  id: "attempt-id",
  deviceAuthId: "device-id",
  userCode: "ABCD-EFGH",
  verificationUri: "https://auth.openai.com/codex/device",
  intervalSeconds: 5,
  expiresAt: NOW + 900_000,
  nextPollAt: NOW,
};
const credential: OAuthCredential = {
  type: "oauth",
  access: "old-access-secret",
  refresh: "old-refresh-secret",
  expires: NOW - 1,
};

function jwt(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `e30.${encoded}.unverified-signature`;
}

const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-😀" } });
const tokens = { access_token: access, refresh_token: "new-refresh-secret", expires_in: 3600 };
const authorization = { authorization_code: "auth+code", code_verifier: "verifier/secret" };

function mockFetch(...replies: (Response | Error)[]) {
  const requests: Request[] = [];
  const fetcher: typeof fetch = (input, init) => {
    assert(init?.signal instanceof AbortSignal, "each request must have a timeout signal");
    assertEquals(init.signal.aborted, false);
    assertEquals(init.redirect, "error");
    requests.push(new Request(input, init));
    const reply = replies.shift();
    assert(reply, "unexpected extra HTTP request");
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  };
  return { fetcher, requests };
}

async function assertRequest(
  request: Request | undefined,
  url: string,
  contentType: string,
  body: string,
): Promise<void> {
  assert(request);
  assertEquals(request.url, url);
  assertEquals(request.method, "POST");
  assertEquals(request.headers.get("Content-Type"), contentType);
  assertEquals(await request.text(), body);
  assertEquals(request.headers.get("Authorization"), null);
}

Deno.test("device start uses the custom Codex protocol and allows an immediate first poll", async () => {
  const mock = mockFetch(
    Response.json({ device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: " 5 " }),
  );
  const result = await startDeviceLogin(mock.fetcher, clock);
  assertMatch(result.id, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
  assertEquals(result, { ...login, id: result.id });
  assertEquals(mock.requests.length, 1);
  await assertRequest(
    mock.requests[0],
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
    "application/json",
    '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}',
  );
});

Deno.test("device start accepts numeric and zero intervals", async () => {
  for (const interval of [0, 5, "0"]) {
    const mock = mockFetch(Response.json({ device_auth_id: "id", user_code: "code", interval }));
    const result = await startDeviceLogin(mock.fetcher, clock);
    assertEquals(result.intervalSeconds, Number(interval));
  }
});

Deno.test("device start rejects invalid fields without exposing provider data", async (t) => {
  const valid = { device_auth_id: "id", user_code: "code", interval: 5 };
  const invalid = [
    null,
    [],
    {},
    { ...valid, device_auth_id: 123 },
    { ...valid, user_code: " " },
    ...[-1, "", " ", "NaN", "Infinity", true, null, 1e308].map((interval) => ({
      ...valid,
      interval,
    })),
  ];
  for (const [index, data] of invalid.entries()) {
    await t.step(`invalid response ${index}`, async () => {
      const mock = mockFetch(Response.json(data));
      const error = await assertRejects(() => startDeviceLogin(mock.fetcher, clock), Error);
      assertEquals(error.message, "OpenAI Codex device login could not be started.");
      assertEquals(error.cause, undefined);
    });
  }
});

Deno.test("poll classifies 403/404 and custom pending errors, sends only device IDs", async (t) => {
  const cases = [
    new Response("private provider body", { status: 403 }),
    Response.json({ error: "access_denied" }, { status: 404 }),
    Response.json({ error: "deviceauth_authorization_pending" }, { status: 400 }),
    Response.json({ error: { code: "deviceauth_authorization_pending" } }, { status: 401 }),
  ];
  for (const [index, response] of cases.entries()) {
    await t.step(`pending response ${index}`, async () => {
      const mock = mockFetch(response);
      assertEquals(await pollDeviceLogin(login, mock.fetcher, clock), {
        status: "pending",
        login: { ...login, nextPollAt: NOW + 5000 },
      });
      assertEquals(mock.requests.length, 1);
      await assertRequest(
        mock.requests[0],
        "https://auth.openai.com/api/accounts/deviceauth/token",
        "application/json",
        '{"device_auth_id":"device-id","user_code":"ABCD-EFGH"}',
      );
      assertEquals(login.nextPollAt, NOW, "input is not mutated");
    });
  }
});

Deno.test("slow_down increases the persisted interval by five seconds on each poll", async () => {
  const mock = mockFetch(
    Response.json({ error: "slow_down" }, { status: 429 }),
    Response.json({ error: { code: "slow_down" } }, { status: 400 }),
  );
  const first = await pollDeviceLogin(login, mock.fetcher, clock);
  assertEquals(first, {
    status: "pending",
    login: { ...login, intervalSeconds: 10, nextPollAt: NOW + 10_000 },
  });
  assert(first.status === "pending");
  assertEquals(await pollDeviceLogin(first.login, mock.fetcher, () => NOW + 10_000), {
    status: "pending",
    login: { ...login, intervalSeconds: 15, nextPollAt: NOW + 25_000 },
  });
  assertEquals(mock.requests.length, 2);
});

Deno.test("poll respects deadlines and expiry without HTTP or loops", async () => {
  const mock = mockFetch();
  const later = { ...login, nextPollAt: NOW + 5000 };
  assertEquals(await pollDeviceLogin(later, mock.fetcher, clock), {
    status: "pending",
    login: later,
  });
  assertEquals(await pollDeviceLogin(login, mock.fetcher, () => login.expiresAt), {
    status: "error",
  });
  assertEquals(await pollDeviceLogin(login, mock.fetcher, () => login.expiresAt + 1), {
    status: "error",
  });
  assertEquals(mock.requests.length, 0);
  const pending = mockFetch(new Response(null, { status: 403 }));
  assertEquals(await pollDeviceLogin(login, pending.fetcher, () => login.expiresAt - 1), {
    status: "pending",
    login: { ...login, nextPollAt: login.expiresAt },
  });
});

Deno.test("expiry during a network poll prevents code exchange", async () => {
  let time = NOW;
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    time = login.expiresAt;
    return Promise.resolve(Response.json(authorization));
  };
  assertEquals(await pollDeviceLogin(login, fetcher, () => time), { status: "error" });
  assertEquals(calls, 1);
});

Deno.test("authorized device code is exchanged once using the device callback, not device grant", async () => {
  const mock = mockFetch(
    Response.json(authorization),
    Response.json({ ...tokens, accountId: "discard", id_token: "discard" }),
  );
  const result = await pollDeviceLogin(login, mock.fetcher, clock);
  assertEquals(result, {
    status: "complete",
    credential: { type: "oauth", access, refresh: "new-refresh-secret", expires: NOW + 3_600_000 },
  });
  assertEquals(mock.requests.length, 2);
  await assertRequest(
    mock.requests[1],
    "https://auth.openai.com/oauth/token",
    "application/x-www-form-urlencoded",
    "grant_type=authorization_code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code=auth%2Bcode&code_verifier=verifier%2Fsecret&redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback",
  );
});

Deno.test("poll returns a redacted fatal result for non-custom errors and malformed success", async (t) => {
  const responses = [
    Response.json({ error: "authorization_pending" }, { status: 400 }),
    Response.json({ error: "access_denied", token: "secret" }, { status: 401 }),
    Response.json({ error: "expired_token" }, { status: 400 }),
    new Response("secret", { status: 500 }),
    new Response("not json secret"),
    ...[null, {}, { authorization_code: 1, code_verifier: "secret" }, {
      ...authorization,
      code_verifier: "",
    }].map((data) => Response.json(data)),
    new Error("network echoed secret"),
    new DOMException("timeout echoed secret", "TimeoutError"),
  ];
  for (const [index, reply] of responses.entries()) {
    await t.step(`fatal response ${index}`, async () => {
      const mock = mockFetch(reply);
      assertEquals(await pollDeviceLogin(login, mock.fetcher, clock), { status: "error" });
      assertEquals(mock.requests.length, 1);
    });
  }
});

Deno.test("refresh requires rotated credentials and retains only the credential contract", async () => {
  const mock = mockFetch(Response.json({ ...tokens, accountId: "discard", scope: "discard" }));
  assertEquals(await refreshOAuthCredential(credential, mock.fetcher, clock), {
    type: "oauth",
    access,
    refresh: "new-refresh-secret",
    expires: NOW + 3_600_000,
  });
  assertEquals(credential.refresh, "old-refresh-secret");
  assertEquals(mock.requests.length, 1);
  await assertRequest(
    mock.requests[0],
    "https://auth.openai.com/oauth/token",
    "application/x-www-form-urlencoded",
    "grant_type=refresh_token&refresh_token=old-refresh-secret&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
  );
});

Deno.test("exchange and refresh reject missing tokens, invalid expiry and account claims", async (t) => {
  const invalid = [
    null,
    [],
    {},
    { ...tokens, access_token: "" },
    { ...tokens, access_token: 42 },
    { ...tokens, refresh_token: undefined },
    { ...tokens, refresh_token: " " },
    ...[undefined, 0, -1, "3600", null, 1e308].map((expires_in) => ({ ...tokens, expires_in })),
    ...[
      "not-a-jwt",
      "e30.%%%.sig",
      jwt(null),
      jwt({}),
      jwt({ "https://api.openai.com/auth": null }),
      ...["", " ", 42, null].map((chatgpt_account_id) =>
        jwt({ "https://api.openai.com/auth": { chatgpt_account_id } })
      ),
    ].map((access_token) => ({ ...tokens, access_token })),
  ];
  for (const [index, data] of invalid.entries()) {
    await t.step(`invalid token response ${index}`, async () => {
      const refresh = mockFetch(Response.json(data));
      const error = await assertRejects(
        () => refreshOAuthCredential(credential, refresh.fetcher, clock),
        Error,
      );
      assertEquals(error.message, "OpenAI Codex credential could not be refreshed.");
      assertEquals(error.cause, undefined);
      const exchange = mockFetch(Response.json(authorization), Response.json(data));
      assertEquals(await pollDeviceLogin(login, exchange.fetcher, clock), { status: "error" });
      assertEquals(exchange.requests.length, 2);
    });
  }
  const infinite = mockFetch(
    new Response(`{"access_token":"${access}","refresh_token":"secret","expires_in":1e400}`),
  );
  await assertRejects(() => refreshOAuthCredential(credential, infinite.fetcher, clock));
});

Deno.test("revoke sends the refresh token as JSON and propagates failure for parent policy", async () => {
  const mock = mockFetch(new Response(null, { status: 204 }));
  await revokeOAuthCredential(credential, mock.fetcher);
  assertEquals(mock.requests.length, 1);
  await assertRequest(
    mock.requests[0],
    "https://auth.openai.com/oauth/revoke",
    "application/json",
    JSON.stringify({
      token: "old-refresh-secret",
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    }),
  );
});

Deno.test("all OAuth HTTP operations use bounded AbortSignal.timeout requests", async () => {
  const originalTimeout = AbortSignal.timeout;
  const deadlines: number[] = [];
  AbortSignal.timeout = (milliseconds) => {
    deadlines.push(milliseconds);
    return originalTimeout(milliseconds);
  };
  try {
    const start = mockFetch(
      Response.json({ device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: 5 }),
    );
    await startDeviceLogin(start.fetcher, clock);
    const exchange = mockFetch(Response.json(authorization), Response.json(tokens));
    await pollDeviceLogin(login, exchange.fetcher, clock);
    const refresh = mockFetch(Response.json(tokens));
    await refreshOAuthCredential(credential, refresh.fetcher, clock);
    const revoke = mockFetch(new Response(null, { status: 204 }));
    await revokeOAuthCredential(credential, revoke.fetcher);
    assertEquals(deadlines, [15_000, 15_000, 15_000, 15_000, 15_000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

Deno.test("HTTP, JSON, network, and timeout failures do not leak bodies, tokens, or causes", async (t) => {
  const failures = [
    () =>
      new Response("provider-secret old-refresh-secret", {
        status: 400,
        statusText: "provider-secret",
      }),
    () => new Response("invalid JSON provider-secret"),
    () => new Error("network leaked provider-secret old-refresh-secret"),
    () => new DOMException("timeout leaked provider-secret", "TimeoutError"),
  ];
  for (const [index, failure] of failures.entries()) {
    await t.step(`redacted failure ${index}`, async () => {
      const start = mockFetch(failure());
      const refresh = mockFetch(failure());
      const revoke = mockFetch(failure());
      // A 2xx revoke has no response fields to parse; malformed JSON is immaterial.
      const operations = [
        () => startDeviceLogin(start.fetcher, clock),
        () => refreshOAuthCredential(credential, refresh.fetcher, clock),
        ...(index === 1 ? [] : [() => revokeOAuthCredential(credential, revoke.fetcher)]),
      ];
      for (const operation of operations) {
        const error = await assertRejects(operation, Error);
        assertNotMatch(error.message + error.stack, /provider-secret|old-refresh-secret/u);
        assertEquals(error.cause, undefined);
      }
      const exchange = mockFetch(Response.json(authorization), failure());
      assertEquals(await pollDeviceLogin(login, exchange.fetcher, clock), { status: "error" });
    });
  }
});
