import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const RUNNER_SOURCE_ROOT = "packages/runner/src";

Deno.test("runner source keeps Pi construction and tools behind the audited boundary", async () => {
  const sources = await typescriptSourcesUnder(RUNNER_SOURCE_ROOT);
  const defaultLoaderUsers: string[] = [];
  const agentSessionFactories: string[] = [];
  const hostProcessUsers: string[] = [];

  for (const path of sources) {
    const source = await Deno.readTextFile(path);
    if (source.includes("DefaultResourceLoader")) defaultLoaderUsers.push(path);
    if (source.includes("createAgentSession(") || source.includes("createAgentSession)")) {
      agentSessionFactories.push(path);
    }
    if (source.includes("node:child_process") || source.includes("new Deno.Command")) {
      hostProcessUsers.push(path);
    }
    assert(
      !/new\s+Deno\.Command\s*\(\s*["'](?:\/usr\/bin\/)?git["']/u.test(source),
      `${path} can launch native host Git`,
    );
  }

  assertEquals(defaultLoaderUsers, []);
  assertEquals(agentSessionFactories, ["packages/runner/src/harness/pi/session.ts"]);
  assertEquals(hostProcessUsers, ["packages/runner/src/runtime/prerequisites.ts"]);

  const factory = await Deno.readTextFile("packages/runner/src/harness/pi/session.ts");
  assertStringIncludes(factory, "SettingsManager.inMemory(");
  assertStringIncludes(factory, "const resourceLoader: ResourceLoader = {");
  assertStringIncludes(factory, "getSkills: () => ({ skills: [], diagnostics: [] })");
  assertStringIncludes(factory, "getAgentsFiles: () => ({ agentsFiles: [] })");
  assertStringIncludes(factory, "getAppendSystemPrompt: () => []");

  const tools = await Deno.readTextFile("packages/runner/src/harness/pi/tools.ts");
  for (
    const operation of [
      "environment.readFile",
      "environment.writeFile",
      "environment.runShell",
    ]
  ) {
    assertStringIncludes(tools, operation);
  }
  assert(!tools.includes("Deno.readFile"));
  assert(!tools.includes("Deno.writeFile"));
  assert(!tools.includes("Deno.Command"));
});

Deno.test("release routes and runner protocol keep deferred product surfaces absent", async () => {
  const routes = await Deno.readTextFile("packages/gateway/app/routes.ts");
  const protocol = (await Promise.all(
    (await typescriptSourcesUnder("packages/protocol/src")).map((path) => Deno.readTextFile(path)),
  )).join("\n");
  const deferredRouteNames = ["terminal", "preview", "portal", "passkey", "archive"];
  for (const name of deferredRouteNames) {
    assert(!new RegExp(`\\b${name}\\b`, "iu").test(routes), `deferred ${name} route is present`);
  }
  for (
    const name of [
      "TerminalSession",
      "PreviewSession",
      "Portal",
      "MigrateSession",
      "ArchiveSession",
    ]
  ) {
    assert(!protocol.includes(name), `deferred ${name} protocol is present`);
  }
  assert(!protocol.includes("forcePush"));
  assert(!protocol.includes("maxConcurrentSessions"));
});

async function typescriptSourcesUnder(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) paths.push(...await typescriptSourcesUnder(path));
    else if (entry.isFile && entry.name.endsWith(".ts")) paths.push(path);
  }
  return paths.sort();
}
