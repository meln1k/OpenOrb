import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { runnerEnrollmentResponseSchema } from "@openorb/protocol";
import { parse } from "remix/data-schema";

import { createAppServices } from "@/test/workspace-test.ts";
import { createAppRouter } from "@/test/workspace-test.ts";
import { routes } from "@/app/routes.ts";
import { activate, createWorkspace } from "@/test/workspace-test.ts";

Deno.test("always provides one PSK and serializes concurrent regeneration", async () => {
  const { workspace: store, workspaceId, storage } = await createWorkspace();

  const provisioned = await Promise.all(
    Array.from({ length: 8 }, () => store.getRunnerEnrollmentToken(workspaceId)),
  );
  assertEquals(new Set(provisioned.map((token) => token.id)).size, 1);
  assertEquals(new Set(provisioned.map((token) => token.token)).size, 1);

  const regenerated = await Promise.all(
    Array.from({ length: 8 }, () => store.regenerateRunnerEnrollmentToken(workspaceId)),
  );
  assertEquals(new Set(regenerated.map((token) => token.id)).size, 8);
  const current = await store.getRunnerEnrollmentToken(workspaceId);
  assert(regenerated.some((token) => token.id === current.id));
  assertNotEquals(current.id, provisioned[0]!.id);

  assertEquals(storage.rows("SELECT id FROM runner_enrollment_tokens"), [{ id: current.id }]);
  assertEquals(await activate(storage).workspace.getRunnerEnrollmentToken(workspaceId), current);
  await assertRejects(() =>
    store.enrollRunner({
      enrollmentPsk: "",
      name: "Empty token",
      architecture: "x64",
    })
  );
  for (const token of ["invalid-enrollment-token", provisioned[0]!.token]) {
    assertEquals(
      await store.enrollRunner({
        enrollmentPsk: token,
        name: "Invalid token",
        architecture: "x64",
      }),
      null,
    );
  }
});

Deno.test("enrollment derives Workspace ownership from the PSK, never malicious request ownership", async () => {
  const { workspace: store, workspaceId } = await createWorkspace();
  const router = createAppRouter(createAppServices(store));
  const { workspaceId: foreignWorkspaceId } = await createWorkspace();
  const enrollment = await store.getRunnerEnrollmentToken(workspaceId);
  const enroll = (enrollmentPsk: string, ownership: Record<string, string> = {}) =>
    router.fetch(
      new Request(
        new URL(routes.api.runners.enroll.href(), "http://gateway.test"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enrollmentPsk,
            name: "Token-owned runner",
            architecture: "x64",
            ...ownership,
          }),
        },
      ),
    );
  const malicious = await enroll(enrollment.token, { workspaceId: foreignWorkspaceId });
  assertEquals(malicious.status, 400);
  assertEquals(await malicious.json(), { error: "Invalid enrollment request." });
  assertEquals(await store.listRunners(workspaceId), []);
  assertEquals(await store.listRunners(foreignWorkspaceId), []);
  const runnerTokens = new Map<string, string>();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await enroll(enrollment.token);
    assertEquals(response.status, 201);
    assertEquals(response.headers.get("cache-control"), "no-store");
    const runner = parse(runnerEnrollmentResponseSchema, await response.json());
    runnerTokens.set(runner.runnerId, runner.runnerToken);
    assertEquals(await store.authenticateRunner(runner.runnerToken), {
      id: runner.runnerId,
      workspaceId,
    });
    assertEquals(await store.revokeRunner(foreignWorkspaceId, runner.runnerId), "not-found");
    assertEquals(await store.deleteRunner(foreignWorkspaceId, runner.runnerId), "not-found");
  }
  assertEquals((await store.listRunners(workspaceId)).length, 2);
  assertEquals(await store.listRunners(foreignWorkspaceId), []);
  assertEquals((await enroll("openorb_enroll_invalid")).status, 401);
  await store.regenerateRunnerEnrollmentToken(workspaceId);
  assertEquals((await enroll(enrollment.token)).status, 401);
  assertEquals((await store.listRunners(workspaceId)).length, 2);
  const runner = (await store.listRunners(workspaceId))[0]!;
  assertEquals(await store.revokeRunner(workspaceId, runner.id), "revoked");
  assertEquals(await store.authenticateRunner(runnerTokens.get(runner.id)!), null);
  assertEquals(await store.listRunners(foreignWorkspaceId), []);
});
