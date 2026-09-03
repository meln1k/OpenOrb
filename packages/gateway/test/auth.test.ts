import { assert, assertEquals, assertMatch, assertNotEquals, assertNotMatch } from "@std/assert";
import { v7 } from "@std/uuid";
import { Effect } from "effect";

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
  let connectedRunnerId: string | undefined;
  const disconnectedServices = createAppServices(store);
  const router = createAppRouter(createAppServices(store, {
    ...disconnectedServices.runnerConnections,
    getRunnerLiveState: (_userId, runnerId) =>
      Effect.succeed(
        runnerId === connectedRunnerId
          ? {
            capacity: {
              activeSessions: 0,
              vmCpuCount: 2,
              vmMemoryMiB: 4_096,
              diskFreeMiB: 10_000,
            },
            lastObservedAt: Date.now(),
          }
          : null,
      ),
  }));
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
    assertMatch(appHtml, /Get started/);
    assertMatch(appHtml, /Connect a runner/);
    assertMatch(appHtml, /Add a LLM provider key/);
    assertMatch(appHtml, /Configure GitHub credentials/);
    assertMatch(appHtml, /Set up Git username and email/);
    assertMatch(appHtml, /Configure projects/);
    assertMatch(appHtml, /data-setup-step="runner" data-status="pending"/);
    assertMatch(appHtml, /data-setup-step="provider" data-status="pending"/);
    assertMatch(appHtml, /data-setup-step="github" data-status="pending"/);
    assertMatch(appHtml, /data-setup-step="git-author" data-status="pending"/);
    assertMatch(appHtml, /data-setup-step="project" data-status="pending"/);
    assertMatch(appHtml, />Connect runner<\/a>/);
    assertEquals([...appHtml.matchAll(/<main(?:\s|>)/g)].length, 1);
    assert(
      appHtml.indexOf('data-setup-step="runner"') <
        appHtml.indexOf('data-setup-step="provider"'),
    );
    const logoutToken = csrfFrom(appHtml);

    const enrollment = await store.getRunnerEnrollmentToken(administrators.rows[0]!.id);
    const runner = await store.enrollRunner({
      enrollmentPsk: enrollment.token,
      name: "Connected runner",
      architecture: "x64",
    });
    assert(runner);

    const configuredRunnerResponse = await fetch(appUrl, {
      headers: { Cookie: authenticatedCookie },
    });
    assertEquals(configuredRunnerResponse.status, 200);
    const configuredRunnerHtml = await configuredRunnerResponse.text();
    assertMatch(configuredRunnerHtml, /data-setup-step="runner" data-status="pending"/);
    assertNotMatch(configuredRunnerHtml, />Connect runner<\/a>/);

    connectedRunnerId = runner.runnerId;

    await store.saveModelProviderCredential(
      administrators.rows[0]!.id,
      "opencode-go",
      "opencode-test-key",
    );
    await store.saveGitHubCredential(administrators.rows[0]!.id, "github-test-token");
    const partlyConfiguredResponse = await fetch(appUrl, {
      headers: { Cookie: authenticatedCookie },
    });
    assertEquals(partlyConfiguredResponse.status, 200);
    const partlyConfiguredHtml = await partlyConfiguredResponse.text();
    assertMatch(partlyConfiguredHtml, /data-setup-step="runner" data-status="complete"/);
    assertMatch(partlyConfiguredHtml, /data-setup-step="provider" data-status="complete"/);
    assertMatch(partlyConfiguredHtml, /data-setup-step="github" data-status="complete"/);
    assertMatch(partlyConfiguredHtml, /data-setup-step="git-author" data-status="pending"/);
    assertMatch(partlyConfiguredHtml, /data-setup-step="project" data-status="pending"/);

    assertEquals(
      (await store.saveProject(administrators.rows[0]!.id, {
        name: "OpenOrb",
        repositoryUrl: "https://github.com/meln1k/openorb.git",
      })).status,
      "saved",
    );
    const configuredResponse = await fetch(appUrl, {
      headers: { Cookie: authenticatedCookie },
    });
    assertEquals(configuredResponse.status, 200);
    const projectConfiguredHtml = await configuredResponse.text();
    assertMatch(projectConfiguredHtml, /Get started/);
    assertMatch(projectConfiguredHtml, /data-setup-step="git-author" data-status="pending"/);
    assertMatch(projectConfiguredHtml, /data-setup-step="project" data-status="complete"/);

    await store.saveGitAuthorConfiguration(administrators.rows[0]!.id, {
      authorName: "OpenOrb Developer",
      authorEmail: "developer@example.com",
    });
    const fullyConfiguredResponse = await fetch(appUrl, {
      headers: { Cookie: authenticatedCookie },
    });
    assertEquals(fullyConfiguredResponse.status, 200);
    assertNotMatch(await fullyConfiguredResponse.text(), /Get started/);

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
