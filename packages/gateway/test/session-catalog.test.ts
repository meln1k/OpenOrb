import { assert, assertEquals } from "@std/assert";
import { createWorkspace } from "@/test/workspace-test.ts";

Deno.test("session navigation joins project names in catalog order and isolates Workspace objects", async () => {
  const { workspace, workspaceId } = await createWorkspace();
  const foreign = await createWorkspace();
  const alpha = await workspace.saveProject(workspaceId, {
    name: "Alpha project",
    repositoryUrl: "https://github.com/openorb-dev/alpha.git",
  });
  const beta = await workspace.saveProject(workspaceId, {
    name: "Beta project",
    repositoryUrl: "https://github.com/openorb-dev/beta.git",
  });
  const foreignProject = await foreign.workspace.saveProject(foreign.workspaceId, {
    name: "Foreign project",
    repositoryUrl: "https://github.com/openorb-dev/foreign.git",
  });
  assert(alpha.status === "saved" && beta.status === "saved" && foreignProject.status === "saved");
  const alphaSession = {
    id: crypto.randomUUID(),
    projectId: alpha.project.id,
    createdAt: "2026-09-20T10:00:00.000Z",
    initialPromptPreview: "Older Alpha session",
  };
  const betaSession = {
    id: crypto.randomUUID(),
    projectId: beta.project.id,
    createdAt: "2026-09-20T12:00:00.000Z",
    initialPromptPreview: "Newer Beta session",
  };
  const foreignSession = {
    id: crypto.randomUUID(),
    projectId: foreignProject.project.id,
    createdAt: "2026-09-20T14:00:00.000Z",
    initialPromptPreview: "Foreign session",
  };
  assertEquals(
    await workspace.reconcileSessionManifestEntries(workspaceId, [alphaSession, betaSession]),
    [{
      acceptedSessionIds: [alphaSession.id, betaSession.id],
      tombstonedSessionIds: [],
      rejected: [],
    }, undefined],
  );
  assertEquals(
    await foreign.workspace.reconcileSessionManifestEntries(foreign.workspaceId, [foreignSession]),
    [
      { acceptedSessionIds: [foreignSession.id], tombstonedSessionIds: [], rejected: [] },
      undefined,
    ],
  );
  assertEquals(await workspace.listSessionNavigationEntries(workspaceId), [
    {
      id: betaSession.id,
      projectId: beta.project.id,
      projectName: beta.project.name,
      initialPromptPreview: betaSession.initialPromptPreview,
    },
    {
      id: alphaSession.id,
      projectId: alpha.project.id,
      projectName: alpha.project.name,
      initialPromptPreview: alphaSession.initialPromptPreview,
    },
  ]);
  assertEquals(await workspace.listSessionNavigationEntries(foreign.workspaceId), []);
  assertEquals(
    await foreign.workspace.getSessionCatalogEntry(foreign.workspaceId, alphaSession.id),
    null,
  );
});
