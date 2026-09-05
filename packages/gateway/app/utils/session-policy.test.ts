import { assert, assertEquals } from "@std/assert";
import { UserId, WorkspaceId } from "@openorb/protocol/runner-api";

import type { Store } from "@/app/data/store.ts";
import type { RunnerRegistryService } from "@/app/runner-registry.ts";
import type { SecretMetadata } from "@/app/utils/secret-cipher.ts";
import { parseBrowserSessionAuth } from "@/app/utils/session-policy.ts";

const USER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c12";
const WORKSPACE_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c13";

Deno.test("browser identity validates UUIDv7 fields and returns distinct ID brands", () => {
  const identity = parseBrowserSessionAuth({ userId: USER_ID, workspaceId: WORKSPACE_ID });
  assert(identity);
  assertEquals<UserId>(identity.userId, UserId.make(USER_ID));
  assertEquals<WorkspaceId>(identity.workspaceId, WorkspaceId.make(WORKSPACE_ID));
  assertEquals(
    JSON.stringify(identity),
    JSON.stringify({ userId: USER_ID, workspaceId: WORKSPACE_ID }),
  );

  for (
    const invalid of [
      null,
      { userId: USER_ID },
      { workspaceId: WORKSPACE_ID },
      { userId: "not-a-uuid", workspaceId: WORKSPACE_ID },
      { userId: USER_ID, workspaceId: "not-a-uuid" },
      { userId: "1770199d-f6b8-4bd8-851f-7bcffc1bb7f8", workspaceId: WORKSPACE_ID },
      { userId: USER_ID, workspaceId: "1770199d-f6b8-4bd8-851f-7bcffc1bb7f8" },
      { userId: USER_ID, workspaceId: WORKSPACE_ID, extra: true },
    ]
  ) {
    assertEquals(parseBrowserSessionAuth(invalid), null);
  }
});

Deno.test("gateway ownership signatures reject swapped IDs and unvalidated strings", () => {
  const identity = parseBrowserSessionAuth({ userId: USER_ID, workspaceId: WORKSPACE_ID });
  assert(identity);
  // These expressions are compile-time checks; no repository or runner operation executes.
  identity.workspaceId satisfies Parameters<Store["listProjects"]>[0];
  identity.userId satisfies Parameters<Store["getAdministrator"]>[0];
  identity.userId satisfies Parameters<Store["getGitAuthorConfiguration"]>[0];
  identity.workspaceId satisfies Parameters<RunnerRegistryService["getSessionRunner"]>[0];
  identity.workspaceId satisfies SecretMetadata["workspaceId"];

  // @ts-expect-error A user cannot be passed as a project's tenant.
  identity.userId satisfies Parameters<Store["listProjects"]>[0];
  // @ts-expect-error Authentication lookup requires a user, not a tenant.
  identity.workspaceId satisfies Parameters<Store["getAdministrator"]>[0];
  // @ts-expect-error Git author identity belongs to a user, not a tenant.
  identity.workspaceId satisfies Parameters<Store["getGitAuthorConfiguration"]>[0];
  // @ts-expect-error Runner routing must be Workspace-scoped.
  identity.userId satisfies Parameters<RunnerRegistryService["getSessionRunner"]>[0];
  // @ts-expect-error Encryption metadata must be Workspace-scoped.
  identity.userId satisfies SecretMetadata["workspaceId"];
  // @ts-expect-error Unvalidated strings cannot enter tenant repository operations.
  WORKSPACE_ID satisfies Parameters<Store["listProjects"]>[0];
  // @ts-expect-error Unvalidated strings cannot enter user repository operations.
  USER_ID satisfies Parameters<Store["getAdministrator"]>[0];
});
