import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ProjectId,
  SessionEnvironmentSecret,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { createRpcClient } from "./rpc-client.ts";
import { WorkspaceSessionStorage } from "../../app/data/workspace-session-storage.ts";

// Run against the isolated celld-worker fixture, whose DO fetch() deliberately throws.
const url = Deno.env.get("OPENORB_TEST_WORKSPACE_URL");

Deno.test("HTTP test driver alone decodes Result/void undefined and omits optional arguments", async () => {
  const workspaceId = WorkspaceId.make(crypto.randomUUID());
  const replies = [
    Response.json([null, null]),
    Response.json([null, { cause: "private storage failure" }]),
    Response.json(null),
    Response.json(null),
    Response.json({ status: "saved" }),
    Response.json({ status: "saved" }),
    new Response("private failure", { status: 500 }),
  ];
  const requests: { operation: string; args: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assertEquals(request.method, "POST");
    requests.push({ operation: new URL(request.url).pathname, args: await request.json() });
    const response = replies.shift();
    assert(response, "unexpected retry or extra request");
    return response;
  };
  try {
    const workspace = createRpcClient("http://workspace.test/__workspace");
    assertEquals(await workspace.getModelProviderApiKey(workspaceId, "openai"), [null, undefined]);
    const [value, error] = await workspace.getModelProviderApiKey(workspaceId, "openai");
    assertEquals(value, undefined);
    assert(error instanceof Error);
    assertEquals(error.message, "Workspace persistence operation failed.");
    assertEquals(await workspace.cancelProviderLogin(workspaceId, "attempt"), undefined);
    assertEquals(await workspace.readBrowserSession("missing"), null);
    await workspace.saveSecret(workspaceId, "TOKEN", "value", undefined);
    await workspace.saveSecret(workspaceId, "TOKEN", "value");
    assertEquals(requests.slice(-2), [
      { operation: "/__workspace/saveSecret", args: [workspaceId, "TOKEN", "value"] },
      { operation: "/__workspace/saveSecret", args: [workspaceId, "TOKEN", "value"] },
    ]);
    await assertRejects(() => workspace.hasAdministrator(), Error, "Workspace operation failed");
    assertEquals(requests.length, 7, "mutations and failed operations must never be retried");
    assertEquals(replies.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test({
  name:
    "native celld RPC preserves configuration, wire records, browser sessions, and OAuth alarms",
  ignore: !url,
  async fn() {
    assert(url);
    const health = await fetch(new URL("/healthz", url));
    assertEquals(health.status, 200);
    assertEquals(await health.json(), { status: "ok" });
    const workspace = createRpcClient(url);
    await workspace.createAdministrator("rpc-fixture-password");
    const identity = await workspace.verifyAdministratorPassword("rpc-fixture-password");
    assert(identity, "use a fresh disposable celld test fixture");
    const workspaceId = identity.workspaceId;
    const saved = await workspace.saveProject(workspaceId, {
      name: `RPC ${crypto.randomUUID()}`,
      repositoryUrl: "https://github.com/example/rpc.git",
    });
    assert(saved.status === "saved");
    const project = saved.project;
    assertEquals(await workspace.getProject(workspaceId, project.id), project);
    const secret = await workspace.saveSecret(workspaceId, "RPC_TOKEN", "fixture-secret", [
      "api.example.com",
    ]);
    assertEquals(secret.status, "saved");
    const [secrets, error] = await workspace.getEnvironmentSecrets(workspaceId);
    assertEquals(error, undefined);
    assert(secrets);
    assertEquals(Object.getPrototypeOf(secrets[0]), Object.prototype);
    assertEquals(secrets[0] instanceof SessionEnvironmentSecret, false);
    assertEquals(
      secrets[0],
      {
        name: "RPC_TOKEN",
        value: "fixture-secret",
        allowedHosts: ["api.example.com"],
      },
    );
    const enrollment = await workspace.getRunnerEnrollmentToken(workspaceId);
    assertEquals(new Date(enrollment.createdAt).toISOString(), enrollment.createdAt);
    const enrolled = await workspace.enrollRunner({
      enrollmentPsk: enrollment.token,
      name: "Native RPC runner",
      architecture: "arm64",
    });
    assert(enrolled);
    const runners = await workspace.listRunners(workspaceId);
    const runner = runners.find((r) => r.id === enrolled.runnerId);
    assert(runner);
    assertEquals(new Date(runner.createdAt).toISOString(), runner.createdAt);
    assertEquals(runner.architecture, "arm64");
    assertEquals(runner.revokedAt, null);
    assertEquals(await workspace.revokeRunner(workspaceId, runner.id), "revoked");
    const revokedAt = (await workspace.listRunners(workspaceId))
      .find((r) => r.id === runner.id)?.revokedAt;
    assert(revokedAt !== null && revokedAt !== undefined);
    assertEquals(new Date(revokedAt).toISOString(), revokedAt);
    assertEquals(await workspace.authenticateRunner(enrolled.runnerToken), null);
    const entry = {
      id: SessionId.make(crypto.randomUUID()),
      projectId: ProjectId.make(project.id),
      createdAt: new Date().toISOString(),
      initialPromptPreview: "RPC catalog record",
    };
    assertEquals(await workspace.reconcileSessionManifestEntries(workspaceId, [entry]), [{
      acceptedSessionIds: [entry.id],
      tombstonedSessionIds: [],
      rejected: [],
    }, undefined]);
    const storage = new WorkspaceSessionStorage(workspace);
    const anonymous = await storage.read(null);
    anonymous.set("csrf", "fixture-csrf");
    assertEquals(await storage.save(anonymous), anonymous.id);
    const authenticated = await storage.read(anonymous.id);
    authenticated.regenerateId(true);
    authenticated.set("auth", identity);
    assertEquals(await storage.save(authenticated), authenticated.id);
    assertEquals(await workspace.readBrowserSession(anonymous.id), null);
    const stale = await storage.read(authenticated.id);
    const logout = await storage.read(authenticated.id);
    logout.destroy();
    assertEquals(await storage.save(logout), "");
    stale.set("csrf", "stale-save");
    assertEquals(await storage.save(stale), "");
    assertEquals(await workspace.readBrowserSession(authenticated.id), null);
    await assertRejects(() => workspace.readBrowserSession("invalid/id"));
    const authorization = await workspace.startProviderLogin(workspaceId);
    const deadline = Date.now() + 30_000;
    while (true) {
      const status = await workspace.getProviderLoginStatus(workspaceId, authorization.id);
      if (status.status === "complete") break;
      assertEquals(status.status, "pending");
      assert(Date.now() < deadline, "native OAuth alarm did not complete");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert((await workspace.resolveProviderAccessToken(workspaceId))?.startsWith("e30."));
    assertEquals(await workspace.disconnectProvider(workspaceId), { status: "deleted" });
    assertEquals(
      await workspace.deleteSessionCatalogEntry(
        workspaceId,
        entry.id,
        new Date().toISOString(),
      ),
      ["deleted", undefined],
    );
    assertEquals(await workspace.deleteProject(workspaceId, project.id), [
      "deleted",
      undefined,
    ]);
  },
});
