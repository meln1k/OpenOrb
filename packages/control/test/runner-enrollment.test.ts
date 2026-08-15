import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";

import { parseRunnerServerMessage, RUNNER_HELLO_MESSAGE_TYPE } from "@openorb/protocol";
import { createAppServices } from "../app/middleware/services.ts";
import { createAppRouter } from "../app/router.ts";
import { routes } from "../app/routes.ts";
import { RunnerConnectionGateway } from "../app/runner-connection-gateway.ts";
import { maintainRunnerConnection } from "../../runner/src/connection.ts";
import { createTestServer } from "./http-test-server.ts";
import { createTestStore, createTestUser } from "./postgres-test.ts";

const PASSWORD = "[REDACTED:password] horse battery staple";

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

Deno.test("creates reusable PSKs and enrolls an authenticated outbound runner", async () => {
  const store = await createTestStore();
  const gateway = new RunnerConnectionGateway(store);
  const router = createAppRouter(createAppServices(store));
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

    const runnersUrl = new URL(routes.app.runners.index.href(), server.baseUrl);
    assertEquals((await fetch(runnersUrl)).status, 401);
    const runnersPage = await fetch(runnersUrl, { headers: { Cookie: cookie } });
    const createResponse = await fetch(runnersUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(await runnersPage.text()),
        intent: "create-enrollment-token",
      }),
    });
    assertEquals(createResponse.status, 303);
    assertEquals(createResponse.headers.get("location"), routes.app.runners.index.href());

    const createdPage = await fetch(runnersUrl, { headers: { Cookie: cookie } });
    assertEquals(createdPage.headers.get("cache-control"), "no-store");
    const createdHtml = await createdPage.text();
    const enrollmentPsk = enrollmentPskFrom(createdHtml);
    assertMatch(createdHtml, /stored unencrypted and remain visible/);
    assertMatch(createdHtml, />Copy PSK</);
    assertEquals((await store.listRunnerEnrollmentTokens(administrator.id)).length, 1);

    const storedPsk = await store.pool.query<{ token: string; token_hash: string }>(
      "select token, token_hash from runner_enrollment_tokens",
    );
    assertEquals(storedPsk.rows.length, 1);
    assertEquals(storedPsk.rows[0]!.token, enrollmentPsk);
    assertEquals(storedPsk.rows[0]!.token_hash.length, 64);
    assertNotEquals(storedPsk.rows[0]!.token_hash, enrollmentPsk);
    const laterPage = await fetch(runnersUrl, { headers: { Cookie: cookie } });
    assertMatch(await laterPage.text(), new RegExp(enrollmentPsk));

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
    const firstRunner = await firstEnrollment.json() as {
      runnerId: string;
      runnerToken: string;
    };
    assertMatch(firstRunner.runnerToken, /^openorb_runner_/);

    const secondEnrollment = await fetch(enrollUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...enrollmentBody, name: "Second runner" }),
    });
    assertEquals(secondEnrollment.status, 201);
    const secondRunner = await secondEnrollment.json() as {
      runnerId: string;
      runnerToken: string;
    };
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
    assertEquals(connected.payload.runnerId, firstRunner.runnerId);
    socket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "runner.heartbeat",
      payload: { observedAt: Date.now() },
    }));
    const successfulClose = closed(socket);
    socket.close(1000);
    assertEquals((await successfulClose).code, 1000);

    const harnessShutdown = new AbortController();
    let harnessConnections = 0;
    await maintainRunnerConnection({
      controlPanelUrl: server.baseUrl.origin,
      runnerId: firstRunner.runnerId,
      runnerToken: firstRunner.runnerToken,
      signal: harnessShutdown.signal,
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

    const enrollmentToken = (await store.listRunnerEnrollmentTokens(administrator.id))[0]!;
    assert(enrollmentToken.createdAt instanceof Temporal.Instant);
    const revocationPage = await fetch(runnersUrl, { headers: { Cookie: cookie } });
    const revokeResponse = await fetch(runnersUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(await revocationPage.text()),
        intent: "revoke-enrollment-token",
        tokenId: enrollmentToken.id,
      }),
    });
    assertEquals(revokeResponse.status, 303);
    assert(
      (await store.listRunnerEnrollmentTokens(administrator.id))[0]!.revokedAt instanceof
        Temporal.Instant,
    );
    const revokedPage = await fetch(runnersUrl, { headers: { Cookie: cookie } });
    assertMatch(await revokedPage.text(), new RegExp(enrollmentPsk));
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

    assertEquals(await store.revokeRunner(administrator.id, firstRunner.runnerId), "revoked");
    assertEquals(await store.authenticateRunner(firstRunner.runnerToken), null);
    const revokedSocket = await openWebSocket(connectUrl);
    const revokedClose = closed(revokedSocket);
    revokedSocket.send(JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      type: "runner.hello",
      payload: { token: firstRunner.runnerToken },
    }));
    assertEquals((await revokedClose).code, 4401);

    const secondUserId = await createTestUser(store);
    assertEquals(await store.listRunnerEnrollmentTokens(secondUserId), []);
    assertEquals(
      await store.revokeRunnerEnrollmentToken(secondUserId, enrollmentToken.id),
      "not-found",
    );
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
