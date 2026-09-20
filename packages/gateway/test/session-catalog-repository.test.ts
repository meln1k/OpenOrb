import { assert, assertEquals } from "@std/assert";

import { createTestStore, createTestWorkspace } from "@/test/postgres-test.ts";

Deno.test("session navigation entries join project names in catalog order and isolate Workspaces", async () => {
  const store = await createTestStore();

  try {
    const workspaceId = await createTestWorkspace(store);
    const foreignWorkspaceId = await createTestWorkspace(store);
    const alpha = await store.saveProject(workspaceId, {
      name: "Alpha project",
      repositoryUrl: "https://github.com/openorb-dev/alpha.git",
    });
    const beta = await store.saveProject(workspaceId, {
      name: "Beta project",
      repositoryUrl: "https://github.com/openorb-dev/beta.git",
    });
    const foreign = await store.saveProject(foreignWorkspaceId, {
      name: "Foreign project",
      repositoryUrl: "https://github.com/openorb-dev/foreign.git",
    });
    assert(alpha.status === "saved" && beta.status === "saved" && foreign.status === "saved");

    const alphaSessionId = crypto.randomUUID();
    const betaSessionId = crypto.randomUUID();
    const foreignSessionId = crypto.randomUUID();
    await store.pool.query(
      `insert into sessions (workspace_id, id, project_id, created_at, initial_prompt_preview)
       values ($1, $2, $3, $4, $5),
              ($1, $6, $7, $8, $9),
              ($10, $11, $12, $13, $14)`,
      [
        workspaceId,
        alphaSessionId,
        alpha.project.id,
        "2026-09-20T10:00:00.000Z",
        "Older Alpha session",
        betaSessionId,
        beta.project.id,
        "2026-09-20T12:00:00.000Z",
        "Newer Beta session",
        foreignWorkspaceId,
        foreignSessionId,
        foreign.project.id,
        "2026-09-20T14:00:00.000Z",
        "Foreign session",
      ],
    );

    assertEquals(await store.listSessionNavigationEntries(workspaceId), [
      {
        id: betaSessionId,
        projectId: beta.project.id,
        projectName: "Beta project",
        initialPromptPreview: "Newer Beta session",
      },
      {
        id: alphaSessionId,
        projectId: alpha.project.id,
        projectName: "Alpha project",
        initialPromptPreview: "Older Alpha session",
      },
    ]);
  } finally {
    await store.close();
  }
});
