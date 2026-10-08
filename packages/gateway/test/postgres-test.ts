import { v7 } from "@std/uuid";
import { UserId, WorkspaceId } from "@openorb/protocol/runner-api";
import { WorkspaceClient } from "@openorb/workspace";
import { WORKSPACE_OPERATIONS, type WorkspaceApi } from "@openorb/workspace/api";

import { importMasterKey, type MasterKey } from "@/app/utils/master-key.ts";
import { createPostgresStore, type PostgresStore, type Store } from "@/app/data/store.ts";
import { createAppServices as createWorkspaceAppServices } from "@/app/middleware/services.ts";
import {
  createOpenAICodexAuthorizationService,
  type OpenAICodexAuthorizationService,
} from "@/app/openai-codex-authorization.ts";
import type { RunnerRegistryService } from "@/app/runner-registry.ts";
import { migrate } from "@/db/migrate.ts";

/** Test-only HTTP backing for legacy repository regressions, not the real Workspace DO. */
export function createTestWorkspaceClient(
  store: Store,
  authorization: OpenAICodexAuthorizationService = createOpenAICodexAuthorizationService(store),
): WorkspaceClient {
  // Browser sessions stay on the fixture's SessionStorage, including custom memory storage.
  const operations: Omit<
    WorkspaceApi,
    "readBrowserSession" | "saveBrowserSession" | "deleteBrowserSessions"
  > = {
    ...store,
    startProviderLogin: (workspaceId) => authorization.start(workspaceId),
    getProviderLoginStatus: (workspaceId, attemptId) =>
      Promise.resolve(authorization.status(workspaceId, attemptId)),
    cancelProviderLogin: (workspaceId, attemptId) => authorization.cancel(workspaceId, attemptId),
    disconnectProvider: (workspaceId) => authorization.disconnect(workspaceId),
    resolveProviderAccessToken: (workspaceId, now) =>
      authorization.resolveAccessToken(workspaceId, now),
  };
  return new WorkspaceClient("http://workspace.test", async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.slice(1);
    const operation = WORKSPACE_OPERATIONS.find((name) => name === path);
    if (
      !operation || operation === "readBrowserSession" || operation === "saveBrowserSession" ||
      operation === "deleteBrowserSessions"
    ) {
      throw new Error(`Unsupported test Workspace operation: ${path}`);
    }
    const args: unknown = await request.json();
    if (!Array.isArray(args)) throw new Error("Test Workspace arguments must be an array.");
    // SAFETY: only WorkspaceClient.call invokes this fixture, with the selected operation's typed args.
    const method = operations[operation] as (
      ...args: unknown[]
    ) => ReturnType<(typeof operations)[keyof typeof operations]>;
    try {
      const value = await method(...args);
      return Response.json(value ?? null);
    } catch {
      return new Response("Workspace operation failed", { status: 500 });
    }
  });
}

/** Preserve legacy fixture signatures while controllers consume the Workspace client. */
export function createAppServices(
  store: Store,
  connections?: RunnerRegistryService,
  authorization?: OpenAICodexAuthorizationService,
) {
  return createWorkspaceAppServices(
    createTestWorkspaceClient(store, authorization),
    connections,
    store.sessionStorage,
  );
}

export const testDatabaseUrl = Deno.env.get("OPENORB_TEST_DATABASE_URL") ??
  "postgres://localhost/openorb-test";

/** Deterministic 32-byte test master key: bytes 0x00 through 0x1f. */
export const TEST_MASTER_KEY_BYTES = Uint8Array.from(
  Array.from({ length: 32 }, (_, index) => index),
);
export const TEST_MASTER_KEY_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

export async function createTestStore(
  masterKey?: MasterKey,
  reset = true,
): Promise<PostgresStore> {
  const key = masterKey ?? (await importMasterKey(TEST_MASTER_KEY_BYTES));
  const store = createPostgresStore(testDatabaseUrl, key);
  await migrate(store.pool);
  if (reset) {
    await store.pool.query(
      "truncate table deleted_sessions, sessions, runners, runner_enrollment_tokens, projects, model_provider_credentials, git_credentials, git_author_configuration, browser_sessions, password_credentials, users, encrypted_secrets, workspaces restart identity",
    );
  }
  return store;
}

export async function createTestWorkspace(store: PostgresStore): Promise<WorkspaceId> {
  const id = WorkspaceId.make(v7.generate());
  await store.pool.query("insert into workspaces (id, created_at) values ($1, $2)", [
    id,
    new Date().toISOString(),
  ]);
  return id;
}

/** Returns the user ID, never the workspace ID. */
export async function createTestUser(
  store: PostgresStore,
  workspaceId?: WorkspaceId,
): Promise<UserId> {
  const result = await store.pool.query<{ id: string }>(
    "insert into users (id, workspace_id, is_administrator, created_at) values ($1, $2, false, $3) returning id",
    [v7.generate(), workspaceId ?? await createTestWorkspace(store), new Date().toISOString()],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Test user was not created.");
  return UserId.make(row.id);
}

export async function getTestUserWorkspaceId(
  store: PostgresStore,
  userId: UserId,
): Promise<WorkspaceId> {
  const result = await store.pool.query<{ workspace_id: string }>(
    "select workspace_id from users where id = $1",
    [userId],
  );
  if (!result.rows[0]) throw new Error("Test user not found.");
  return WorkspaceId.make(result.rows[0].workspace_id);
}
