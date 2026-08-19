import { assert, assertEquals, assertMatch, assertNotEquals, assertNotMatch } from "@std/assert";
import { ok } from "@openorb/result";
import { parse } from "remix/data-schema";

import {
  parseRunnerServerMessage,
  RUNNER_HELLO_MESSAGE_TYPE,
  runnerEnrollmentResponseSchema,
} from "@openorb/protocol";
import { createAppServices } from "@/app/middleware/services.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import { RunnerConnectionGateway } from "@/app/runner-connection-gateway.ts";
import { maintainRunnerConnection } from "@openorb/runner/connection";
import { createTestServer } from "@/test/http-test-server.ts";
import { createTestStore, createTestUser } from "@/test/postgres-test.ts";

const PASSWORD = "[REDACTED:password] horse battery staple";
const PUBLIC_CONTROL_PANEL_URL = "https://openorb.example.com";

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

function enrollmentPskFrom(html: string): string {
  const match = html.match(/openorb_enroll_[A-Za-z0-9_-]+/);
  assert(match, "expected a revealed enrollment PSK");
  return match[0];
}

async function openWebSocket(url: URL): Promise<WebSocket> {
  url.protocol = "ws:";
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), {
      once: true,
    });
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket message failed.")), {
      once: true,
    });
  });
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event), { once: true });
  });
}

Deno.test("allows only one in-flight runner authentication per socket", async () => {
  let authenticationCalls = 0;
  let finishAuthentication: (() => void) | undefined;
  const authenticationPending = new Promise<void>((resolve) => {
    finishAuthentication = resolve;
  });
  const gateway = new RunnerConnectionGateway({
    async authenticateRunner() {
      authenticationCalls++;
      await authenticationPending;
      return null;
    },
    reconcileSessionSnapshotEntries: emptyReconciliation,
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await openWebSocket(new URL("/", server.baseUrl));
    const socketClosed = closed(socket);
    for (let index = 0; index < 100; index++) {
      socket.send(JSON.stringify({
        version: 1,
        id: crypto.randomUUID(),
        type: RUNNER_HELLO_MESSAGE_TYPE,
        payload: { token: `openorb_runner_${"a".repeat(43)}` },
      }));
    }

    await socketClosed;
    finishAuthentication?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(authenticationCalls, 1);
  } finally {
    finishAuthentication?.();
    socket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("always provides one PSK and serializes concurrent regeneration", async () => {
  const store = await createTestStore();

  try {
    const userId = await createTestUser(store);
    const provisioned = await Promise.all(
      Array.from({ length: 8 }, () => store.getRunnerEnrollmentToken(userId)),
    );
    assertEquals(new Set(provisioned.map((token) => token.id)).size, 1);
    assertEquals(new Set(provisioned.map((token) => token.token)).size, 1);

    const regenerated = await Promise.all(
      Array.from({ length: 8 }, () => store.regenerateRunnerEnrollmentToken(userId)),
    );
    assertEquals(new Set(regenerated.map((token) => token.id)).size, 8);
    const current = await store.getRunnerEnrollmentToken(userId);
    assert(regenerated.some((token) => token.id === current.id));
    assertNotEquals(current.id, provisioned[0]!.id);

    const stored = await store.pool.query<{ id: string; revoked_at: string | null }>(
      "select id, revoked_at from runner_enrollment_tokens where user_id = $1",
      [userId],
    );
    assertEquals(stored.rows.length, 9);
    assertEquals(
      stored.rows
        .filter((token: { revoked_at: string | null }) => token.revoked_at === null)
        .map((token: { id: string }) => token.id),
      [
        current.id,
      ],
    );
  } finally {
    await store.close();
  }
});

Deno.test("creates one reusable PSK and enrolls an authenticated outbound runner", async () => {
  const store = await createTestStore();
  const gateway = new RunnerConnectionGateway(store);
  const router = createAppRouter(createAppServices(store, gateway));
  const server = await createTestServer((request) =>
    new URL(request.url).pathname === routes.api.runners.connect.href()
      ? gateway.handleUpgrade(request)
      : router.fetch(request)
  );

  try {
    const setupUrl = new URL(routes.auth.setup.index.href(), server.baseUrl);
    const setupPage = await fetch(setupUrl);
    const setupResponse = await fetch(setupUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(setupPage) },
      body: new URLSearchParams({
        _csrf: csrfFrom(await setupPage.text()),
        password: PASSWORD,
        confirmPassword: PASSWORD,
      }),
    });
    assertEquals(setupResponse.status, 303);

    const loginUrl = new URL(routes.auth.login.index.href(), server.baseUrl);
    const loginPage = await fetch(loginUrl);
    const loginResponse = await fetch(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(loginPage) },
      body: new URLSearchParams({
        _csrf: csrfFrom(await loginPage.text()),
        password: PASSWORD,
      }),
    });
    const cookie = cookieFrom(loginResponse);
    const administrator = await store.verifyAdministratorPassword(PASSWORD);
    assert(administrator);

    const runnersSettingsPath = `${routes.app.settings.index.href()}?tab=runners#runners`;
    const runnersSettingsUrl = new URL(runnersSettingsPath, server.baseUrl);
    assertEquals((await fetch(runnersSettingsUrl)).status, 401);
    const previousPublicUrl = Deno.env.get("PUBLIC_URL");
    Deno.env.set("PUBLIC_URL", `${PUBLIC_CONTROL_PANEL_URL}/proxy-path`);
    let createdPage: Response;
    try {
      createdPage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    } finally {
      if (previousPublicUrl === undefined) Deno.env.delete("PUBLIC_URL");
      else Deno.env.set("PUBLIC_URL", previousPublicUrl);
    }
    assertEquals(createdPage.headers.get("cache-control"), "no-store");
    const createdHtml = await createdPage.text();
    const enrollmentPsk = enrollmentPskFrom(createdHtml);
    assertMatch(
      createdHtml,
      /<button[^>]+aria-selected="true"[^>]+data-state="active"[^>]*>[\s\S]*?Runners<\/button>/,
    );
    assertMatch(createdHtml, /Runner enrollment/);
    assertMatch(createdHtml, /Run from your OpenOrb checkout to enroll a runner\./);
    assertNotMatch(createdHtml, />Enrollment PSKs</);
    assertNotMatch(createdHtml, />Create PSK<\/button>/);
    assertNotMatch(createdHtml, />Revoke<\/button>/);
    assertMatch(
      createdHtml,
      /<div(?=[^>]*data-slot="item")(?=[^>]*aria-label="Runner enrollment command")[^>]*>/,
    );
    assertMatch(createdHtml, /data-slot="item-content"/);
    assertMatch(createdHtml, /data-slot="item-title"/);
    assertMatch(createdHtml, /data-slot="item-actions"/);
    assertMatch(createdHtml, /deno task dev:runner/);
    assert(createdHtml.includes(`--control-panel ${PUBLIC_CONTROL_PANEL_URL}`));
    assertNotMatch(createdHtml, /proxy-path/);
    assert(createdHtml.includes(`--enrollment-token ${enrollmentPsk}`));
    assertMatch(createdHtml, />Copy command</);
    assertMatch(createdHtml, />Regenerate<\/button>/);

    const storedPsk = await store.pool.query<{ token: string; token_hash: string }>(
      "select token, token_hash from runner_enrollment_tokens",
    );
    assertEquals(storedPsk.rows.length, 1);
    assertEquals(storedPsk.rows[0]!.token, enrollmentPsk);
    assertEquals(storedPsk.rows[0]!.token_hash.length, 64);
    assertNotEquals(storedPsk.rows[0]!.token_hash, enrollmentPsk);
    const laterPage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    const laterHtml = await laterPage.text();
    assertMatch(laterHtml, new RegExp(enrollmentPsk));
    assert(laterHtml.includes(`--control-panel ${server.baseUrl.origin}`));

    const enrollUrl = new URL(routes.api.runners.enroll.href(), server.baseUrl);
    const enrollmentBody = {
      enrollmentPsk,
      name: "Home runner",
      architecture: "x64",
      capabilities: ["heartbeat"],
    };
    const firstEnrollment = await fetch(enrollUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(enrollmentBody),
    });
    assertEquals(firstEnrollment.status, 201);
    assertEquals(firstEnrollment.headers.get("cache-control"), "no-store");
    const firstRunner = parse(runnerEnrollmentResponseSchema, await firstEnrollment.json());
    assertMatch(firstRunner.runnerToken, /^openorb_runner_/);

    const secondEnrollment = await fetch(enrollUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...enrollmentBody, name: "Second runner" }),
    });
    assertEquals(secondEnrollment.status, 201);
    const secondRunner = parse(runnerEnrollmentResponseSchema, await secondEnrollment.json());
    assertNotEquals(secondRunner.runnerId, firstRunner.runnerId);
    assertNotEquals(secondRunner.runnerToken, firstRunner.runnerToken);
    assertEquals((await store.listRunners(administrator.id)).length, 2);

    const invalidEnrollment = await fetch(enrollUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...enrollmentBody,
        enrollmentPsk: `openorb_enroll_${"x".repeat(43)}`,
      }),
    });
    assertEquals(invalidEnrollment.status, 401);

    const oversizedEnrollment = await fetch(enrollUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(16 * 1024 + 1),
    });
    assertEquals(oversizedEnrollment.status, 413);

    const connectUrl = new URL(routes.api.runners.connect.href(), server.baseUrl);
    const socket = await openWebSocket(connectUrl);
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "runner.hello",
      payload: { token: firstRunner.runnerToken },
    }));
    const connected = parseRunnerServerMessage(JSON.parse(await nextMessage(socket)));
    assert(connected.type === "runner.connected");
    assertEquals(connected.payload.runnerId, firstRunner.runnerId);
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "runner.heartbeat",
      payload: {
        observedAt: Date.now(),
        capacity: {
          activeSessions: 0,
          vmCpuCount: 4,
          vmMemoryMiB: 8192,
          diskFreeMiB: 20_480,
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const onlinePage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    const onlineHtml = await onlinePage.text();
    assertMatch(onlineHtml, /Home runner/);
    assertMatch(onlineHtml, />Online</);
    assertMatch(onlineHtml, /data-slot="card"/);
    assertMatch(onlineHtml, /data-status="online"/);
    assertMatch(onlineHtml, /0 active sessions · No session limit/);
    assertMatch(onlineHtml, /CPU allocated/);
    assertMatch(onlineHtml, /Memory allocated/);
    assertMatch(onlineHtml, /role="progressbar"/);
    assertMatch(onlineHtml, /aria-label="CPU allocated: 1 of 4 CPUs"/);
    assertMatch(onlineHtml, /8 GiB memory/);
    assertMatch(onlineHtml, /20 GiB disk free/);
    const successfulClose = closed(socket);
    socket.close(1000);
    assertEquals((await successfulClose).code, 1000);
    const offlinePage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    const offlineHtml = await offlinePage.text();
    assertMatch(offlineHtml, /Home runner/);
    assertMatch(offlineHtml, />Offline</);
    assertMatch(offlineHtml, /data-status="offline"/);
    assertMatch(offlineHtml, /Allocation unavailable/);
    const activeDeletionResponse = await fetch(runnersSettingsUrl, {
      method: "POST",
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(offlineHtml),
        intent: "delete-runner",
        runnerId: firstRunner.runnerId,
      }),
    });
    assertEquals(activeDeletionResponse.status, 409);
    assertMatch(await activeDeletionResponse.text(), /Revoke the runner before deleting it\./);

    const harnessShutdown = new AbortController();
    let harnessConnections = 0;
    await maintainRunnerConnection({
      controlPanelUrl: server.baseUrl.origin,
      runnerId: firstRunner.runnerId,
      runnerToken: firstRunner.runnerToken,
      signal: harnessShutdown.signal,
      getCapacity: () =>
        Promise.resolve({
          activeSessions: 0,
          vmCpuCount: 4,
          vmMemoryMiB: 8192,
          diskFreeMiB: 20_480,
        }),
      getSessionSnapshot: () => Promise.resolve([[], undefined] as const),
      onConnected() {
        harnessConnections++;
        harnessShutdown.abort();
      },
    });
    assertEquals(harnessConnections, 1);

    const invalidTokenSocket = await openWebSocket(connectUrl);
    const invalidTokenClose = closed(invalidTokenSocket);
    const invalidRunnerToken = `${firstRunner.runnerToken.slice(0, -1)}${
      firstRunner.runnerToken.endsWith("x") ? "y" : "x"
    }`;
    invalidTokenSocket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "runner.hello",
      payload: { token: invalidRunnerToken },
    }));
    assertEquals((await invalidTokenClose).code, 4401);

    const malformedSocket = await openWebSocket(connectUrl);
    const malformedClose = closed(malformedSocket);
    malformedSocket.send(JSON.stringify({
      version: 2,
      id: crypto.randomUUID(),
      type: "runner.hello",
      payload: { token: firstRunner.runnerToken },
    }));
    assertEquals((await malformedClose).code, 4400);

    const enrollmentToken = await store.getRunnerEnrollmentToken(administrator.id);
    assert(enrollmentToken.createdAt instanceof Temporal.Instant);
    const regenerationPage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    const regenerationHtml = await regenerationPage.text();
    const regenerateResponse = await fetch(runnersSettingsUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(regenerationHtml),
        intent: "regenerate-enrollment-token",
      }),
    });
    assertEquals(regenerateResponse.status, 303);
    assertEquals(regenerateResponse.headers.get("location"), runnersSettingsPath);

    const regeneratedPage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    const regeneratedHtml = await regeneratedPage.text();
    const replacementPsk = enrollmentPskFrom(regeneratedHtml);
    assertNotEquals(replacementPsk, enrollmentPsk);
    assertNotMatch(regeneratedHtml, new RegExp(enrollmentPsk));
    assertMatch(regeneratedHtml, />Copy command<\/button>/);
    assertMatch(regeneratedHtml, />Regenerate<\/button>/);
    assertMatch(regeneratedHtml, />Revoke<\/button>/);

    const enrollmentTokens = await store.pool.query<{ token: string; revoked_at: string | null }>(
      "select token, revoked_at from runner_enrollment_tokens where user_id = $1",
      [administrator.id],
    );
    assertEquals(enrollmentTokens.rows.length, 2);
    assertEquals(
      enrollmentTokens.rows
        .filter((token: { revoked_at: string | null }) => token.revoked_at === null)
        .map((token: { token: string }) => token.token),
      [replacementPsk],
    );
    assert(
      enrollmentTokens.rows.find((token: { token: string }) => token.token === enrollmentPsk)
        ?.revoked_at,
    );
    assertEquals(
      (await store.authenticateRunner(firstRunner.runnerToken))?.id,
      firstRunner.runnerId,
    );
    assertEquals(
      (await fetch(enrollUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enrollmentBody),
      })).status,
      401,
    );
    assertEquals(
      (await fetch(enrollUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...enrollmentBody,
          enrollmentPsk: replacementPsk,
          name: "Replacement runner",
        }),
      })).status,
      201,
    );

    const connectedForRevocation = await openWebSocket(connectUrl);
    connectedForRevocation.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "runner.hello",
      payload: { token: firstRunner.runnerToken },
    }));
    await nextMessage(connectedForRevocation);
    connectedForRevocation.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "runner.heartbeat",
      payload: {
        observedAt: Date.now(),
        capacity: {
          activeSessions: 0,
          vmCpuCount: 4,
          vmMemoryMiB: 8192,
          diskFreeMiB: 20_480,
        },
      },
    }));
    const connectedRevocationClose = closed(connectedForRevocation);
    const runnerRevocationPage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    const runnerRevocationResponse = await fetch(runnersSettingsUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(await runnerRevocationPage.text()),
        intent: "revoke-runner",
        runnerId: firstRunner.runnerId,
      }),
    });
    assertEquals(runnerRevocationResponse.status, 303);
    assertEquals((await connectedRevocationClose).code, 4401);
    assertEquals(await store.authenticateRunner(firstRunner.runnerToken), null);
    const revokedPage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    const revokedHtml = await revokedPage.text();
    assertMatch(revokedHtml, />Revoked</);
    assertMatch(revokedHtml, />Delete<\/button>/);
    assertMatch(revokedHtml, /Delete Home runner\?/);
    const revokedSocket = await openWebSocket(connectUrl);
    const revokedClose = closed(revokedSocket);
    revokedSocket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "runner.hello",
      payload: { token: firstRunner.runnerToken },
    }));
    assertEquals((await revokedClose).code, 4401);

    const runnerDeletionResponse = await fetch(runnersSettingsUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(revokedHtml),
        intent: "delete-runner",
        runnerId: firstRunner.runnerId,
      }),
    });
    assertEquals(runnerDeletionResponse.status, 303);
    assertEquals(runnerDeletionResponse.headers.get("location"), runnersSettingsPath);
    assertEquals(
      (await store.listRunners(administrator.id)).some((runner) =>
        runner.id === firstRunner.runnerId
      ),
      false,
    );
    const deletedRunnerPage = await fetch(runnersSettingsUrl, { headers: { Cookie: cookie } });
    assertNotMatch(await deletedRunnerPage.text(), /Home runner/);

    const disconnectedRevocationPage = await fetch(runnersSettingsUrl, {
      headers: { Cookie: cookie },
    });
    const disconnectedRevocationResponse = await fetch(runnersSettingsUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(await disconnectedRevocationPage.text()),
        intent: "revoke-runner",
        runnerId: secondRunner.runnerId,
      }),
    });
    assertEquals(disconnectedRevocationResponse.status, 303);
    assertEquals(await store.authenticateRunner(secondRunner.runnerToken), null);

    const secondUserId = await createTestUser(store);
    const secondUserEnrollmentToken = await store.getRunnerEnrollmentToken(secondUserId);
    assertNotEquals(secondUserEnrollmentToken.token, replacementPsk);
    assertEquals((await store.getRunnerEnrollmentToken(administrator.id)).token, replacementPsk);
    assertEquals(await store.listRunners(secondUserId), []);
    assertEquals(await store.revokeRunner(secondUserId, secondRunner.runnerId), "not-found");
    await assertRejectsCrossTenantRunnerOwner(store, secondUserId, secondRunner.runnerId);
  } finally {
    gateway.close();
    await server.close();
    await store.close();
  }
});

async function assertRejectsCrossTenantRunnerOwner(
  store: Awaited<ReturnType<typeof createTestStore>>,
  userId: string,
  runnerId: string,
): Promise<void> {
  let rejected = false;
  try {
    await store.pool.query("update runners set user_id = $1 where id = $2", [userId, runnerId]);
  } catch {
    rejected = true;
  }
  assert(rejected, "expected the composite enrollment-token owner constraint to reject the update");
}

function emptyReconciliation() {
  return Promise.resolve(ok({
    acceptedSessionIds: [],
    tombstonedSessionIds: [],
    rejected: [],
  }));
}
