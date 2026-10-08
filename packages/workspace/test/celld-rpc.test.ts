import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ProjectId,
  RunnerSessionSnapshot,
  SessionEnvironmentSecret,
  SessionId,
} from "@openorb/protocol/runner-api";
import { WorkspaceClient } from "../src/client.ts";
import { WorkspaceSessionStorage } from "../../gateway/app/data/workspace-session-storage.ts";

// Run against the isolated celld-worker fixture, whose DO fetch() deliberately throws.
const url = Deno.env.get("OPENORB_TEST_WORKSPACE_URL");

Deno.test({
  name:
    "native celld RPC preserves configuration, wire records, browser sessions, and OAuth alarms",
  ignore: !url,
  async fn() {
    assert(url);
    const health = await fetch(new URL("/healthz", url));
    assertEquals(health.status, 200);
    assertEquals(await health.json(), { status: "ok" });
    const client = new WorkspaceClient(url);
    await client.call("createAdministrator", "rpc-fixture-password");
    const identity = await client.call("verifyAdministratorPassword", "rpc-fixture-password");
    assert(identity, "use a fresh disposable celld test fixture");
    const workspaceId = identity.workspaceId;
    const saved = await client.call("saveProject", workspaceId, {
      name: `RPC ${crypto.randomUUID()}`,
      repositoryUrl: "https://github.com/example/rpc.git",
    });
    assert(saved.status === "saved");
    const project = saved.project;
    assertEquals(await client.call("getProject", workspaceId, project.id), project);
    const secret = await client.call("saveSecret", workspaceId, "RPC_TOKEN", "fixture-secret", [
      "api.example.com",
    ]);
    assertEquals(secret.status, "saved");
    const [secrets, error] = await client.call("getEnvironmentSecrets", workspaceId);
    assertEquals(error, undefined);
    assert(secrets);
    assert(secrets[0] instanceof SessionEnvironmentSecret);
    assertEquals(
      secrets[0],
      new SessionEnvironmentSecret({
        name: "RPC_TOKEN",
        value: "fixture-secret",
        allowedHosts: ["api.example.com"],
      }),
    );
    const enrollment = await client.call("getRunnerEnrollmentToken", workspaceId);
    assert(enrollment.createdAt instanceof Temporal.Instant);
    const enrolled = await client.call("enrollRunner", {
      enrollmentPsk: enrollment.token,
      name: "Native RPC runner",
      architecture: "arm64",
    });
    assert(enrolled);
    const runners = await client.call("listRunners", workspaceId);
    const runner = runners.find((r) => r.id === enrolled.runnerId);
    assert(runner?.createdAt instanceof Temporal.Instant);
    assertEquals(runner.architecture, "arm64");
    assertEquals(await client.call("revokeRunner", workspaceId, runner.id), "revoked");
    assertEquals(await client.call("authenticateRunner", enrolled.runnerToken), null);
    const entry = new RunnerSessionSnapshot({
      id: SessionId.make(crypto.randomUUID()),
      projectId: ProjectId.make(project.id),
      createdAt: new Date().toISOString(),
      initialPromptPreview: "RPC class input",
      model: "openai/gpt-4.1",
      initialThinkingLevel: "medium",
      orbSize: "small",
      state: "stopped",
      agentState: "idle",
      environmentState: "stopped",
      issues: [],
    });
    assertEquals(await client.call("reconcileSessionManifestEntries", workspaceId, [entry]), [{
      acceptedSessionIds: [entry.id],
      tombstonedSessionIds: [],
      rejected: [],
    }, undefined]);
    const storage = new WorkspaceSessionStorage(client);
    const anonymous = await storage.read(null);
    anonymous.set("csrf", "fixture-csrf");
    assertEquals(await storage.save(anonymous), anonymous.id);
    const authenticated = await storage.read(anonymous.id);
    authenticated.regenerateId(true);
    authenticated.set("auth", identity);
    assertEquals(await storage.save(authenticated), authenticated.id);
    assertEquals(await client.call("readBrowserSession", anonymous.id), null);
    const stale = await storage.read(authenticated.id);
    const logout = await storage.read(authenticated.id);
    logout.destroy();
    assertEquals(await storage.save(logout), "");
    stale.set("csrf", "stale-save");
    assertEquals(await storage.save(stale), "");
    assertEquals(await client.call("readBrowserSession", authenticated.id), null);
    await assertRejects(() => client.call("readBrowserSession", "invalid/id"));
    const authorization = await client.call("startProviderLogin", workspaceId);
    const deadline = Date.now() + 30_000;
    while (true) {
      const status = await client.call("getProviderLoginStatus", workspaceId, authorization.id);
      if (status.status === "complete") break;
      assertEquals(status.status, "pending");
      assert(Date.now() < deadline, "native OAuth alarm did not complete");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert((await client.call("resolveProviderAccessToken", workspaceId))?.startsWith("e30."));
    assertEquals(await client.call("disconnectProvider", workspaceId), { status: "deleted" });
    assertEquals(
      await client.call(
        "deleteSessionCatalogEntry",
        workspaceId,
        entry.id,
        new Date().toISOString(),
      ),
      ["deleted", undefined],
    );
    assertEquals(await client.call("deleteProject", workspaceId, project.id), [
      "deleted",
      undefined,
    ]);
  },
});
