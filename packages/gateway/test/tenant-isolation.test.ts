import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { UserId } from "@openorb/protocol/runner-api";
import { selectRunnerForWorkspace } from "@/app/cells/runners/runner-selection.ts";
import { activate, createWorkspace } from "@/test/workspace-test.ts";

Deno.test("separate Workspace objects isolate configuration, identity, runners, and catalog", async () => {
  const first = await createWorkspace();
  const second = await createWorkspace();
  assertNotEquals(first.workspaceId, second.workspaceId);
  assertNotEquals(first.administrator.userId, second.administrator.userId);
  for (const [owner, other] of [[first, second], [second, first]] as const) {
    const { workspace, workspaceId, administrator } = owner;
    const foreignId = other.workspaceId;
    const author = { authorName: "Workspace author", authorEmail: "author@example.com" };
    await workspace.saveGitAuthorConfiguration(administrator.userId, author);
    assertEquals(await workspace.getGitAuthorConfiguration(other.administrator.userId), null);
    assertEquals(await workspace.getGitAuthorConfiguration(UserId.make(workspaceId)), null);
    await assertRejects(() =>
      workspace.saveGitAuthorConfiguration(other.administrator.userId, author)
    );
    assertEquals(await workspace.getAdministrator(other.administrator.userId), null);

    await workspace.saveSecret(workspaceId, "SERVICE_TOKEN", `secret-${workspaceId}`);
    await workspace.saveModelProviderCredential(workspaceId, "openai", `provider-${workspaceId}`);
    await workspace.saveGitHubCredential(workspaceId, `github-${workspaceId}`);
    assertEquals(await workspace.listSecrets(foreignId), []);
    assertEquals(await workspace.getSecret(foreignId, "SERVICE_TOKEN"), null);
    assertEquals(await workspace.getEnvironmentSecrets(foreignId), [[], undefined]);
    assertEquals(await workspace.deleteSecret(foreignId, "SERVICE_TOKEN"), false);
    assertEquals(await workspace.listModelProviderCredentials(foreignId), []);
    assertEquals(await workspace.getModelProviderCredential(foreignId, "openai"), null);
    assertEquals(await workspace.getModelProviderApiKey(foreignId, "openai"), [null, undefined]);
    assertEquals(await workspace.deleteModelProviderCredential(foreignId, "openai"), {
      status: "not-found",
    });
    assertEquals(await workspace.getGitHubCredential(foreignId), null);
    assertEquals(await workspace.getGitHubToken(foreignId), [null, undefined]);
    assertEquals(await workspace.deleteGitHubCredential(foreignId), { status: "not-found" });
    await assertRejects(() => workspace.saveSecret(foreignId, "HIJACK", "value"));
    await assertRejects(() => workspace.saveModelProviderCredential(foreignId, "openai", "hijack"));
    await assertRejects(() => workspace.saveGitHubCredential(foreignId, "hijack"));

    const project = await workspace.saveProject(workspaceId, {
      name: "Same tenant-relative name",
      repositoryUrl: "https://github.com/example/project.git",
    });
    assert(project.status === "saved");
    assertEquals(await workspace.getProject(foreignId, project.project.id), null);
    assertEquals(await other.workspace.getProject(foreignId, project.project.id), null);
    assertEquals(
      await other.workspace.saveProject(foreignId, {
        id: project.project.id,
        name: "Hijacked",
        repositoryUrl: project.project.repositoryUrl,
      }),
      { status: "not-found" },
    );
    assertEquals(await workspace.deleteProject(foreignId, project.project.id), [
      "not-found",
      undefined,
    ]);
    const entry = {
      id: "00000000-0000-4000-8000-000000000001",
      projectId: project.project.id,
      createdAt: "2026-09-20T10:00:00Z",
      initialPromptPreview: "Same ID, separate objects",
    };
    assertEquals(await workspace.reconcileSessionManifestEntries(workspaceId, [entry]), [{
      acceptedSessionIds: [entry.id],
      tombstonedSessionIds: [],
      rejected: [],
    }, undefined]);
    assertEquals(await workspace.getSessionCatalogEntry(foreignId, entry.id), null);
    assertEquals(await workspace.listSessionNavigationEntries(foreignId), []);
    assertEquals(await workspace.deleteSessionCatalogEntry(foreignId, entry.id, entry.createdAt), [
      "not-found",
      undefined,
    ]);

    const enrollment = await workspace.getRunnerEnrollmentToken(workspaceId);
    const runner = await workspace.enrollRunner({
      enrollmentPsk: enrollment.token,
      name: "Tenant runner",
      architecture: "x64",
    });
    assert(runner);
    assertEquals(
      await other.workspace.enrollRunner({
        enrollmentPsk: enrollment.token,
        name: "Foreign PSK",
        architecture: "x64",
      }),
      null,
    );
    assertEquals(await other.workspace.authenticateRunner(runner.runnerToken), null);
    assertEquals(await workspace.listRunners(foreignId), []);
    assertEquals(
      await selectRunnerForWorkspace(foreignId, runner.runnerId, "medium", workspace, {
        getRunnerLiveState() {
          throw new Error("Foreign runner reached live-state lookup");
        },
      }),
      { status: "rejected", message: "Runner is unavailable or does not exist." },
    );
    assertEquals(await workspace.revokeRunner(foreignId, runner.runnerId), "not-found");
    assertEquals(await workspace.deleteRunner(foreignId, runner.runnerId), "not-found");
    assertEquals(await workspace.deleteRunner(workspaceId, runner.runnerId), "not-revoked");
    assertEquals(await workspace.revokeRunner(workspaceId, runner.runnerId), "revoked");
    assertEquals(await workspace.authenticateRunner(runner.runnerToken), null);
    assertEquals(await workspace.deleteRunner(workspaceId, runner.runnerId), "deleted");

    const restarted = activate(owner.storage).workspace;
    assertEquals(await restarted.getModelProviderApiKey(workspaceId, "openai"), [
      `provider-${workspaceId}`,
      undefined,
    ]);
    assertEquals(await restarted.getGitHubToken(workspaceId), [`github-${workspaceId}`, undefined]);
    assert(await restarted.getSecret(workspaceId, "SERVICE_TOKEN"));
    assertEquals(
      (await restarted.getGitAuthorConfiguration(administrator.userId))?.authorEmail,
      author.authorEmail,
    );
    assertEquals(await restarted.getSessionCatalogEntry(workspaceId, entry.id), entry);
  }
  assertEquals((await first.workspace.listProjects(first.workspaceId)).length, 1);
  assertEquals((await second.workspace.listProjects(second.workspaceId)).length, 1);
  // Deletion markers are object/Workspace-scoped, including identical session IDs.
  const id = "00000000-0000-4000-8000-000000000001";
  assertEquals(
    await first.workspace.deleteSessionCatalogEntry(
      first.workspaceId,
      id,
      new Date().toISOString(),
    ),
    ["deleted", undefined],
  );
  assert(await second.workspace.getSessionCatalogEntry(second.workspaceId, id));
});
