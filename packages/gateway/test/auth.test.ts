import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { v7 } from "@std/uuid";

import { createAppRouter } from "@/app/router.ts";
import { createAppServices } from "@/app/middleware/services.ts";
import { createTestServer } from "@/test/http-test-server.ts";
import { createTestStore } from "@/test/postgres-test.ts";

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

Deno.test("sets up an administrator, rotates sessions on login, and logs out", async () => {
  const store = await createTestStore();
  const router = createAppRouter(createAppServices(store));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const setupUrl = new URL("/auth/setup", server.baseUrl);
    const setupPage = await fetch(setupUrl);
    assertEquals(setupPage.status, 200);
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
    assertEquals(missingCsrf.status, 403);

    const opaqueOrigin = await fetch(setupUrl, {
      method: "POST",
      headers: { Cookie: setupCookie, Origin: "null" },
      body: new URLSearchParams({
        _csrf: setupToken,
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
      }),
    });
    assertEquals(opaqueOrigin.status, 403);

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
    assertEquals(setupResponse.status, 303);
    assertEquals(setupResponse.headers.get("location"), "/auth/login");
    assertEquals(await store.hasAdministrator(), true);
    const administrators = await store.pool.query<{ id: string }>(
      "select id from users where is_administrator",
    );
    assertEquals(administrators.rows.length, 1);
    assert(v7.validate(administrators.rows[0]!.id));

    const setupAgain = await fetch(setupUrl, { redirect: "manual" });
    assertEquals(setupAgain.status, 303);
    assertEquals(setupAgain.headers.get("location"), "/auth/login");

    const loginUrl = new URL("/auth/login", server.baseUrl);
    const loginPage = await fetch(loginUrl, { headers: { Cookie: setupCookie } });
    assertEquals(loginPage.status, 200);
    const loginToken = csrfFrom(await loginPage.text());

    const invalidLogin = await fetch(loginUrl, {
      method: "POST",
      headers: { Cookie: setupCookie },
      body: new URLSearchParams({ _csrf: loginToken, password: "not the password" }),
    });
    assertEquals(invalidLogin.status, 401);
    assertMatch(await invalidLogin.text(), /Invalid password/);

    const loginResponse = await fetch(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: setupCookie },
      body: new URLSearchParams({
        _csrf: loginToken,
        password: "correct horse battery staple",
      }),
    });
    assertEquals(loginResponse.status, 303);
    assertEquals(loginResponse.headers.get("location"), "/app");
    const authenticatedCookie = cookieFrom(loginResponse);
    assertNotEquals(authenticatedCookie, setupCookie);

    const appUrl = new URL("/app", server.baseUrl);
    const appResponse = await fetch(appUrl, {
      headers: { Cookie: authenticatedCookie },
    });
    assertEquals(appResponse.status, 200);
    const appHtml = await appResponse.text();
    assertMatch(appHtml, /Authenticated gateway/);
    const logoutToken = csrfFrom(appHtml);

    const oldSessionResponse = await fetch(appUrl, {
      redirect: "manual",
      headers: { Cookie: setupCookie },
    });
    assertEquals(oldSessionResponse.status, 401);

    const logoutResponse = await fetch(new URL("/auth/logout", server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: authenticatedCookie },
      body: new URLSearchParams({ _csrf: logoutToken }),
    });
    assertEquals(logoutResponse.status, 303);
    assertEquals(logoutResponse.headers.get("location"), "/auth/login");
    assertMatch(logoutResponse.headers.get("set-cookie") ?? "", /openorb_session=/);

    const afterLogout = await fetch(appUrl, {
      redirect: "manual",
      headers: { Cookie: authenticatedCookie },
    });
    assertEquals(afterLogout.status, 401);
  } finally {
    await server.close();
    await store.close();
  }
});

Deno.test("rejects malformed persisted password material", async () => {
  const store = await createTestStore();

  try {
    assertEquals(await store.createAdministrator("correct horse battery staple"), [
      true,
      undefined,
    ]);
    const administrator = await store.verifyAdministratorPassword(
      "correct horse battery staple",
    );
    assert(administrator);
    await store.pool.query(
      "update password_credentials set salt = 'AA==' where user_id = $1",
      [administrator.id],
    );
    assertEquals(
      await store.verifyAdministratorPassword("correct horse battery staple"),
      null,
    );
  } finally {
    await store.close();
  }
});

Deno.test("rejects invalid setup input", async () => {
  const store = await createTestStore();

  try {
    const router = createAppRouter(createAppServices(store));
    const response = await router.fetch(
      new Request("http://localhost/auth/setup", {
        method: "POST",
        body: new URLSearchParams({
          password: "short",
          confirmPassword: "different",
        }),
      }),
    );

    assertEquals(response.status, 403);
  } finally {
    await store.close();
  }
});
