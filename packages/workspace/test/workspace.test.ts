import { assert, assertEquals, assertNotEquals, assertNotMatch, assertRejects } from "@std/assert";
import {
  ProjectId,
  RunnerSessionSnapshot,
  SessionEnvironmentSecret,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { decodeWorkspaceArguments, type SaveBrowserSession } from "../src/api.ts";
import { WorkspaceClient } from "../src/client.ts";
import type { Env } from "../src/env.ts";
import httpWorker from "../src/worker.ts";
import { Workspace, type WorkspaceStorage } from "../src/workspace.ts";

// Clone at both boundaries: persisted Uint8Arrays and records must not alias live objects.
class MemoryStorage implements WorkspaceStorage {
  #rows = new Map<string, unknown>();
  alarm: number | null = null;

  get<T>(key: string): Promise<T | undefined> {
    // SAFETY: WorkspaceStorage callers own the type of each persisted key.
    return Promise.resolve(structuredClone(this.#rows.get(key)) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.#rows.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(key));
  }

  list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    const rows = [...this.#rows].filter(([key]) => key.startsWith(prefix));
    // SAFETY: As with get, the caller owns the value type for this key prefix.
    return Promise.resolve(structuredClone(new Map(rows)) as Map<string, T>);
  }

  async transaction<T>(callback: (storage: WorkspaceStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.#rows);
    const alarm = this.alarm;
    try {
      // Use this storage so writes through the worker's captured storage also roll back.
      return await callback(this);
    } catch (error) {
      this.#rows = before;
      this.alarm = alarm;
      throw error;
    }
  }

  setAlarm(time: number): Promise<void> {
    this.alarm = time;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarm = null;
    return Promise.resolve();
  }
}

function testEnvironment(getByName: () => Workspace): Env {
  return {
    OPENORB_MASTER_KEY: "ab".repeat(32),
    // SAFETY: Logic tests call ordinary methods; native celld tests exercise the RPC transport.
    // deno-lint-ignore openorb/no-chained-type-assertions
    WORKSPACE: { getByName } as unknown as Env["WORKSPACE"],
  };
}

function activate(storage = new MemoryStorage()) {
  const environment = testEnvironment(() => worker);
  const worker = new Workspace({ storage }, environment);
  const fetcher: typeof fetch = (input, init) =>
    httpWorker.fetch(new Request(input, init), environment);
  return { storage, worker, client: new WorkspaceClient("http://workspace.test", fetcher) };
}

async function configured() {
  const context = activate();
  assertEquals(await context.client.call("createAdministrator", "test-password"), [
    true,
    undefined,
  ]);
  const administrator = await context.client.call("verifyAdministratorPassword", "test-password");
  assert(administrator);
  return { ...context, administrator, workspaceId: administrator.workspaceId };
}

async function createProject(client: WorkspaceClient, workspaceId: WorkspaceId, name = "OpenOrb") {
  const result = await client.call("saveProject", workspaceId, {
    name,
    repositoryUrl: "https://github.com/example/openorb.git",
  });
  assert(result.status === "saved");
  return result.project;
}

function snapshot(projectId: string): RunnerSessionSnapshot {
  return new RunnerSessionSnapshot({
    id: SessionId.make(crypto.randomUUID()),
    projectId: ProjectId.make(projectId),
    createdAt: new Date().toISOString(),
    initialPromptPreview: "Fix the regression",
    model: "openai/gpt-4.1",
    initialThinkingLevel: "medium",
    orbSize: "small",
    state: "stopped",
    agentState: "idle",
    environmentState: "stopped",
    issues: [],
  });
}

Deno.test("test storage clones records and rolls back writes, deletes, and alarms", async () => {
  const storage = new MemoryStorage();
  const value = { bytes: new Uint8Array([1, 2]), metadata: { name: "original" } };
  await storage.put("record", value);
  value.bytes[0] = 99;
  value.metadata.name = "mutated";
  const read = await storage.get<typeof value>("record");
  assert(read);
  assertEquals(read.bytes, new Uint8Array([1, 2]));
  read.metadata.name = "also mutated";
  const listed = await storage.list<typeof value>({ prefix: "rec" });
  assertEquals(listed.get("record")?.metadata.name, "original");
  listed.get("record")!.bytes[0] = 98;
  await storage.setAlarm(123);
  await assertRejects(
    () =>
      storage.transaction(async (transaction) => {
        await transaction.delete("record");
        await storage.put("partial", { value: "must roll back" });
        await transaction.setAlarm(456);
        throw new Error("forced rollback");
      }),
    Error,
    "forced rollback",
  );
  assertEquals(await storage.get("record"), {
    bytes: new Uint8Array([1, 2]),
    metadata: { name: "original" },
  });
  assertEquals(await storage.get("partial"), undefined);
  assertEquals(storage.alarm, 123);
});

Deno.test("Workspace setup admits one concurrent administrator and survives reactivation", async () => {
  const { client, storage } = activate();
  assertEquals(await client.call("hasAdministrator"), false);
  const passwords = ["first-password", "second-password", "third-password"];
  const results = await Promise.all(
    passwords.map((password) => client.call("createAdministrator", password)),
  );
  assertEquals(results.filter(([created]) => created === true).length, 1);
  assertEquals(results.filter(([created]) => created === false).length, 2);
  for (const result of results) assertEquals(result[1], undefined);
  const winningIndex = results.findIndex(([created]) => created === true);
  const administrator = await client.call("verifyAdministratorPassword", passwords[winningIndex]!);
  assert(administrator);
  const restarted = activate(storage).client;
  assertEquals(await restarted.call("hasAdministrator"), true);
  assertEquals(await restarted.call("getAdministrator", administrator.userId), administrator);
  assertEquals(
    await restarted.call("verifyAdministratorPassword", passwords[(winningIndex + 1) % 3]!),
    null,
  );
  assertEquals(await restarted.call("createAdministrator", "replacement"), [false, undefined]);
  assertEquals((await storage.list({ prefix: "administrator" })).size, 1);
});

Deno.test("Worker validates HTTP before RPC and keeps remote failures private", async () => {
  const { worker, storage, workspaceId } = await configured();
  const environment = testEnvironment(() => worker);
  const stub = environment.WORKSPACE.getByName("workspace");
  // Also fail type checking if the generated namespace loses its source types and becomes any.
  assertEquals<0 extends (1 & typeof stub.health) ? never : void>(await stub.health(), undefined);
  const invalid = await httpWorker.fetch(
    new Request("http://workspace.test/saveProject", {
      method: "POST",
      body: JSON.stringify([workspaceId, { name: "Invalid", repositoryUrl: 123 }]),
    }),
    environment,
  );
  assertEquals(invalid.status, 400);
  assertEquals((await storage.list({ prefix: "project:" })).size, 0);
  const unknown = await httpWorker.fetch(
    new Request("http://workspace.test/health", {
      method: "POST",
      body: "[]",
    }),
    environment,
  );
  assertEquals(unknown.status, 404, "public RPC methods are not automatically HTTP endpoints");
  class FailingWorkspace extends Workspace {
    override getProject(): ReturnType<Workspace["getProject"]> {
      return Promise.reject(new Error("sensitive provider response"));
    }
  }
  const failing = new FailingWorkspace({ storage }, environment);
  const result = await httpWorker.fetch(
    new Request("http://workspace.test/getProject", {
      method: "POST",
      body: JSON.stringify([workspaceId, "missing"]),
    }),
    testEnvironment(() => failing),
  );
  assertEquals(result.status, 500);
  assertEquals(await result.text(), "Workspace operation failed");
  assertEquals(
    decodeWorkspaceArguments("saveSecret", [workspaceId, "TOKEN", "value", null]),
    [workspaceId, "TOKEN", "value", undefined],
    "legacy HTTP null is normalized before typed RPC",
  );
});

Deno.test("project name conflicts do not overwrite data and reads are Workspace-scoped", async () => {
  const { client, storage, workspaceId } = await configured();
  const input = { name: "OpenOrb", repositoryUrl: "https://github.com/example/openorb.git" };
  const results = await Promise.all([
    client.call("saveProject", workspaceId, input),
    client.call("saveProject", workspaceId, {
      ...input,
      repositoryUrl: "https://github.com/example/other.git",
    }),
  ]);
  const saved = results.find((result) => result.status === "saved");
  assert(saved?.status === "saved");
  assertEquals(results.filter((result) => result.status === "name-conflict").length, 1);
  const foreign = WorkspaceId.make(crypto.randomUUID());
  assertEquals(await client.call("getProject", foreign, saved.project.id), null);
  assertEquals(await client.call("listProjects", foreign), []);
  assertEquals(
    await client.call("saveProject", workspaceId, { ...input, id: crypto.randomUUID() }),
    { status: "not-found" },
  );
  assertEquals(await activate(storage).client.call("listProjects", workspaceId), [saved.project]);
});

Deno.test("credentials persist as ciphertext; metadata omits secrets; successful null Results decode", async () => {
  const { client, storage, workspaceId } = await configured();
  assertEquals(await client.call("getModelProviderApiKey", workspaceId, "openai"), [
    null,
    undefined,
  ]);
  assertEquals(await client.call("getGitHubToken", workspaceId), [null, undefined]);
  const apiKey = "provider-plaintext-must-not-persist";
  const gitToken = "github-plaintext-must-not-persist";
  const secretValue = "environment-plaintext-must-not-persist";
  const provider = await client.call("saveModelProviderCredential", workspaceId, "openai", apiKey);
  const github = await client.call("saveGitHubCredential", workspaceId, gitToken);
  const secret = await client.call("saveSecret", workspaceId, "SERVICE_TOKEN", secretValue, [
    "api.example.com",
  ]);
  assertEquals(secret.status, "saved");
  const stored = await storage.get<{ secret: { ciphertext: Uint8Array; keyVersion: number } }>(
    `provider:${workspaceId}:openai`,
  );
  assert(stored?.secret.ciphertext instanceof Uint8Array);
  assert(stored.secret.ciphertext.byteLength > apiKey.length);
  assertEquals(stored.secret.keyVersion, 1);
  const persisted = JSON.stringify([...await storage.list({ prefix: "" })]);
  for (const plaintext of [apiKey, gitToken, secretValue]) {
    assertEquals(persisted.includes(plaintext), false);
    assertEquals(JSON.stringify([provider, github, secret]).includes(plaintext), false);
  }
  assertEquals("secret" in provider, false);
  const restarted = activate(storage).client;
  assertEquals(await restarted.call("getModelProviderCredential", workspaceId, "openai"), provider);
  assertEquals(await restarted.call("getModelProviderApiKey", workspaceId, "openai"), [
    apiKey,
    undefined,
  ]);
  assertEquals(await restarted.call("getGitHubToken", workspaceId), [gitToken, undefined]);
  assertEquals(await restarted.call("getEnvironmentSecrets", workspaceId), [[
    new SessionEnvironmentSecret({
      name: "SERVICE_TOKEN",
      value: secretValue,
      allowedHosts: ["api.example.com"],
    }),
  ], undefined]);
  const foreign = WorkspaceId.make(crypto.randomUUID());
  assertEquals(await restarted.call("getModelProviderApiKey", foreign, "openai"), [
    null,
    undefined,
  ]);
  assertEquals(await restarted.call("getSecret", foreign, "SERVICE_TOKEN"), null);
});

Deno.test("runner enrollment authenticates durably and revocation invalidates the token", async () => {
  const { client, storage, workspaceId } = await configured();
  const enrollment = await client.call("getRunnerEnrollmentToken", workspaceId);
  assert(enrollment.createdAt instanceof Temporal.Instant);
  const input = {
    enrollmentPsk: enrollment.token,
    name: "  Test runner  ",
    architecture: "x64" as const,
  };
  assertEquals(await client.call("enrollRunner", { ...input, enrollmentPsk: "wrong-psk" }), null);
  const enrolled = await client.call("enrollRunner", input);
  assert(enrolled);
  const restarted = activate(storage).client;
  assertEquals(await restarted.call("authenticateRunner", enrolled.runnerToken), {
    id: enrolled.runnerId,
    workspaceId,
  });
  const runners = await restarted.call("listRunners", workspaceId);
  assertEquals(runners.length, 1);
  assertEquals(runners[0]?.name, "Test runner");
  assert(runners[0]?.createdAt instanceof Temporal.Instant);
  assertEquals(runners[0].revokedAt, null);
  assertNotMatch(
    JSON.stringify([...await storage.list({ prefix: "runner:" })]),
    new RegExp(enrolled.runnerToken),
  );
  assertEquals(
    await restarted.call("revokeRunner", WorkspaceId.make(crypto.randomUUID()), enrolled.runnerId),
    "not-found",
  );
  assertEquals(await restarted.call("revokeRunner", workspaceId, enrolled.runnerId), "revoked");
  assertEquals(
    await activate(storage).client.call("authenticateRunner", enrolled.runnerToken),
    null,
  );
  assert(
    (await restarted.call("listRunners", workspaceId))[0]?.revokedAt instanceof Temporal.Instant,
  );
  const rotated = await restarted.call("regenerateRunnerEnrollmentToken", workspaceId);
  assertNotEquals(rotated.token, enrollment.token);
  assertEquals(await restarted.call("enrollRunner", input), null);
});

Deno.test("catalog manifests are all-or-nothing and durable tombstones prevent resurrection", async () => {
  const { client, storage, workspaceId } = await configured();
  const project = await createProject(client, workspaceId);
  const existing = snapshot(project.id);
  assertEquals(await client.call("reconcileSessionManifestEntries", workspaceId, [existing]), [{
    acceptedSessionIds: [existing.id],
    tombstonedSessionIds: [],
    rejected: [],
  }, undefined]);
  const fresh = snapshot(project.id);
  const missing = snapshot(crypto.randomUUID());
  const conflict = new RunnerSessionSnapshot({
    ...existing,
    initialPromptPreview: "Changed immutable preview",
  });
  assertEquals(
    await client.call("reconcileSessionManifestEntries", workspaceId, [fresh, conflict, missing]),
    [{
      acceptedSessionIds: [],
      tombstonedSessionIds: [],
      rejected: [
        { sessionId: existing.id, reason: "catalog-conflict" },
        { sessionId: missing.id, reason: "project-not-found" },
      ],
    }, undefined],
  );
  assertEquals(await client.call("getSessionCatalogEntry", workspaceId, fresh.id), null);
  assertEquals(
    (await client.call("getSessionCatalogEntry", workspaceId, existing.id))?.initialPromptPreview,
    existing.initialPromptPreview,
  );
  const deletedAt = new Date().toISOString();
  assertEquals(
    await client.call("deleteSessionCatalogEntry", workspaceId, existing.id, deletedAt),
    ["deleted", undefined],
  );
  const restarted = activate(storage).client;
  assertEquals(
    await restarted.call("reconcileSessionManifestEntries", workspaceId, [existing, fresh]),
    [{
      acceptedSessionIds: [fresh.id],
      tombstonedSessionIds: [existing.id],
      rejected: [],
    }, undefined],
  );
  assertEquals(await restarted.call("getSessionCatalogEntry", workspaceId, existing.id), null);
  assertEquals(await storage.get(`deleted:${workspaceId}:${existing.id}`), deletedAt);
  assertEquals(await restarted.call("listSessionNavigationEntries", workspaceId), [{
    id: fresh.id,
    projectId: project.id,
    projectName: project.name,
    initialPromptPreview: fresh.initialPromptPreview,
  }]);
});

Deno.test("Workspace preserves protocol limits and rejects conflicting entries in one manifest", async () => {
  const { client, workspaceId } = await configured();
  const hosts = Array.from({ length: 32 }, (_, index) => `api${index}.example.com`);
  assertEquals(
    (await client.call("saveSecret", workspaceId, "HOSTS", "test-secret", hosts)).status,
    "saved",
  );
  await assertRejects(() =>
    client.call("saveSecret", workspaceId, "HOSTS", "test-secret", [...hosts, "extra.example.com"])
  );
  const project = await createProject(client, workspaceId);
  const entry = new RunnerSessionSnapshot({
    ...snapshot(project.id),
    initialPromptPreview: "😀".repeat(200),
  });
  const [accepted, error] = await client.call("reconcileSessionManifestEntries", workspaceId, [
    entry,
  ]);
  assertEquals(error, undefined);
  assertEquals(accepted?.acceptedSessionIds, [entry.id]);
  await assertRejects(() =>
    client.call("reconcileSessionManifestEntries", workspaceId, [
      { ...entry, initialPromptPreview: "😀".repeat(201) },
    ])
  );
  const fresh = snapshot(project.id);
  const [rejected] = await client.call("reconcileSessionManifestEntries", workspaceId, [
    fresh,
    new RunnerSessionSnapshot({ ...fresh, initialPromptPreview: "Different immutable preview" }),
  ]);
  assertEquals(rejected?.rejected, [{ sessionId: fresh.id, reason: "catalog-conflict" }]);
  assertEquals(await client.call("getSessionCatalogEntry", workspaceId, fresh.id), null);
});

Deno.test("browser-session rotation and logout reject stale saves after reactivation", async () => {
  const { client, storage, administrator } = await configured();
  const anonymous: SaveBrowserSession = {
    id: crypto.randomUUID(),
    mode: "insert",
    data: [{ csrf: "csrf-value" }, {}],
  };
  assertEquals(await client.call("saveBrowserSession", anonymous), true);
  const authenticated: SaveBrowserSession = {
    id: crypto.randomUUID(),
    previousId: anonymous.id,
    mode: "rotate",
    data: [{ auth: administrator, csrf: "new-csrf-value" }, {}],
  };
  assertEquals(await client.call("saveBrowserSession", authenticated), true);
  const restarted = activate(storage).client;
  assertEquals(await restarted.call("readBrowserSession", anonymous.id), null);
  assertEquals(await restarted.call("saveBrowserSession", { ...anonymous, mode: "update" }), false);
  const record = await restarted.call("readBrowserSession", authenticated.id);
  assert(record);
  assertEquals(record.userId, administrator.userId);
  assertEquals(record.workspaceId, administrator.workspaceId);
  assertEquals(record.data, authenticated.data);
  await restarted.call("deleteBrowserSessions", [authenticated.id, anonymous.id]);
  const afterLogout = activate(storage).client;
  assertEquals(
    await afterLogout.call("saveBrowserSession", { ...authenticated, mode: "update" }),
    false,
  );
  const staleRotationId = crypto.randomUUID();
  assertEquals(
    await afterLogout.call("saveBrowserSession", {
      ...authenticated,
      id: staleRotationId,
      previousId: authenticated.id,
      mode: "rotate",
    }),
    false,
  );
  assertEquals(await afterLogout.call("readBrowserSession", authenticated.id), null);
  assertEquals(await afterLogout.call("readBrowserSession", staleRotationId), null);
  assertEquals((await storage.list({ prefix: "browser:" })).size, 0);
});

const ACCESS_TOKEN = `e30.${
  new TextEncoder().encode(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
  })).toBase64({ alphabet: "base64url", omitPadding: true })
}.unverified-signature`;

const DEVICE_PATH = "/api/accounts/deviceauth/usercode";
const POLL_PATH = "/api/accounts/deviceauth/token";
const EXCHANGE_PATH = "/oauth/token";

function deviceResponse(id = "device-id") {
  // Zero interval keeps manual alarm delivery deterministic without sleeps or a fake clock.
  return Response.json({ device_auth_id: id, user_code: "ABCD-EFGH", interval: 0 });
}

function authorizedResponse() {
  return Response.json({
    authorization_code: "authorization-code",
    code_verifier: "verifier-secret",
  });
}

function tokenResponse() {
  return Response.json({
    access_token: ACCESS_TOKEN,
    refresh_token: "refresh-secret",
    expires_in: 3600,
  });
}

async function withProviderFetch(
  handler: (request: Request) => Promise<Response>,
  run: (requests: Request[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    assertEquals(
      new URL(request.url).origin,
      "https://auth.openai.com",
      "only provider HTTP may use global fetch",
    );
    assertEquals(request.method, "POST");
    assertEquals(init?.redirect, "error");
    assert(init?.signal instanceof AbortSignal);
    requests.push(request.clone());
    return handler(request);
  };
  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("device OAuth polling persists through alarms and object reconstruction", async () => {
  const context = await configured();
  const replies = [
    { path: DEVICE_PATH, response: deviceResponse() },
    { path: POLL_PATH, response: new Response(null, { status: 403 }) },
    { path: POLL_PATH, response: authorizedResponse() },
    { path: EXCHANGE_PATH, response: tokenResponse() },
  ];
  await withProviderFetch((request) => {
    const reply = replies.shift();
    assert(reply, "unexpected provider HTTP request");
    assertEquals(new URL(request.url).pathname, reply.path);
    return Promise.resolve(reply.response);
  }, async (requests) => {
    const authorization = await context.client.call("startProviderLogin", context.workspaceId);
    assert(context.storage.alarm !== null);
    const restarted = activate(context.storage);
    assertEquals(
      await restarted.client.call("getProviderLoginStatus", context.workspaceId, authorization.id),
      {
        status: "pending",
        authorization,
      },
    );
    await restarted.worker.alarm();
    assert(context.storage.alarm !== null);
    assertEquals(
      await restarted.client.call(
        "getModelProviderCredential",
        context.workspaceId,
        "openai-codex",
      ),
      null,
    );
    const again = activate(context.storage);
    const originalNow = Date.now;
    Date.now = () => context.storage.alarm ?? originalNow();
    try {
      await again.worker.alarm();
    } finally {
      Date.now = originalNow;
    }
    assertEquals(
      await again.client.call("getProviderLoginStatus", context.workspaceId, authorization.id),
      { status: "complete" },
    );
    assertEquals(context.storage.alarm, null);
    assertEquals(
      (await again.client.call("getModelProviderCredential", context.workspaceId, "openai-codex"))
        ?.credentialType,
      "oauth",
    );
    assertEquals(
      await activate(context.storage).client.call(
        "resolveProviderAccessToken",
        context.workspaceId,
      ),
      ACCESS_TOKEN,
    );
    assertEquals(
      await again.client.call("getModelProviderApiKey", context.workspaceId, "openai-codex"),
      [null, undefined],
    );
    assertEquals(replies.length, 0);
    assertEquals(JSON.parse(await requests[1]!.text()), {
      device_auth_id: "device-id",
      user_code: "ABCD-EFGH",
    });
    const persisted = JSON.stringify([...await context.storage.list({ prefix: "" })]);
    assertEquals(persisted.includes(ACCESS_TOKEN), false);
    assertEquals(persisted.includes("refresh-secret"), false);
    await again.worker.alarm();
    assertEquals(requests.length, 4, "a completed alarm must not exchange twice");
  });
});

Deno.test("cancelling or replacing persisted OAuth attempts rejects stale IDs and stale alarms", async () => {
  const { client, storage, workspaceId } = await configured();
  await withProviderFetch((request) => {
    assertEquals(
      new URL(request.url).pathname,
      DEVICE_PATH,
      "cancelled attempts must never poll or exchange",
    );
    return Promise.resolve(deviceResponse());
  }, async (requests) => {
    const cancelled = await client.call("startProviderLogin", workspaceId);
    const restarted = activate(storage);
    await restarted.client.call("cancelProviderLogin", workspaceId, cancelled.id);
    await activate(storage).worker.alarm();
    assertEquals(storage.alarm, null);
    assertEquals(await restarted.client.call("getProviderLoginStatus", workspaceId, cancelled.id), {
      status: "missing",
    });
    const old = await restarted.client.call("startProviderLogin", workspaceId);
    const replacement = await activate(storage).client.call("startProviderLogin", workspaceId);
    assertNotEquals(old.id, replacement.id);
    await restarted.client.call("cancelProviderLogin", workspaceId, old.id);
    assertEquals(await restarted.client.call("getProviderLoginStatus", workspaceId, old.id), {
      status: "missing",
    });
    assertEquals(
      await restarted.client.call("getProviderLoginStatus", workspaceId, replacement.id),
      { status: "pending", authorization: replacement },
    );
    await restarted.client.call("cancelProviderLogin", workspaceId, replacement.id);
    await activate(storage).worker.alarm();
    assertEquals(
      await restarted.client.call("getModelProviderCredential", workspaceId, "openai-codex"),
      null,
    );
    assertEquals(storage.alarm, null);
    assertEquals(requests.length, 3);
  });
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("OAuth test operation did not settle within 2 seconds")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

Deno.test("cancellation and replacement during an OAuth poll cannot save a stale credential", async (t) => {
  for (const action of ["cancel", "replace"] as const) {
    await t.step(action, async () => {
      const { client, worker, storage, workspaceId } = await configured();
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      await withProviderFetch((request) => {
        const path = new URL(request.url).pathname;
        if (path === DEVICE_PATH) return Promise.resolve(deviceResponse());
        if (path === POLL_PATH) {
          entered.resolve();
          // Deliberately deliver a late result, even if the request signal was aborted.
          return response.promise;
        }
        assertEquals(path, EXCHANGE_PATH);
        return Promise.resolve(tokenResponse());
      }, async () => {
        const old = await client.call("startProviderLogin", workspaceId);
        const polling = worker.alarm();
        await bounded(entered.promise);
        const mutation = action === "cancel"
          ? client.call("cancelProviderLogin", workspaceId, old.id)
          : client.call("startProviderLogin", workspaceId);
        response.resolve(authorizedResponse());
        await bounded(Promise.all([polling, mutation]));
        const restarted = activate(storage).client;
        assertEquals(await restarted.call("getProviderLoginStatus", workspaceId, old.id), {
          status: "missing",
        });
        assertEquals(
          await restarted.call("getModelProviderCredential", workspaceId, "openai-codex"),
          null,
          "the invalidated attempt must not persist its late credential",
        );
      });
    });
  }
});
