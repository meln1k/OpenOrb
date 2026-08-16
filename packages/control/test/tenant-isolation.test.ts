import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";

import { createTestStore, createTestUser } from "@/test/postgres-test.ts";

Deno.test("configuration persistence separates users across every repository operation", async () => {
  const store = await createTestStore();

  try {
    const firstUserId = await createTestUser(store);
    const secondUserId = await createTestUser(store);

    await store.saveSecret(firstUserId, "OPENCODE_API_KEY", "first-provider-token");
    await store.saveSecret(secondUserId, "OPENCODE_API_KEY", "second-provider-token");
    assertEquals((await store.listSecrets(firstUserId)).map((secret) => secret.key), [
      "OPENCODE_API_KEY",
    ]);
    assertEquals((await store.listSecrets(secondUserId)).map((secret) => secret.key), [
      "OPENCODE_API_KEY",
    ]);
    assertEquals(await store.deleteSecret(firstUserId, "OPENCODE_API_KEY"), true);
    assertEquals(await store.getSecret(firstUserId, "OPENCODE_API_KEY"), null);
    assert(await store.getSecret(secondUserId, "OPENCODE_API_KEY"));

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
      "not-found",
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
      capabilities: ["heartbeat"],
    });
    assert(firstRunner);
    assertEquals(await store.listRunners(secondUserId), []);
    assertEquals(await store.revokeRunner(secondUserId, firstRunner.runnerId), "not-found");
    assertEquals(
      (await store.authenticateRunner(firstRunner.runnerToken))?.userId,
      firstUserId,
    );

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
