import assert from "node:assert/strict";
import test from "node:test";

import { createTestServer } from "remix/node-fetch-server/test";

import { createAppRouter } from "../app/router.ts";
import { createControlRuntime } from "../app/data/runtime.ts";
import { createTestStore } from "./postgres-test.ts";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "expected a Set-Cookie header");
  return value.split(";", 1)[0]!;
}

function csrfFrom(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, "expected a CSRF form field");
  return match[1]!;
}

test("sets up an administrator, rotates sessions on login, and logs out", async () => {
  const store = await createTestStore();
  const router = createAppRouter(createControlRuntime(store));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const setupUrl = new URL("/auth/setup", server.baseUrl);
    const setupPage = await fetch(setupUrl);
    assert.equal(setupPage.status, 200);
    const setupCookie = cookieFrom(setupPage);
    const setupToken = csrfFrom(await setupPage.text());

    const missingCsrf = await fetch(setupUrl, {
      method: "POST",
      headers: { Cookie: setupCookie },
      body: new URLSearchParams({
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
      }),
    });
    assert.equal(missingCsrf.status, 403);

    const setupResponse = await fetch(setupUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: setupCookie },
      body: new URLSearchParams({
        _csrf: setupToken,
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
      }),
    });
    assert.equal(setupResponse.status, 303);
    assert.equal(setupResponse.headers.get("location"), "/auth/login");
    assert.equal(await store.hasAdministrator(), true);

    const setupAgain = await fetch(setupUrl, { redirect: "manual" });
    assert.equal(setupAgain.status, 303);
    assert.equal(setupAgain.headers.get("location"), "/auth/login");

    const loginUrl = new URL("/auth/login", server.baseUrl);
    const loginPage = await fetch(loginUrl, { headers: { Cookie: setupCookie } });
    assert.equal(loginPage.status, 200);
    const loginToken = csrfFrom(await loginPage.text());

    const invalidLogin = await fetch(loginUrl, {
      method: "POST",
      headers: { Cookie: setupCookie },
      body: new URLSearchParams({ _csrf: loginToken, password: "not the password" }),
    });
    assert.equal(invalidLogin.status, 401);
    assert.match(await invalidLogin.text(), /Invalid password/);

    const loginResponse = await fetch(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: setupCookie },
      body: new URLSearchParams({
        _csrf: loginToken,
        password: "correct horse battery staple",
      }),
    });
    assert.equal(loginResponse.status, 303);
    assert.equal(loginResponse.headers.get("location"), "/app");
    const authenticatedCookie = cookieFrom(loginResponse);
    assert.notEqual(authenticatedCookie, setupCookie);

    const appUrl = new URL("/app", server.baseUrl);
    const appResponse = await fetch(appUrl, {
      headers: { Cookie: authenticatedCookie },
    });
    assert.equal(appResponse.status, 200);
    const appHtml = await appResponse.text();
    assert.match(appHtml, /Authenticated control panel/);
    const logoutToken = csrfFrom(appHtml);

    const oldSessionResponse = await fetch(appUrl, {
      redirect: "manual",
      headers: { Cookie: setupCookie },
    });
    assert.equal(oldSessionResponse.status, 401);

    const logoutResponse = await fetch(new URL("/auth/logout", server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: authenticatedCookie },
      body: new URLSearchParams({ _csrf: logoutToken }),
    });
    assert.equal(logoutResponse.status, 303);
    assert.equal(logoutResponse.headers.get("location"), "/auth/login");
    assert.match(logoutResponse.headers.get("set-cookie") ?? "", /openorb_session=/);

    const afterLogout = await fetch(appUrl, {
      redirect: "manual",
      headers: { Cookie: authenticatedCookie },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await server.close();
    await store.close();
  }
});

test("rejects invalid setup input", async () => {
  const store = await createTestStore();

  try {
    const router = createAppRouter(createControlRuntime(store));
    const response = await router.fetch(
      new Request("http://localhost/auth/setup", {
        method: "POST",
        body: new URLSearchParams({
          password: "short",
          confirmPassword: "different",
        }),
      }),
    );

    assert.equal(response.status, 403);
  } finally {
    await store.close();
  }
});
