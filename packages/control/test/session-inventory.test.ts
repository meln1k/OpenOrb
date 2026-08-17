import { assert, assertEquals } from "@std/assert";

import type { RunnerSessionSnapshot } from "@openorb/protocol";
import { RunnerConnectionGateway } from "@/app/runner-connection-gateway.ts";
import { createTestServer } from "@/test/http-test-server.ts";
import { createTestStore, createTestUser } from "@/test/postgres-test.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const OTHER_RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const RUNNER_TOKEN = `openorb_runner_${"a".repeat(43)}`;
const OTHER_RUNNER_TOKEN = `openorb_runner_${"b".repeat(43)}`;
const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
const TOMBSTONED_SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c12";
const FOREIGN_PROJECT_SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c13";
const SNAPSHOT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c14";
const ROLLED_BACK_SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c20";

Deno.test("reconciles runner inventory into only catalog rows and in-memory tenant routes", async () => {
  const store = await createTestStore();
  const userId = await createTestUser(store);
  const otherUserId = await createTestUser(store);
  const project = await createProject(store, userId, "Owner project");
  const otherProject = await createProject(store, otherUserId, "Other project");
  const gateway = new RunnerConnectionGateway({
    authenticateRunner(token) {
      if (token === RUNNER_TOKEN) return Promise.resolve({ id: RUNNER_ID, userId });
      if (token === OTHER_RUNNER_TOKEN) {
        return Promise.resolve({ id: OTHER_RUNNER_ID, userId: otherUserId });
      }
      return Promise.resolve(null);
    },
    reconcileSessionSnapshotEntries: store.reconcileSessionSnapshotEntries,
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;
  let otherSocket: WebSocket | undefined;

  try {
    socket = await authenticateRunner(server.baseUrl, RUNNER_TOKEN);
    const session = snapshot(SESSION_ID, project.id);
    sendReconcileStart(socket, SNAPSHOT_ID);
    sendReconcileChunk(socket, SNAPSHOT_ID, 0, [session]);
    sendHeartbeat(socket);
    await waitFor(() => gateway.getRunnerLiveState(userId, RUNNER_ID) !== null);
    assertEquals(await catalogCount(store, userId, SESSION_ID), 0);
    assertEquals(gateway.getSessionRunner(userId, SESSION_ID), null);
    sendReconcileComplete(socket, SNAPSHOT_ID, 1, 1);
    await waitFor(() => gateway.getSessionRunner(userId, SESSION_ID) === RUNNER_ID);

    assertEquals(gateway.getSessionRunner(otherUserId, SESSION_ID), null);
    assertEquals(
      (await store.pool.query(
        `select user_id, id, project_id, created_at, initial_prompt_preview
           from sessions
          where user_id = $1 and id = $2`,
        [userId, SESSION_ID],
      )).rows,
      [{
        user_id: userId,
        id: SESSION_ID,
        project_id: project.id,
        created_at: session.createdAt,
        initial_prompt_preview: session.initialPromptPreview,
      }],
    );

    await store.pool.query(
      "insert into deleted_sessions (user_id, session_id, deleted_at) values ($1, $2, $3)",
      [userId, TOMBSTONED_SESSION_ID, "2026-08-17T12:05:00Z"],
    );
    const disconnected = closed(socket);
    socket.close();
    await disconnected;
    socket = await authenticateRunner(server.baseUrl, RUNNER_TOKEN);
    const tombstoned = snapshot(TOMBSTONED_SESSION_ID, project.id);
    const tombstoneSnapshotId = "01989d78-65ee-7f6a-a97e-0f16ad134c15";
    sendReconcileStart(socket, tombstoneSnapshotId);
    sendReconcileChunk(socket, tombstoneSnapshotId, 0, [tombstoned]);
    sendReconcileComplete(socket, tombstoneSnapshotId, 1, 1);
    sendHeartbeat(socket);
    await waitFor(() => gateway.getRunnerLiveState(userId, RUNNER_ID) !== null);
    assertEquals(await catalogCount(store, userId, TOMBSTONED_SESSION_ID), 0);
    assertEquals(gateway.getSessionRunner(userId, TOMBSTONED_SESSION_ID), null);

    otherSocket = await authenticateRunner(server.baseUrl, OTHER_RUNNER_TOKEN);
    const sameIdInOtherTenant = snapshot(TOMBSTONED_SESSION_ID, otherProject.id);
    const otherSnapshotId = "01989d78-65ee-7f6a-a97e-0f16ad134c16";
    sendReconcileStart(otherSocket, otherSnapshotId);
    sendReconcileChunk(otherSocket, otherSnapshotId, 0, [sameIdInOtherTenant]);
    sendReconcileComplete(otherSocket, otherSnapshotId, 1, 1);
    await waitFor(() =>
      gateway.getSessionRunner(otherUserId, TOMBSTONED_SESSION_ID) === OTHER_RUNNER_ID
    );
    assertEquals(await catalogCount(store, otherUserId, TOMBSTONED_SESSION_ID), 1);
    assertEquals(await catalogCount(store, userId, TOMBSTONED_SESSION_ID), 0);

    const rejectedSnapshotId = "01989d78-65ee-7f6a-a97e-0f16ad134c17";
    const reconciledConnectionClosed = closed(socket);
    socket.close();
    await reconciledConnectionClosed;
    socket = await authenticateRunner(server.baseUrl, RUNNER_TOKEN);
    sendReconcileStart(socket, rejectedSnapshotId);
    const rejectedClose = closed(socket);
    sendReconcileChunk(socket, rejectedSnapshotId, 0, [
      snapshot(ROLLED_BACK_SESSION_ID, project.id),
      snapshot(FOREIGN_PROJECT_SESSION_ID, otherProject.id),
    ]);
    sendReconcileComplete(socket, rejectedSnapshotId, 1, 2);
    assertEquals((await rejectedClose).code, 4400);
    assertEquals(await catalogCount(store, userId, ROLLED_BACK_SESSION_ID), 0);
    assertEquals(await catalogCount(store, userId, FOREIGN_PROJECT_SESSION_ID), 0);
    assertEquals(gateway.getSessionRunner(userId, FOREIGN_PROJECT_SESSION_ID), null);
    assertEquals(
      gateway.getSessionRunner(otherUserId, TOMBSTONED_SESSION_ID),
      OTHER_RUNNER_ID,
    );

    await assertSessionSchemas(store);
  } finally {
    socket?.close();
    otherSocket?.close();
    gateway.close();
    await server.close();
    await store.close();
  }
});

Deno.test("a reconnect rebuilds routes without deleting absent catalog rows", async () => {
  const store = await createTestStore();
  const userId = await createTestUser(store);
  const project = await createProject(store, userId, "Reconnect project");
  const repository = {
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId }),
    reconcileSessionSnapshotEntries: store.reconcileSessionSnapshotEntries,
  };
  let gateway = new RunnerConnectionGateway(repository);
  let server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await authenticateRunner(server.baseUrl, RUNNER_TOKEN);
    sendCompleteSnapshot(socket, SNAPSHOT_ID, [snapshot(SESSION_ID, project.id)]);
    await waitFor(() => gateway.getSessionRunner(userId, SESSION_ID) === RUNNER_ID);

    socket.close();
    await waitFor(() => gateway.getSessionRunner(userId, SESSION_ID) === null);
    assertEquals(await catalogCount(store, userId, SESSION_ID), 1);
    gateway.close();
    await server.close();

    gateway = new RunnerConnectionGateway(repository);
    server = await createTestServer((request) => gateway.handleUpgrade(request));
    socket = await authenticateRunner(server.baseUrl, RUNNER_TOKEN);
    const emptySnapshotId = "01989d78-65ee-7f6a-a97e-0f16ad134c18";
    sendCompleteSnapshot(socket, emptySnapshotId, []);
    sendHeartbeat(socket);
    await waitFor(() => gateway.getRunnerLiveState(userId, RUNNER_ID) !== null);
    assertEquals(gateway.getSessionRunner(userId, SESSION_ID), null);
    assertEquals(await catalogCount(store, userId, SESSION_ID), 1);

    const emptySnapshotConnectionClosed = closed(socket);
    socket.close();
    await emptySnapshotConnectionClosed;
    socket = await authenticateRunner(server.baseUrl, RUNNER_TOKEN);
    const reconnectSnapshotId = "01989d78-65ee-7f6a-a97e-0f16ad134c19";
    sendCompleteSnapshot(socket, reconnectSnapshotId, [snapshot(SESSION_ID, project.id)]);
    await waitFor(() => gateway.getSessionRunner(userId, SESSION_ID) === RUNNER_ID);
    assertEquals(await catalogCount(store, userId, SESSION_ID), 1);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
    await store.close();
  }
});

Deno.test("rejects a second snapshot on the same authenticated connection", async () => {
  const store = await createTestStore();
  const userId = await createTestUser(store);
  const project = await createProject(store, userId, "Replay project");
  const gateway = new RunnerConnectionGateway({
    authenticateRunner: () => Promise.resolve({ id: RUNNER_ID, userId }),
    reconcileSessionSnapshotEntries: store.reconcileSessionSnapshotEntries,
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let socket: WebSocket | undefined;

  try {
    socket = await authenticateRunner(server.baseUrl, RUNNER_TOKEN);
    sendCompleteSnapshot(socket, SNAPSHOT_ID, [snapshot(SESSION_ID, project.id)]);
    await waitFor(() => gateway.getSessionRunner(userId, SESSION_ID) === RUNNER_ID);

    const replayClosed = closed(socket);
    sendReconcileStart(socket, crypto.randomUUID());
    assertEquals((await replayClosed).code, 4400);
    assertEquals(await catalogCount(store, userId, SESSION_ID), 1);
    assertEquals(await catalogCount(store, userId, ROLLED_BACK_SESSION_ID), 0);
  } finally {
    socket?.close();
    gateway.close();
    await server.close();
    await store.close();
  }
});

Deno.test("concurrent same-user snapshots cannot take over an active runner route", async () => {
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  let reconciliationCalls = 0;
  let releaseFirstReconciliation!: () => void;
  const firstReconciliationPending = new Promise<void>((resolve) => {
    releaseFirstReconciliation = resolve;
  });
  let releaseSecondReconciliation!: () => void;
  const secondReconciliationPending = new Promise<void>((resolve) => {
    releaseSecondReconciliation = resolve;
  });
  let bothReconciliationsStarted!: () => void;
  const bothReconciliationsStart = new Promise<void>((resolve) => {
    bothReconciliationsStarted = resolve;
  });
  const gateway = new RunnerConnectionGateway({
    authenticateRunner(token) {
      if (token === RUNNER_TOKEN) return Promise.resolve({ id: RUNNER_ID, userId });
      if (token === OTHER_RUNNER_TOKEN) {
        return Promise.resolve({ id: OTHER_RUNNER_ID, userId });
      }
      return Promise.resolve(null);
    },
    async reconcileSessionSnapshotEntries(_reconciledUserId, entries) {
      reconciliationCalls++;
      if (reconciliationCalls === 2) bothReconciliationsStarted();
      await (entries.length === 1 ? firstReconciliationPending : secondReconciliationPending);
      return {
        acceptedSessionIds: entries.map((entry) => entry.id),
        tombstonedSessionIds: [],
        rejected: [],
      };
    },
  });
  const server = await createTestServer((request) => gateway.handleUpgrade(request));
  let firstSocket: WebSocket | undefined;
  let secondSocket: WebSocket | undefined;

  try {
    firstSocket = await authenticateRunner(server.baseUrl, RUNNER_TOKEN);
    secondSocket = await authenticateRunner(server.baseUrl, OTHER_RUNNER_TOKEN);
    sendCompleteSnapshot(firstSocket, SNAPSHOT_ID, [snapshot(SESSION_ID, projectId)]);

    const conflictingSnapshotId = crypto.randomUUID();
    sendReconcileStart(secondSocket, conflictingSnapshotId);
    sendReconcileChunk(secondSocket, conflictingSnapshotId, 0, [
      snapshot(ROLLED_BACK_SESSION_ID, projectId),
      snapshot(SESSION_ID, projectId),
    ]);
    const conflictingRunnerClosed = closed(secondSocket);
    sendReconcileComplete(secondSocket, conflictingSnapshotId, 1, 2);
    await bothReconciliationsStart;

    releaseFirstReconciliation();
    await waitFor(() => gateway.getSessionRunner(userId, SESSION_ID) === RUNNER_ID);
    releaseSecondReconciliation();

    assertEquals((await conflictingRunnerClosed).code, 4400);
    assertEquals(reconciliationCalls, 2);
    assertEquals(gateway.getSessionRunner(userId, SESSION_ID), RUNNER_ID);
    assertEquals(gateway.getSessionRunner(userId, ROLLED_BACK_SESSION_ID), null);
  } finally {
    releaseFirstReconciliation();
    releaseSecondReconciliation();
    firstSocket?.close();
    secondSocket?.close();
    gateway.close();
    await server.close();
  }
});

Deno.test("serializes reconciliation with a concurrent tombstone transaction", async () => {
  const store = await createTestStore();
  const userId = await createTestUser(store);
  const project = await createProject(store, userId, "Deletion race project");
  const blocker = await store.pool.connect();
  const deletion = await store.pool.connect();
  let reconciliation:
    | ReturnType<typeof store.reconcileSessionSnapshotEntries>
    | undefined;
  let deletionTransaction: Promise<void> | undefined;

  try {
    await store.pool.query("drop trigger if exists oo011_block_session_insert on sessions");
    await store.pool.query("drop function if exists oo011_block_session_insert() cascade");
    await store.pool.query(
      `create function oo011_block_session_insert() returns trigger
       language plpgsql as $$
       begin
         perform pg_advisory_xact_lock(11011, 1);
         return new;
       end
       $$`,
    );
    await store.pool.query(
      `create trigger oo011_block_session_insert
       after insert on sessions
       for each row execute function oo011_block_session_insert()`,
    );
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(11011, 1)");

    reconciliation = store.reconcileSessionSnapshotEntries(userId, [
      snapshot(SESSION_ID, project.id),
    ]);
    await waitForDatabaseLock(store, "insert into sessions");

    let deletionSettled = false;
    deletionTransaction = (async () => {
      await deletion.query("begin");
      await deletion.query(
        "insert into deleted_sessions (user_id, session_id, deleted_at) values ($1, $2, $3)",
        [userId, SESSION_ID, "2026-08-17T12:05:00Z"],
      );
      await deletion.query(
        "delete from sessions where user_id = $1 and id = $2",
        [userId, SESSION_ID],
      );
      await deletion.query("commit");
      deletionSettled = true;
    })();
    await waitFor(async () =>
      deletionSettled || await hasDatabaseLock(store, "insert into deleted_sessions")
    );

    await blocker.query("commit");
    await Promise.all([reconciliation, deletionTransaction]);

    assertEquals(await catalogCount(store, userId, SESSION_ID), 0);
    assertEquals(await tombstoneCount(store, userId, SESSION_ID), 1);
  } finally {
    await blocker.query("rollback").catch(() => undefined);
    await deletion.query("rollback").catch(() => undefined);
    blocker.release();
    deletion.release();
    await reconciliation?.catch(() => undefined);
    await deletionTransaction?.catch(() => undefined);
    await store.pool.query("drop trigger if exists oo011_block_session_insert on sessions");
    await store.pool.query("drop function if exists oo011_block_session_insert() cascade");
    await store.close();
  }
});

function snapshot(id: string, projectId: string): RunnerSessionSnapshot {
  return {
    id,
    projectId,
    createdAt: "2026-08-17T12:00:00Z",
    initialPromptPreview: "Inspect the repository",
    state: "created",
    lastEventCursor: 2,
  };
}

async function createProject(
  store: Awaited<ReturnType<typeof createTestStore>>,
  userId: string,
  name: string,
) {
  const saved = await store.saveProject(userId, {
    name,
    repositoryUrl: `https://github.com/openorb/${name.toLowerCase().replaceAll(" ", "-")}.git`,
  });
  assertEquals(saved.status, "saved");
  if (saved.status !== "saved") throw new Error("Project was not created.");
  return saved.project;
}

async function authenticateRunner(baseUrl: URL, token: string): Promise<WebSocket> {
  const socketUrl = new URL(baseUrl);
  socketUrl.protocol = "ws:";
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), {
      once: true,
    });
  });
  const connected = nextMessage(socket);
  socket.send(JSON.stringify({
    version: 1,
    id: crypto.randomUUID(),
    type: "runner.hello",
    payload: { token },
  }));
  await connected;
  return socket;
}

function sendCompleteSnapshot(
  socket: WebSocket,
  snapshotId: string,
  sessions: RunnerSessionSnapshot[],
): void {
  sendReconcileStart(socket, snapshotId);
  if (sessions.length > 0) sendReconcileChunk(socket, snapshotId, 0, sessions);
  sendReconcileComplete(socket, snapshotId, sessions.length > 0 ? 1 : 0, sessions.length);
}

function sendReconcileStart(socket: WebSocket, snapshotId: string): void {
  socket.send(JSON.stringify({
    version: 1,
    id: crypto.randomUUID(),
    type: "runner.reconcile.start",
    payload: { snapshotId },
  }));
}

function sendReconcileChunk(
  socket: WebSocket,
  snapshotId: string,
  sequence: number,
  sessions: RunnerSessionSnapshot[],
): void {
  socket.send(JSON.stringify({
    version: 1,
    id: crypto.randomUUID(),
    type: "runner.reconcile.chunk",
    payload: { snapshotId, sequence, sessions },
  }));
}

function sendReconcileComplete(
  socket: WebSocket,
  snapshotId: string,
  chunkCount: number,
  sessionCount: number,
): void {
  socket.send(JSON.stringify({
    version: 1,
    id: crypto.randomUUID(),
    type: "runner.reconcile.complete",
    payload: { snapshotId, chunkCount, sessionCount },
  }));
}

function sendHeartbeat(socket: WebSocket): void {
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

async function catalogCount(
  store: Awaited<ReturnType<typeof createTestStore>>,
  userId: string,
  sessionId: string,
): Promise<number> {
  const result = await store.pool.query<{ count: number }>(
    "select count(*)::integer as count from sessions where user_id = $1 and id = $2",
    [userId, sessionId],
  );
  return result.rows[0]!.count;
}

async function tombstoneCount(
  store: Awaited<ReturnType<typeof createTestStore>>,
  userId: string,
  sessionId: string,
): Promise<number> {
  const result = await store.pool.query<{ count: number }>(
    "select count(*)::integer as count from deleted_sessions where user_id = $1 and session_id = $2",
    [userId, sessionId],
  );
  return result.rows[0]!.count;
}

async function waitForDatabaseLock(
  store: Awaited<ReturnType<typeof createTestStore>>,
  queryText: string,
): Promise<void> {
  await waitFor(() => hasDatabaseLock(store, queryText));
}

async function hasDatabaseLock(
  store: Awaited<ReturnType<typeof createTestStore>>,
  queryText: string,
): Promise<boolean> {
  const result = await store.pool.query<{ count: number }>(
    `select count(*)::integer as count
       from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query like $1`,
    [`%${queryText}%`],
  );
  return result.rows[0]!.count > 0;
}

async function assertSessionSchemas(
  store: Awaited<ReturnType<typeof createTestStore>>,
): Promise<void> {
  const result = await store.pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = current_schema()
        and table_name in ('sessions', 'deleted_sessions')
      order by table_name, ordinal_position`,
  );
  assertEquals(result.rows, [
    { table_name: "deleted_sessions", column_name: "user_id" },
    { table_name: "deleted_sessions", column_name: "session_id" },
    { table_name: "deleted_sessions", column_name: "deleted_at" },
    { table_name: "sessions", column_name: "user_id" },
    { table_name: "sessions", column_name: "id" },
    { table_name: "sessions", column_name: "project_id" },
    { table_name: "sessions", column_name: "created_at" },
    { table_name: "sessions", column_name: "initial_prompt_preview" },
  ]);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, "timed out waiting for session inventory state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
