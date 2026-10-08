// This module runs inside the Workspace Durable Object, without Pi's Node callback server.
// Protocol: earendil-works/pi v1.1.0 packages/ai/src/auth/oauth/openai-codex.ts.

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
}

export interface DeviceLogin {
  id: string;
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: number;
  nextPollAt: number;
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com";
const REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_LIFETIME_MS = 900_000;

// These checks parse untrusted provider fields at the HTTP/JWT boundary.
function nonemptyString(value: unknown): value is string {
  // deno-lint-ignore openorb/no-runtime-typeof
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  // deno-lint-ignore openorb/no-runtime-typeof
  return typeof value === "number" && Number.isFinite(value);
}

function request(fetcher: typeof fetch, path: string, init: RequestInit): Promise<Response> {
  return fetcher(`${AUTH_URL}${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function startDeviceLogin(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<DeviceLogin> {
  try {
    const response = await request(fetcher, "/api/accounts/deviceauth/usercode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!response.ok) throw new Error();
    const data: {
      device_auth_id?: unknown;
      user_code?: unknown;
      interval?: unknown;
    } | null = await response.json();
    // Pi's custom protocol accepts both numeric and string intervals, including zero.
    // deno-lint-ignore openorb/no-runtime-typeof
    const interval = typeof data?.interval === "string" && data.interval.trim() !== ""
      ? Number(data.interval)
      : data?.interval;
    if (
      !nonemptyString(data?.device_auth_id) || !nonemptyString(data?.user_code) ||
      !finiteNumber(interval) || interval < 0 || !Number.isFinite(interval * 1000)
    ) throw new Error();
    const timestamp = now();
    return {
      id: crypto.randomUUID(),
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      verificationUri: `${AUTH_URL}/codex/device`,
      intervalSeconds: interval,
      expiresAt: timestamp + DEVICE_LIFETIME_MS,
      nextPollAt: timestamp,
    };
  } catch {
    // Never propagate provider bodies, status text, parse errors, or fetch error causes.
    throw new Error("OpenAI Codex device login could not be started.");
  }
}

async function readCredential(response: Response, now: () => number): Promise<OAuthCredential> {
  if (!response.ok) throw new Error();
  const data: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  } | null = await response.json();
  if (
    !nonemptyString(data?.access_token) || !nonemptyString(data?.refresh_token) ||
    !finiteNumber(data?.expires_in) || data.expires_in <= 0
  ) throw new Error();
  const expires = now() + data.expires_in * 1000;
  if (!Number.isFinite(expires) || expires <= 0) throw new Error();

  // Decode only: the provider issued the token; this is not JWT signature verification.
  const parts = data.access_token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) throw new Error();
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Uint8Array.from(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
  const claims: {
    "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
  } | null = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!nonemptyString(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id)) {
    throw new Error();
  }
  return { type: "oauth", access: data.access_token, refresh: data.refresh_token, expires };
}

export async function pollDeviceLogin(
  login: DeviceLogin,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<
  | { status: "pending"; login: DeviceLogin }
  | { status: "complete"; credential: OAuthCredential }
  | { status: "error" }
> {
  if (now() >= login.expiresAt) return { status: "error" };
  if (now() < login.nextPollAt) return { status: "pending", login };
  try {
    const response = await request(fetcher, "/api/accounts/deviceauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }),
    });
    if (now() >= login.expiresAt) return { status: "error" };
    if (response.ok) {
      const data: {
        authorization_code?: unknown;
        code_verifier?: unknown;
      } | null = await response.json();
      if (!nonemptyString(data?.authorization_code) || !nonemptyString(data?.code_verifier)) {
        return { status: "error" };
      }
      const exchanged = await request(fetcher, "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: data.authorization_code,
          code_verifier: data.code_verifier,
          redirect_uri: `${AUTH_URL}/deviceauth/callback`,
        }),
      });
      return { status: "complete", credential: await readCredential(exchanged, now) };
    }

    let intervalSeconds = login.intervalSeconds;
    // In this custom protocol 403 and 404 are pending regardless of the body.
    if (response.status !== 403 && response.status !== 404) {
      const data: { error?: string | { code?: unknown } } | null = await response.json();
      // deno-lint-ignore openorb/no-runtime-typeof
      const code = typeof data?.error === "string" ? data.error : data?.error?.code;
      if (code === "slow_down") intervalSeconds += 5;
      else if (code !== "deviceauth_authorization_pending") return { status: "error" };
    }
    return {
      status: "pending",
      login: {
        ...login,
        intervalSeconds,
        nextPollAt: Math.min(now() + Math.max(1, intervalSeconds) * 1000, login.expiresAt),
      },
    };
  } catch {
    return { status: "error" };
  }
}

export async function refreshOAuthCredential(
  credential: OAuthCredential,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<OAuthCredential> {
  try {
    const response = await request(fetcher, "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
        client_id: CLIENT_ID,
      }),
    });
    return await readCredential(response, now);
  } catch {
    throw new Error("OpenAI Codex credential could not be refreshed.");
  }
}

export async function revokeOAuthCredential(
  credential: OAuthCredential,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await request(fetcher, "/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: credential.refresh,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      }),
    });
    if (!response.ok) throw new Error();
  } catch {
    throw new Error("OpenAI Codex credential could not be revoked.");
  }
}
