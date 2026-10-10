import {
  assert,
  assertEquals,
  assertNotEquals,
  assertNotMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  ProjectId,
  SessionEnvironmentSecret,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import {
  decodeWorkspaceArguments,
  type SaveBrowserSession,
  type WorkspaceApi,
} from "../../app/cells/workspace/api.ts";
import type { Env } from "../../app/env.ts";
import httpWorker from "./http-worker.ts";
import { Workspace } from "../../app/cells/workspace/workspace.ts";
import {
  migrateWorkspaceDatabase,
  workspaceMigrations,
} from "../../app/cells/workspace/migrations.ts";
import { activate, MemoryStorage } from "./storage.ts";

function testEnvironment(getByName: () => Workspace): Env {
  // SAFETY: Workspace tests use only its own binding and master key, not gateway bindings.
  return {
    OPENORB_MASTER_KEY: "ab".repeat(32),
    // SAFETY: Logic tests call ordinary methods; native celld tests exercise the RPC transport.
    // deno-lint-ignore openorb/no-chained-type-assertions
    WORKSPACE: { getByName } as unknown as Env["WORKSPACE"],
  } as Env;
}

async function configured() {
  const context = activate();
  assertEquals(await context.workspace.createAdministrator("test-password"), [
    true,
    undefined,
  ]);
  const administrator = await context.workspace.verifyAdministratorPassword("test-password");
  assert(administrator);
  return { ...context, administrator, workspaceId: administrator.workspaceId };
}

async function createProject(workspace: WorkspaceApi, workspaceId: WorkspaceId, name = "OpenOrb") {
  const result = await workspace.saveProject(workspaceId, {
    name,
    repositoryUrl: "https://github.com/example/openorb.git",
  });
  assert(result.status === "saved");
  return result.project;
}

function snapshot(projectId: string) {
  return {
    id: SessionId.make(crypto.randomUUID()),
    projectId: ProjectId.make(projectId),
    createdAt: new Date().toISOString(),
    initialPromptPreview: "Fix the regression",
  };
}

Deno.test("test SQLite storage isolates BLOB reads and rolls back writes, deletes, and alarms", async () => {
  const storage = new MemoryStorage();
  storage.sql.exec("CREATE TABLE records (id TEXT PRIMARY KEY, bytes BLOB, name TEXT)");
  const bytes = new Uint8Array([1, 2]);
  storage.sql.exec("INSERT INTO records VALUES (?, ?, ?)", "record", bytes.buffer, "original");
  bytes[0] = 99;
  const read =
    storage.rows<{ bytes: ArrayBuffer; name: string }>("SELECT bytes, name FROM records")[0];
  assert(read);
  assertEquals(new Uint8Array(read.bytes), new Uint8Array([1, 2]));
  new Uint8Array(read.bytes)[0] = 98;
  read.name = "mutated";
  const before = storage.dump();
  await storage.setAlarm(123);
  await assertRejects(
    () =>
      storage.transaction(async (transaction) => {
        storage.sql.exec("DELETE FROM records WHERE id = ?", "record");
        storage.sql.exec(
          "INSERT INTO records VALUES (?, ?, ?)",
          "partial",
          bytes.buffer,
          "must roll back",
        );
        await transaction.setAlarm(456);
        throw new Error("forced rollback");
      }),
    Error,
    "forced rollback",
  );
  assertEquals(storage.dump(), before);
  assertEquals(
    storage.rows<{ bytes: ArrayBuffer; name: string }>("SELECT bytes, name FROM records"),
    [{
      bytes: new Uint8Array([1, 2]).buffer,
      name: "original",
    }],
  );
  assertEquals(storage.rows("SELECT id FROM records WHERE id = ?", "partial"), []);
  assertEquals(storage.alarm, 123);
  assertThrows(
    () =>
      storage.transactionSync(() => {
        storage.sql.exec("DELETE FROM records");
        throw new Error("forced sync rollback");
      }),
    Error,
    "forced sync rollback",
  );
  assertEquals(storage.dump(), before);
});

Deno.test("Workspace setup admits one concurrent administrator and survives reactivation", async () => {
  const { workspace, storage } = activate();
  assertEquals(await workspace.hasAdministrator(), false);
  storage.sql.exec(`CREATE TRIGGER reject_password BEFORE INSERT ON password_credentials
    BEGIN SELECT RAISE(ABORT, 'password write failed'); END;`);
  await assertRejects(
    () => workspace.createAdministrator("failed-setup"),
    Error,
    "password write failed",
  );
  assertEquals(await workspace.hasAdministrator(), false);
  assertEquals(storage.rows("SELECT id FROM workspaces"), []);
  assertEquals(storage.rows("SELECT id FROM users"), []);
  storage.sql.exec("DROP TRIGGER reject_password");
  const passwords = ["first-password", "second-password", "third-password"];
  const results = await Promise.all(
    passwords.map((password) => workspace.createAdministrator(password)),
  );
  assertEquals(results.filter(([created]) => created === true).length, 1);
  assertEquals(results.filter(([created]) => created === false).length, 2);
  for (const result of results) assertEquals(result[1], undefined);
  const winningIndex = results.findIndex(([created]) => created === true);
  const administrator = await workspace.verifyAdministratorPassword(passwords[winningIndex]!);
  assert(administrator);
  const restarted = activate(storage).workspace;
  assertEquals(await restarted.hasAdministrator(), true);
  assertEquals(await restarted.getAdministrator(administrator.userId), administrator);
  assertEquals(
    await restarted.verifyAdministratorPassword(passwords[(winningIndex + 1) % 3]!),
    null,
  );
  assertEquals(await restarted.createAdministrator("replacement"), [false, undefined]);
  assertEquals(storage.rows("SELECT id FROM users WHERE isAdministrator = 1").length, 1);
  assertEquals(storage.rows("SELECT id FROM workspaces").length, 1);
  assertEquals(storage.rows("SELECT userId FROM password_credentials").length, 1);
});

Deno.test("Workspace migrations preserve records, roll back failed upgrades, and reject drift", async () => {
  const { workspace, storage, administrator, workspaceId } = await configured();
  const project = await createProject(workspace, workspaceId);
  const reopened = activate(storage).workspace;
  assertEquals(await reopened.verifyAdministratorPassword("test-password"), administrator);
  assertEquals(await reopened.getProject(workspaceId, project.id), project);
  assertEquals(storage.rows("SELECT id FROM data_table_migrations"), [{ id: "0001" }]);
  const unchanged = storage.dump();
  assertEquals((await migrateWorkspaceDatabase(storage, workspaceMigrations)).applied, []);
  assertEquals(storage.dump(), unchanged);

  const upgrade = {
    id: "0002",
    name: "project_note",
    up: "ALTER TABLE projects ADD COLUMN note TEXT NOT NULL DEFAULT 'retained';",
  };
  const failed = {
    id: "0003",
    name: "migration_probe",
    up: "CREATE TABLE migration_probe (value TEXT); INSERT INTO missing_table VALUES ('fail');",
  };
  await assertRejects(() =>
    migrateWorkspaceDatabase(storage, [
      ...workspaceMigrations,
      upgrade,
      failed,
    ])
  );
  assertEquals(storage.dump(), unchanged);
  assertEquals(
    storage.rows("SELECT name FROM pragma_table_info('projects') WHERE name = 'note'"),
    [],
  );
  assertEquals(storage.rows("SELECT name FROM sqlite_master WHERE name = 'migration_probe'"), []);

  const migrations = [
    ...workspaceMigrations,
    upgrade,
    {
      ...failed,
      up: "CREATE TABLE migration_probe (value TEXT); INSERT INTO migration_probe VALUES ('ok');",
    },
  ];
  assertEquals((await migrateWorkspaceDatabase(storage, migrations)).applied.map((m) => m.id), [
    "0002",
    "0003",
  ]);
  assertEquals(storage.rows("SELECT id, note FROM projects"), [{
    id: project.id,
    note: "retained",
  }]);
  assertEquals(storage.rows("SELECT * FROM migration_probe"), [{ value: "ok" }]);
  const upgraded = storage.dump();
  assertEquals((await migrateWorkspaceDatabase(storage, migrations)).applied, []);
  await assertRejects(() =>
    migrateWorkspaceDatabase(storage, [
      ...workspaceMigrations,
      { ...upgrade, up: upgrade.up + "\n" },
      migrations[2]!,
    ])
  );
  assertEquals(storage.dump(), upgraded);
  // An older Workspace build must refuse an unknown applied migration before serving requests.
  const older = activate(storage).workspace;
  await assertRejects(() => older.health());
  await assertRejects(() => older.getProject(workspaceId, project.id));
});

Deno.test("Worker validates HTTP before RPC and keeps remote failures private", async () => {
  const { workspace, storage, workspaceId } = await configured();
  const environment = testEnvironment(() => workspace);
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
  assertEquals(await workspace.listProjects(workspaceId), []);
  const unknown = await httpWorker.fetch(
    new Request("http://workspace.test/notAnOperation", {
      method: "POST",
      body: "[]",
    }),
    environment,
  );
  assertEquals(unknown.status, 404, "the test transport exposes only its explicit operation list");
  class FailingWorkspace extends Workspace {
    override getProject(): ReturnType<Workspace["getProject"]> {
      return Promise.reject(new Error("sensitive provider response"));
    }
  }
  const failing = new FailingWorkspace(
    { storage, blockConcurrencyWhile: (callback) => callback() },
    environment,
  );
  await failing.health();
  const result = await httpWorker.fetch(
    new Request("http://workspace.test/getProject", {
      method: "POST",
      body: JSON.stringify([workspaceId, "missing"]),
    }),
    testEnvironment(() => failing),
  );
  assertEquals(result.status, 500);
  assertEquals(await result.text(), "Workspace operation failed");
});

Deno.test("native secret arguments accept optional undefined or omission but reject null", async () => {
  const { workspace, workspaceId } = await configured();
  assertEquals((await workspace.saveSecret(workspaceId, "OMITTED", "value")).status, "saved");
  assertEquals(
    (await workspace.saveSecret(workspaceId, "UNDEFINED", "value", undefined)).status,
    "saved",
  );
  assertEquals(
    decodeWorkspaceArguments("saveSecret", [workspaceId, "TOKEN", "value", undefined]),
    [workspaceId, "TOKEN", "value", undefined],
  );
  assertThrows(() => decodeWorkspaceArguments("saveSecret", [workspaceId, "TOKEN", "value", null]));
  await assertRejects(() =>
    // @ts-expect-error Untrusted native arguments must reject null, not normalize HTTP placeholders.
    workspace.saveSecret(workspaceId, "INVALID", "value", null)
  );
  assertEquals(await workspace.getSecret(workspaceId, "INVALID"), null);
});

Deno.test("project name conflicts do not overwrite data and reads are Workspace-scoped", async () => {
  const { workspace, storage, workspaceId } = await configured();
  const input = { name: "OpenOrb", repositoryUrl: "https://github.com/example/openorb.git" };
  const results = await Promise.all([
    workspace.saveProject(workspaceId, input),
    workspace.saveProject(workspaceId, {
      ...input,
      repositoryUrl: "https://github.com/example/other.git",
    }),
  ]);
  const saved = results.find((result) => result.status === "saved");
  assert(saved?.status === "saved");
  assertEquals(results.filter((result) => result.status === "name-conflict").length, 1);
  const foreign = WorkspaceId.make(crypto.randomUUID());
  assertEquals(await workspace.getProject(foreign, saved.project.id), null);
  assertEquals(await workspace.listProjects(foreign), []);
  assertEquals(
    await workspace.saveProject(workspaceId, { ...input, id: crypto.randomUUID() }),
    { status: "not-found" },
  );
  assertEquals(await activate(storage).workspace.listProjects(workspaceId), [saved.project]);
});

Deno.test("credentials persist as ciphertext; metadata omits secrets; null Results stay successful", async () => {
  const { workspace, storage, workspaceId } = await configured();
  assertEquals(await workspace.getModelProviderApiKey(workspaceId, "openai"), [
    null,
    undefined,
  ]);
  assertEquals(await workspace.getGitHubToken(workspaceId), [null, undefined]);
  const apiKey = "provider-plaintext-must-not-persist";
  const gitToken = "github-plaintext-must-not-persist";
  const secretValue = "environment-plaintext-must-not-persist";
  const provider = await workspace.saveModelProviderCredential(workspaceId, "openai", apiKey);
  const github = await workspace.saveGitHubCredential(workspaceId, gitToken);
  const secret = await workspace.saveSecret(workspaceId, "SERVICE_TOKEN", secretValue, [
    "api.example.com",
  ]);
  assertEquals(secret.status, "saved");
  const stored = storage.rows<{ ciphertext: ArrayBuffer; keyVersion: number }>(
    `
    SELECT s.ciphertext, s.keyVersion FROM model_provider_credentials p
    JOIN encrypted_secrets s ON s.workspaceId = p.workspaceId AND s.key = p.secretKey
    WHERE p.workspaceId = ? AND p.providerId = ?
  `,
    workspaceId,
    "openai",
  )[0];
  assert(stored?.ciphertext instanceof ArrayBuffer);
  assert(stored.ciphertext.byteLength > apiKey.length);
  assertEquals(stored.keyVersion, 1);
  const persisted = storage.dump();
  for (const plaintext of [apiKey, gitToken, secretValue]) {
    assertEquals(persisted.includes(plaintext), false);
    assertEquals(JSON.stringify([provider, github, secret]).includes(plaintext), false);
  }
  assertEquals("secret" in provider, false);
  const restarted = activate(storage).workspace;
  assertEquals(await restarted.getModelProviderCredential(workspaceId, "openai"), provider);
  assertEquals(await restarted.getModelProviderApiKey(workspaceId, "openai"), [
    apiKey,
    undefined,
  ]);
  assertEquals(await restarted.getGitHubToken(workspaceId), [gitToken, undefined]);
  const [secrets, error] = await restarted.getEnvironmentSecrets(workspaceId);
  assertEquals(error, undefined);
  assert(secrets);
  assertEquals([secrets, error], [[
    {
      name: "SERVICE_TOKEN",
      value: secretValue,
      allowedHosts: ["api.example.com"],
    },
  ], undefined]);
  assertEquals(Object.getPrototypeOf(secrets[0]), Object.prototype);
  assertEquals(secrets[0] instanceof SessionEnvironmentSecret, false);
  const foreign = WorkspaceId.make(crypto.randomUUID());
  assertEquals(await restarted.getModelProviderApiKey(foreign, "openai"), [
    null,
    undefined,
  ]);
  assertEquals(await restarted.getSecret(foreign, "SERVICE_TOKEN"), null);
});

Deno.test("runner enrollment authenticates durably and revocation invalidates the token", async () => {
  const { workspace, storage, workspaceId } = await configured();
  const enrollment = await workspace.getRunnerEnrollmentToken(workspaceId);
  assertEquals(new Date(enrollment.createdAt).toISOString(), enrollment.createdAt);
  const input = {
    enrollmentPsk: enrollment.token,
    name: "  Test runner  ",
    architecture: "x64" as const,
  };
  assertEquals(await workspace.enrollRunner({ ...input, enrollmentPsk: "wrong-psk" }), null);
  const enrolled = await workspace.enrollRunner(input);
  assert(enrolled);
  const restarted = activate(storage).workspace;
  assertEquals(await restarted.authenticateRunner(enrolled.runnerToken), {
    id: enrolled.runnerId,
    workspaceId,
  });
  const runners = await restarted.listRunners(workspaceId);
  assertEquals(runners.length, 1);
  assertEquals(runners[0]?.name, "Test runner");
  assert(runners[0]);
  assertEquals(new Date(runners[0].createdAt).toISOString(), runners[0].createdAt);
  assertEquals(runners[0].revokedAt, null);
  assertNotMatch(
    JSON.stringify(storage.rows("SELECT * FROM runners")),
    new RegExp(enrolled.runnerToken),
  );
  assertEquals(
    await restarted.revokeRunner(WorkspaceId.make(crypto.randomUUID()), enrolled.runnerId),
    "not-found",
  );
  assertEquals(await restarted.revokeRunner(workspaceId, enrolled.runnerId), "revoked");
  assertEquals(
    await activate(storage).workspace.authenticateRunner(enrolled.runnerToken),
    null,
  );
  const revokedAt = (await restarted.listRunners(workspaceId))[0]?.revokedAt;
  assert(revokedAt !== null && revokedAt !== undefined);
  assertEquals(new Date(revokedAt).toISOString(), revokedAt);
  const rotated = await restarted.regenerateRunnerEnrollmentToken(workspaceId);
  assertEquals(new Date(rotated.createdAt).toISOString(), rotated.createdAt);
  assertNotEquals(rotated.token, enrollment.token);
  assertEquals(await restarted.enrollRunner(input), null);
});

Deno.test("catalog manifests are all-or-nothing and durable tombstones prevent resurrection", async () => {
  const { workspace, storage, workspaceId } = await configured();
  const project = await createProject(workspace, workspaceId);
  const existing = snapshot(project.id);
  assertEquals(await workspace.reconcileSessionManifestEntries(workspaceId, [existing]), [{
    acceptedSessionIds: [existing.id],
    tombstonedSessionIds: [],
    rejected: [],
  }, undefined]);
  const fresh = snapshot(project.id);
  const missing = snapshot(crypto.randomUUID());
  const conflict = {
    ...existing,
    initialPromptPreview: "Changed immutable preview",
  };
  assertEquals(
    await workspace.reconcileSessionManifestEntries(workspaceId, [fresh, conflict, missing]),
    [{
      acceptedSessionIds: [],
      tombstonedSessionIds: [],
      rejected: [
        { sessionId: existing.id, reason: "catalog-conflict" },
        { sessionId: missing.id, reason: "project-not-found" },
      ],
    }, undefined],
  );
  assertEquals(await workspace.getSessionCatalogEntry(workspaceId, fresh.id), null);
  assertEquals(
    (await workspace.getSessionCatalogEntry(workspaceId, existing.id))?.initialPromptPreview,
    existing.initialPromptPreview,
  );
  const deletedAt = new Date().toISOString();
  assertEquals(
    await workspace.deleteSessionCatalogEntry(workspaceId, existing.id, deletedAt),
    ["deleted", undefined],
  );
  const restarted = activate(storage).workspace;
  assertEquals(
    await restarted.reconcileSessionManifestEntries(workspaceId, [existing, fresh]),
    [{
      acceptedSessionIds: [fresh.id],
      tombstonedSessionIds: [existing.id],
      rejected: [],
    }, undefined],
  );
  assertEquals(await restarted.getSessionCatalogEntry(workspaceId, existing.id), null);
  assertEquals(
    storage.rows(
      "SELECT deletedAt FROM deleted_sessions WHERE workspaceId = ? AND sessionId = ?",
      workspaceId,
      existing.id,
    ),
    [{ deletedAt }],
  );
  assertEquals(await restarted.listSessionNavigationEntries(workspaceId), [{
    id: fresh.id,
    projectId: project.id,
    projectName: project.name,
    initialPromptPreview: fresh.initialPromptPreview,
  }]);
});

Deno.test("Workspace preserves protocol limits and rejects conflicting entries in one manifest", async () => {
  const { workspace, workspaceId } = await configured();
  const hosts = Array.from({ length: 32 }, (_, index) => `api${index}.example.com`);
  assertEquals(
    (await workspace.saveSecret(workspaceId, "HOSTS", "test-secret", hosts)).status,
    "saved",
  );
  await assertRejects(() =>
    workspace.saveSecret(workspaceId, "HOSTS", "test-secret", [...hosts, "extra.example.com"])
  );
  const project = await createProject(workspace, workspaceId);
  const entry = {
    ...snapshot(project.id),
    initialPromptPreview: "😀".repeat(200),
  };
  const entries = [entry] as const;
  const [accepted, error] = await workspace.reconcileSessionManifestEntries(workspaceId, entries);
  assertEquals(error, undefined);
  assertEquals(accepted?.acceptedSessionIds, [entry.id]);
  await assertRejects(() =>
    workspace.reconcileSessionManifestEntries(workspaceId, [
      { ...entry, initialPromptPreview: "😀".repeat(201) },
    ])
  );
  const fresh = snapshot(project.id);
  const [rejected] = await workspace.reconcileSessionManifestEntries(workspaceId, [
    fresh,
    { ...fresh, initialPromptPreview: "Different immutable preview" },
  ]);
  assertEquals(rejected?.rejected, [{ sessionId: fresh.id, reason: "catalog-conflict" }]);
  assertEquals(await workspace.getSessionCatalogEntry(workspaceId, fresh.id), null);
});

Deno.test("browser-session rotation and logout reject stale saves after reactivation", async () => {
  const { workspace, storage, administrator } = await configured();
  const anonymous: SaveBrowserSession = {
    id: crypto.randomUUID(),
    mode: "insert",
    data: [{ csrf: "csrf-value" }, {}],
  };
  assertEquals(await workspace.saveBrowserSession(anonymous), true);
  const authenticated: SaveBrowserSession = {
    id: crypto.randomUUID(),
    previousId: anonymous.id,
    mode: "rotate",
    data: [{ auth: administrator, csrf: "new-csrf-value" }, {}],
  };
  assertEquals(await workspace.saveBrowserSession(authenticated), true);
  const restarted = activate(storage).workspace;
  assertEquals(await restarted.readBrowserSession(anonymous.id), null);
  assertEquals(await restarted.saveBrowserSession({ ...anonymous, mode: "update" }), false);
  const record = await restarted.readBrowserSession(authenticated.id);
  assert(record);
  assertEquals(record.userId, administrator.userId);
  assertEquals(record.workspaceId, administrator.workspaceId);
  assertEquals(record.data, authenticated.data);
  await restarted.deleteBrowserSessions([authenticated.id, anonymous.id]);
  const afterLogout = activate(storage).workspace;
  assertEquals(
    await afterLogout.saveBrowserSession({ ...authenticated, mode: "update" }),
    false,
  );
  const staleRotationId = crypto.randomUUID();
  assertEquals(
    await afterLogout.saveBrowserSession({
      ...authenticated,
      id: staleRotationId,
      previousId: authenticated.id,
      mode: "rotate",
    }),
    false,
  );
  assertEquals(await afterLogout.readBrowserSession(authenticated.id), null);
  assertEquals(await afterLogout.readBrowserSession(staleRotationId), null);
  assertEquals(storage.rows("SELECT id FROM browser_sessions"), []);
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
    const authorization = await context.workspace.startProviderLogin(context.workspaceId);
    assert(context.storage.alarm !== null);
    const restarted = activate(context.storage);
    assertEquals(
      await restarted.workspace.getProviderLoginStatus(context.workspaceId, authorization.id),
      {
        status: "pending",
        authorization,
      },
    );
    await restarted.workspace.alarm();
    assert(context.storage.alarm !== null);
    assertEquals(
      await restarted.workspace.getModelProviderCredential(
        context.workspaceId,
        "openai-codex",
      ),
      null,
    );
    const again = activate(context.storage);
    const originalNow = Date.now;
    Date.now = () => context.storage.alarm ?? originalNow();
    try {
      await again.workspace.alarm();
    } finally {
      Date.now = originalNow;
    }
    assertEquals(
      await again.workspace.getProviderLoginStatus(context.workspaceId, authorization.id),
      { status: "complete" },
    );
    assertEquals(context.storage.alarm, null);
    assertEquals(
      (await again.workspace.getModelProviderCredential(context.workspaceId, "openai-codex"))
        ?.credentialType,
      "oauth",
    );
    assertEquals(
      await activate(context.storage).workspace.resolveProviderAccessToken(
        context.workspaceId,
      ),
      ACCESS_TOKEN,
    );
    assertEquals(
      await again.workspace.getModelProviderApiKey(context.workspaceId, "openai-codex"),
      [null, undefined],
    );
    assertEquals(replies.length, 0);
    assertEquals(JSON.parse(await requests[1]!.text()), {
      device_auth_id: "device-id",
      user_code: "ABCD-EFGH",
    });
    const persisted = context.storage.dump();
    assertEquals(persisted.includes(ACCESS_TOKEN), false);
    assertEquals(persisted.includes("refresh-secret"), false);
    await again.workspace.alarm();
    assertEquals(requests.length, 4, "a completed alarm must not exchange twice");
  });
});

Deno.test("cancelling or replacing persisted OAuth attempts rejects stale IDs and stale alarms", async () => {
  const { workspace, storage, workspaceId } = await configured();
  await withProviderFetch((request) => {
    assertEquals(
      new URL(request.url).pathname,
      DEVICE_PATH,
      "cancelled attempts must never poll or exchange",
    );
    return Promise.resolve(deviceResponse());
  }, async (requests) => {
    const cancelled = await workspace.startProviderLogin(workspaceId);
    const restarted = activate(storage);
    await restarted.workspace.cancelProviderLogin(workspaceId, cancelled.id);
    await activate(storage).workspace.alarm();
    assertEquals(storage.alarm, null);
    assertEquals(await restarted.workspace.getProviderLoginStatus(workspaceId, cancelled.id), {
      status: "missing",
    });
    const old = await restarted.workspace.startProviderLogin(workspaceId);
    const replacement = await activate(storage).workspace.startProviderLogin(workspaceId);
    assertNotEquals(old.id, replacement.id);
    await restarted.workspace.cancelProviderLogin(workspaceId, old.id);
    assertEquals(await restarted.workspace.getProviderLoginStatus(workspaceId, old.id), {
      status: "missing",
    });
    assertEquals(
      await restarted.workspace.getProviderLoginStatus(workspaceId, replacement.id),
      { status: "pending", authorization: replacement },
    );
    await restarted.workspace.cancelProviderLogin(workspaceId, replacement.id);
    await activate(storage).workspace.alarm();
    assertEquals(
      await restarted.workspace.getModelProviderCredential(workspaceId, "openai-codex"),
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

Deno.test("cancellation, replacement, and disconnect during an OAuth poll cannot save a stale credential", async (t) => {
  for (const action of ["cancel", "replace", "disconnect"] as const) {
    await t.step(action, async () => {
      const { workspace, storage, workspaceId } = await configured();
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
        const old = await workspace.startProviderLogin(workspaceId);
        const polling = workspace.alarm();
        await bounded(entered.promise);
        const mutation = action === "cancel"
          ? workspace.cancelProviderLogin(workspaceId, old.id)
          : action === "replace"
          ? workspace.startProviderLogin(workspaceId)
          : workspace.disconnectProvider(workspaceId);
        response.resolve(authorizedResponse());
        await bounded(Promise.all([polling, mutation]));
        const restarted = activate(storage).workspace;
        assertEquals(await restarted.getProviderLoginStatus(workspaceId, old.id), {
          status: "missing",
        });
        assertEquals(
          await restarted.getModelProviderCredential(workspaceId, "openai-codex"),
          null,
          "the invalidated attempt must not persist its late credential",
        );
      });
    });
  }
});

Deno.test("disconnect during refresh revokes the rotated token and cannot resurrect credentials", async () => {
  const { workspace, storage, workspaceId } = await configured();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  await withProviderFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === DEVICE_PATH) return deviceResponse();
    if (path === POLL_PATH) return authorizedResponse();
    if (path === EXCHANGE_PATH) {
      const fields = new URLSearchParams(await request.text());
      if (fields.get("grant_type") === "authorization_code") {
        return Response.json({
          access_token: ACCESS_TOKEN,
          refresh_token: "initial-refresh-token",
          expires_in: 1,
        });
      }
      assertEquals(fields.get("grant_type"), "refresh_token");
      assertEquals(fields.get("refresh_token"), "initial-refresh-token");
      entered.resolve();
      return response.promise;
    }
    assertEquals(path, "/oauth/revoke");
    return new Response(null, { status: 200 });
  }, async (requests) => {
    await workspace.startProviderLogin(workspaceId);
    await workspace.alarm();
    const refreshing = workspace.resolveProviderAccessToken(workspaceId);
    await bounded(entered.promise);
    const disconnecting = workspace.disconnectProvider(workspaceId);
    response.resolve(Response.json({
      access_token: ACCESS_TOKEN,
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
    }));
    assertEquals(await bounded(disconnecting), { status: "deleted" });
    await bounded(refreshing);
    const restarted = activate(storage).workspace;
    assertEquals(await restarted.getModelProviderCredential(workspaceId, "openai-codex"), null);
    assertEquals(await restarted.resolveProviderAccessToken(workspaceId), null);
    const revocations = requests.filter((r) => new URL(r.url).pathname === "/oauth/revoke");
    assertEquals(revocations.length, 1);
    assertEquals((await revocations[0]!.json()).token, "rotated-refresh-token");
  });
});
