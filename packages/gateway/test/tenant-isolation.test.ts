import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { UserId } from "@openorb/protocol/runner-api";

import { selectRunnerForWorkspace } from "@/app/runner-selection.ts";
import {
  createTestStore,
  createTestUser,
  createTestWorkspace,
  getTestUserWorkspaceId,
} from "@/test/postgres-test.ts";

Deno.test("configuration persistence separates Workspaces across every repository operation", async () => {
  const store = await createTestStore();

  try {
    const firstWorkspaceId = await createTestWorkspace(store);
    const secondWorkspaceId = await createTestWorkspace(store);
    const firstUserId = await createTestUser(store, firstWorkspaceId);
    const secondUserId = await createTestUser(store, secondWorkspaceId);

    await store.saveSecret(firstWorkspaceId, "SERVICE_TOKEN", "first-service-token");
    await store.saveSecret(secondWorkspaceId, "SERVICE_TOKEN", "second-service-token");
    assertEquals((await store.listSecrets(firstWorkspaceId)).map((secret) => secret.key), [
      "SERVICE_TOKEN",
    ]);
    assertEquals((await store.listSecrets(secondWorkspaceId)).map((secret) => secret.key), [
      "SERVICE_TOKEN",
    ]);
    assertEquals(await store.deleteSecret(firstWorkspaceId, "SERVICE_TOKEN"), true);
    assertEquals(await store.getSecret(firstWorkspaceId, "SERVICE_TOKEN"), null);
    assert(await store.getSecret(secondWorkspaceId, "SERVICE_TOKEN"));

    await store.saveModelProviderCredential(
      firstWorkspaceId,
      "opencode-go",
      "first-provider-token",
    );
    await store.saveModelProviderCredential(
      secondWorkspaceId,
      "opencode-go",
      "second-provider-token",
    );
    assertEquals(
      (await store.listModelProviderCredentials(firstWorkspaceId)).map((credential) =>
        credential.providerId
      ),
      ["opencode-go"],
    );
    assertEquals(
      (await store.listModelProviderCredentials(secondWorkspaceId)).map((credential) =>
        credential.providerId
      ),
      ["opencode-go"],
    );
    assertEquals(await store.deleteModelProviderCredential(firstWorkspaceId, "opencode-go"), {
      status: "deleted",
    });
    assertEquals(await store.getModelProviderCredential(firstWorkspaceId, "opencode-go"), null);
    assertEquals(await store.getModelProviderApiKey(secondWorkspaceId, "opencode-go"), [
      "second-provider-token",
      undefined,
    ]);

    await store.saveGitAuthorConfiguration(firstUserId, {
      authorName: "First User",
      authorEmail: "first@example.com",
    });
    await store.saveGitAuthorConfiguration(secondUserId, {
      authorName: "Second User",
      authorEmail: "second@example.com",
    });
    assertEquals(
      (await store.getGitAuthorConfiguration(firstUserId))?.authorEmail,
      "first@example.com",
    );
    assertEquals(
      (await store.getGitAuthorConfiguration(secondUserId))?.authorEmail,
      "second@example.com",
    );

    const firstCredential = await store.saveGitHubCredential(
      firstWorkspaceId,
      "first-github-token",
    );
    const secondCredential = await store.saveGitHubCredential(
      secondWorkspaceId,
      "second-github-token",
    );
    assertEquals((await store.getGitHubCredential(firstWorkspaceId))?.id, firstCredential.id);
    assertEquals((await store.getGitHubCredential(secondWorkspaceId))?.id, secondCredential.id);
    assertEquals(await store.deleteGitHubCredential(firstWorkspaceId), { status: "deleted" });
    assertEquals(await store.getGitHubCredential(firstWorkspaceId), null);
    assertEquals((await store.getGitHubCredential(secondWorkspaceId))?.id, secondCredential.id);

    const firstProjectResult = await store.saveProject(firstWorkspaceId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/example/first.git",
    });
    const secondProjectResult = await store.saveProject(secondWorkspaceId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/example/second.git",
    });
    assertEquals(firstProjectResult.status, "saved");
    assertEquals(secondProjectResult.status, "saved");
    if (firstProjectResult.status !== "saved" || secondProjectResult.status !== "saved") {
      throw new Error("Expected both tenant projects to be saved.");
    }

    assertEquals(await store.getProject(secondWorkspaceId, firstProjectResult.project.id), null);
    assertEquals(
      await store.saveProject(secondWorkspaceId, {
        id: firstProjectResult.project.id,
        name: "Hijacked",
        repositoryUrl: "https://github.com/example/hijacked.git",
      }),
      { status: "not-found" },
    );
    assertEquals(
      await store.deleteProject(secondWorkspaceId, firstProjectResult.project.id),
      ["not-found", undefined],
    );
    assertEquals(
      (await store.getProject(firstWorkspaceId, firstProjectResult.project.id))?.name,
      "OpenOrb",
    );

    const firstEnrollmentToken = await store.getRunnerEnrollmentToken(firstWorkspaceId);
    const secondEnrollmentToken = await store.getRunnerEnrollmentToken(secondWorkspaceId);
    assertNotEquals(firstEnrollmentToken.id, secondEnrollmentToken.id);
    const regeneratedSecondEnrollmentToken = await store.regenerateRunnerEnrollmentToken(
      secondWorkspaceId,
    );
    assertNotEquals(regeneratedSecondEnrollmentToken.id, secondEnrollmentToken.id);
    assertEquals(
      (await store.getRunnerEnrollmentToken(firstWorkspaceId)).id,
      firstEnrollmentToken.id,
    );
    const firstRunner = await store.enrollRunner({
      enrollmentPsk: firstEnrollmentToken.token,
      name: "First runner",
      architecture: "x64",
    });
    assert(firstRunner);
    assertEquals(await store.listRunners(secondWorkspaceId), []);
    assertEquals(
      await selectRunnerForWorkspace(secondWorkspaceId, firstRunner.runnerId, "medium", store, {
        getRunnerLiveState() {
          throw new Error("Foreign-Workspace runner must not reach live-state lookup.");
        },
      }),
      {
        status: "rejected",
        message: "Runner is unavailable or does not exist.",
      },
    );
    assertEquals(await store.revokeRunner(secondWorkspaceId, firstRunner.runnerId), "not-found");
    assertEquals(await store.deleteRunner(secondWorkspaceId, firstRunner.runnerId), "not-found");
    assertEquals(await store.deleteRunner(firstWorkspaceId, firstRunner.runnerId), "not-revoked");
    assertEquals(
      (await store.authenticateRunner(firstRunner.runnerToken))?.workspaceId,
      firstWorkspaceId,
    );
    assertEquals(await store.revokeRunner(firstWorkspaceId, firstRunner.runnerId), "revoked");
    assertEquals(await store.deleteRunner(firstWorkspaceId, firstRunner.runnerId), "deleted");
    assertEquals(await store.listRunners(firstWorkspaceId), []);

    const secondSecret = await store.pool.query<{ id: string }>(
      `select encrypted_secret_id as id
         from git_credentials
        where workspace_id = $1`,
      [secondWorkspaceId],
    );
    await assertRejects(() =>
      store.pool.query(
        `update git_credentials
            set workspace_id = $1
          where id = $2`,
        [firstWorkspaceId, secondCredential.id],
      )
    );
    assertEquals(secondSecret.rows.length, 1);

    const ownership = await store.pool.query<{ table_name: string; workspace_id: string }>(
      `select 'encrypted_secrets' as table_name, workspace_id from encrypted_secrets
       union all
       select 'model_provider_credentials', workspace_id from model_provider_credentials
       union all
       select 'git_author_configuration', users.workspace_id from git_author_configuration
       join users on users.id = git_author_configuration.user_id
       union all
       select 'git_credentials', workspace_id from git_credentials
       union all
       select 'projects', workspace_id from projects
       union all
       select 'runner_enrollment_tokens', workspace_id from runner_enrollment_tokens
       union all
       select 'runners', workspace_id from runners`,
    );
    assert(
      ownership.rows.every((row: { workspace_id: string }) =>
        row.workspace_id === firstWorkspaceId || row.workspace_id === secondWorkspaceId
      ),
    );
  } finally {
    await store.close();
  }
});

Deno.test("two users share Workspace resources but retain distinct Git authors after user deletion", async () => {
  const store = await createTestStore();
  try {
    const workspaceId = await createTestWorkspace(store);
    const firstUserId = await createTestUser(store, workspaceId);
    const secondUserId = await createTestUser(store, workspaceId);
    assertEquals(new Set([workspaceId, firstUserId, secondUserId]).size, 3);
    const firstWorkspaceId = await getTestUserWorkspaceId(store, firstUserId);
    const secondWorkspaceId = await getTestUserWorkspaceId(store, secondUserId);
    assertEquals(firstWorkspaceId, workspaceId);
    assertEquals(secondWorkspaceId, workspaceId);

    const project = await store.saveProject(firstWorkspaceId, {
      name: "Shared project",
      repositoryUrl: "https://github.com/example/shared.git",
    });
    assert(project.status === "saved");
    assertEquals(await store.getProject(secondWorkspaceId, project.project.id), project.project);
    const updated = await store.saveProject(secondWorkspaceId, {
      id: project.project.id,
      name: "Updated by second user",
      repositoryUrl: project.project.repositoryUrl,
    });
    assert(updated.status === "saved");
    assertEquals(await store.listProjects(firstWorkspaceId), [updated.project]);

    const credential = await store.saveGitHubCredential(firstWorkspaceId, "shared-github-token");
    assertEquals((await store.getGitHubCredential(secondWorkspaceId))?.id, credential.id);
    const replaced = await store.saveGitHubCredential(secondWorkspaceId, "replaced-github-token");
    assertEquals(replaced.id, credential.id);
    assertEquals(await store.getGitHubCredential(firstWorkspaceId), replaced);
    assertEquals(await store.getGitHubToken(firstWorkspaceId), [
      "replaced-github-token",
      undefined,
    ]);
    await store.saveModelProviderCredential(
      firstWorkspaceId,
      "opencode-go",
      "shared-provider-token",
    );
    assertEquals(await store.getModelProviderApiKey(secondWorkspaceId, "opencode-go"), [
      "shared-provider-token",
      undefined,
    ]);
    await store.saveModelProviderCredential(
      secondWorkspaceId,
      "opencode-go",
      "replaced-provider-token",
    );
    assertEquals(await store.getModelProviderApiKey(firstWorkspaceId, "opencode-go"), [
      "replaced-provider-token",
      undefined,
    ]);
    await store.saveSecret(firstWorkspaceId, "SHARED_SECRET", "shared-secret-value");
    assertEquals(
      await store.listSecrets(secondWorkspaceId),
      await store.listSecrets(firstWorkspaceId),
    );

    const firstAuthor = { authorName: "First User", authorEmail: "first@example.com" };
    const secondAuthor = { authorName: "Second User", authorEmail: "second@example.com" };
    await store.saveGitAuthorConfiguration(firstUserId, firstAuthor);
    await store.saveGitAuthorConfiguration(secondUserId, secondAuthor);
    assertEquals(
      (await store.getGitAuthorConfiguration(firstUserId))?.authorEmail,
      firstAuthor.authorEmail,
    );
    assertEquals(
      (await store.getGitAuthorConfiguration(secondUserId))?.authorEmail,
      secondAuthor.authorEmail,
    );
    // An unknown User with the Workspace's UUID bytes must not inherit either User's author.
    const unknownUserId = UserId.make(workspaceId);
    assertEquals(await store.getGitAuthorConfiguration(unknownUserId), null);

    const enrollment = await store.getRunnerEnrollmentToken(firstWorkspaceId);
    assertEquals(await store.getRunnerEnrollmentToken(secondWorkspaceId), enrollment);
    const runner = await store.enrollRunner({
      enrollmentPsk: enrollment.token,
      name: "Shared runner",
      architecture: "x64",
    });
    assert(runner);
    assertEquals((await store.listRunners(secondWorkspaceId)).map((row) => row.id), [
      runner.runnerId,
    ]);

    const deleted = await store.pool.query("delete from users where id = $1 returning id", [
      firstUserId,
    ]);
    assertEquals(deleted.rows, [{ id: firstUserId }]);
    assertEquals(await store.getGitAuthorConfiguration(firstUserId), null);
    assertEquals(
      (await store.getGitAuthorConfiguration(secondUserId))?.authorEmail,
      secondAuthor.authorEmail,
    );
    assertEquals(await getTestUserWorkspaceId(store, secondUserId), workspaceId);
    assertEquals(await store.getProject(secondWorkspaceId, project.project.id), updated.project);
    assertEquals(await store.getGitHubCredential(secondWorkspaceId), replaced);
    assertEquals(await store.getGitHubToken(secondWorkspaceId), [
      "replaced-github-token",
      undefined,
    ]);
    assertEquals(await store.getModelProviderApiKey(secondWorkspaceId, "opencode-go"), [
      "replaced-provider-token",
      undefined,
    ]);
    assert(await store.getSecret(secondWorkspaceId, "SHARED_SECRET"));
    assertEquals(await store.getRunnerEnrollmentToken(secondWorkspaceId), enrollment);
    assertEquals(await store.authenticateRunner(runner.runnerToken), {
      id: runner.runnerId,
      workspaceId,
    });

    assertEquals(await store.deleteProject(secondWorkspaceId, project.project.id), [
      "deleted",
      undefined,
    ]);
    assertEquals(await store.getProject(firstWorkspaceId, project.project.id), null);
    assertEquals(await store.deleteGitHubCredential(secondWorkspaceId), { status: "deleted" });
    assertEquals(await store.getGitHubCredential(firstWorkspaceId), null);
  } finally {
    await store.close();
  }
});
