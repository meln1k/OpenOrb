import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";

import { selectRunnerForUser } from "@/app/runner-selection.ts";
import { createTestStore, createTestUser } from "@/test/postgres-test.ts";

Deno.test("configuration persistence separates users across every repository operation", async () => {
  const store = await createTestStore();

  try {
    const firstUserId = await createTestUser(store);
    const secondUserId = await createTestUser(store);

    await store.saveSecret(firstUserId, "SERVICE_TOKEN", "first-service-token");
    await store.saveSecret(secondUserId, "SERVICE_TOKEN", "second-service-token");
    assertEquals((await store.listSecrets(firstUserId)).map((secret) => secret.key), [
      "SERVICE_TOKEN",
    ]);
    assertEquals((await store.listSecrets(secondUserId)).map((secret) => secret.key), [
      "SERVICE_TOKEN",
    ]);
    assertEquals(await store.deleteSecret(firstUserId, "SERVICE_TOKEN"), true);
    assertEquals(await store.getSecret(firstUserId, "SERVICE_TOKEN"), null);
    assert(await store.getSecret(secondUserId, "SERVICE_TOKEN"));

    await store.saveModelProviderCredential(firstUserId, "opencode-go", "first-provider-token");
    await store.saveModelProviderCredential(secondUserId, "opencode-go", "second-provider-token");
    assertEquals(
      (await store.listModelProviderCredentials(firstUserId)).map((credential) =>
        credential.providerId
      ),
      ["opencode-go"],
    );
    assertEquals(
      (await store.listModelProviderCredentials(secondUserId)).map((credential) =>
        credential.providerId
      ),
      ["opencode-go"],
    );
    assertEquals(await store.deleteModelProviderCredential(firstUserId, "opencode-go"), {
      status: "deleted",
    });
    assertEquals(await store.getModelProviderCredential(firstUserId, "opencode-go"), null);
    assertEquals(await store.getModelProviderApiKey(secondUserId, "opencode-go"), [
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

    const firstCredential = await store.saveGitHubCredential(firstUserId, "first-github-token");
    const secondCredential = await store.saveGitHubCredential(secondUserId, "second-github-token");
    assertEquals((await store.getGitHubCredential(firstUserId))?.id, firstCredential.id);
    assertEquals((await store.getGitHubCredential(secondUserId))?.id, secondCredential.id);
    assertEquals(await store.deleteGitHubCredential(firstUserId), { status: "deleted" });
    assertEquals(await store.getGitHubCredential(firstUserId), null);
    assertEquals((await store.getGitHubCredential(secondUserId))?.id, secondCredential.id);

    const firstProjectResult = await store.saveProject(firstUserId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/example/first.git",
    });
    const secondProjectResult = await store.saveProject(secondUserId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/example/second.git",
    });
    assertEquals(firstProjectResult.status, "saved");
    assertEquals(secondProjectResult.status, "saved");
    if (firstProjectResult.status !== "saved" || secondProjectResult.status !== "saved") {
      throw new Error("Expected both tenant projects to be saved.");
    }

    assertEquals(await store.getProject(secondUserId, firstProjectResult.project.id), null);
    assertEquals(
      await store.saveProject(secondUserId, {
        id: firstProjectResult.project.id,
        name: "Hijacked",
        repositoryUrl: "https://github.com/example/hijacked.git",
      }),
      { status: "not-found" },
    );
    assertEquals(
      await store.deleteProject(secondUserId, firstProjectResult.project.id),
      ["not-found", undefined],
    );
    assertEquals(
      (await store.getProject(firstUserId, firstProjectResult.project.id))?.name,
      "OpenOrb",
    );

    const firstEnrollmentToken = await store.getRunnerEnrollmentToken(firstUserId);
    const secondEnrollmentToken = await store.getRunnerEnrollmentToken(secondUserId);
    assertNotEquals(firstEnrollmentToken.id, secondEnrollmentToken.id);
    const regeneratedSecondEnrollmentToken = await store.regenerateRunnerEnrollmentToken(
      secondUserId,
    );
    assertNotEquals(regeneratedSecondEnrollmentToken.id, secondEnrollmentToken.id);
    assertEquals((await store.getRunnerEnrollmentToken(firstUserId)).id, firstEnrollmentToken.id);
    const firstRunner = await store.enrollRunner({
      enrollmentPsk: firstEnrollmentToken.token,
      name: "First runner",
      architecture: "x64",
      capabilities: ["session-rpc", "session-events"],
    });
    assert(firstRunner);
    assertEquals(await store.listRunners(secondUserId), []);
    assertEquals(
      await selectRunnerForUser(secondUserId, firstRunner.runnerId, "medium", store, {
        getRunnerLiveState() {
          throw new Error("Foreign-user runner must not reach live-state lookup.");
        },
      }),
      {
        status: "rejected",
        message: "Runner is unavailable or does not exist.",
      },
    );
    assertEquals(await store.revokeRunner(secondUserId, firstRunner.runnerId), "not-found");
    assertEquals(await store.deleteRunner(secondUserId, firstRunner.runnerId), "not-found");
    assertEquals(await store.deleteRunner(firstUserId, firstRunner.runnerId), "not-revoked");
    assertEquals(
      (await store.authenticateRunner(firstRunner.runnerToken))?.userId,
      firstUserId,
    );
    assertEquals(await store.revokeRunner(firstUserId, firstRunner.runnerId), "revoked");
    assertEquals(await store.deleteRunner(firstUserId, firstRunner.runnerId), "deleted");
    assertEquals(await store.listRunners(firstUserId), []);

    const secondSecret = await store.pool.query<{ id: string }>(
      `select encrypted_secret_id as id
         from git_credentials
        where user_id = $1`,
      [secondUserId],
    );
    await assertRejects(() =>
      store.pool.query(
        `update git_credentials
            set user_id = $1
          where id = $2`,
        [firstUserId, secondCredential.id],
      )
    );
    assertEquals(secondSecret.rows.length, 1);

    const ownership = await store.pool.query<{ table_name: string; user_id: string }>(
      `select 'encrypted_secrets' as table_name, user_id from encrypted_secrets
       union all
       select 'model_provider_credentials', user_id from model_provider_credentials
       union all
       select 'git_author_configuration', user_id from git_author_configuration
       union all
       select 'git_credentials', user_id from git_credentials
       union all
       select 'projects', user_id from projects
       union all
       select 'runner_enrollment_tokens', user_id from runner_enrollment_tokens
       union all
       select 'runners', user_id from runners`,
    );
    assert(
      ownership.rows.every((row: { user_id: string }) =>
        row.user_id === firstUserId || row.user_id === secondUserId
      ),
    );
  } finally {
    await store.close();
  }
});
