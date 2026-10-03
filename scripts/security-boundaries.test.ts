import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const RUNNER_SOURCE_ROOT = "packages/runner/src";

Deno.test("runner source keeps Durable construction and tools behind the audited boundary", async () => {
  const sources = await typescriptSourcesUnder(RUNNER_SOURCE_ROOT);
  const defaultLoaderUsers: string[] = [];
  const agentSessionFactories: string[] = [];
  const hostProcessUsers: string[] = [];

  for (const path of sources) {
    const source = await Deno.readTextFile(path);
    if (source.includes("DefaultResourceLoader")) defaultLoaderUsers.push(path);
    assert(!source.includes("@earendil-works/pi-coding-agent"), `${path} imports the retired SDK`);
    assert(!source.includes("NodeExecutionEnv"), `${path} exposes host execution`);
    if (source.includes("Harness.open(")) {
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
  assertEquals(agentSessionFactories, [
    "packages/runner/src/harness/durable/layer.ts",
    "packages/runner/src/harness/durable/storage.ts",
  ]);
  assertEquals(hostProcessUsers, [
    "packages/runner/src/environment/gondolin/persistent-root-disk.ts",
    "packages/runner/src/runtime/prerequisites.ts",
  ]);

  const factory = await Deno.readTextFile("packages/runner/src/harness/durable/layer.ts");
  assertStringIncludes(factory, "createRegistry()");
  assertStringIncludes(factory, "createGuestExecutionEnv(options.environment");
  assertStringIncludes(factory, "options.environmentStates.pipe(");
  const skills = await Deno.readTextFile("packages/runner/src/harness/durable/skills.ts");
  assertStringIncludes(skills, '"/workspace/.agents/skills"');
  assertStringIncludes(skills, "guest.listDirectory");
  assertStringIncludes(skills, "guest.readFile");
  for (const forbidden of ["node:fs", "Deno.read", "guest.run", "import("]) {
    assert(!skills.includes(forbidden), `skill discovery includes ${forbidden}`);
  }
  const models = await Deno.readTextFile("packages/runner/src/harness/durable/models.ts");
  assertStringIncludes(models, "InMemoryCredentialStore");
  const tools = (await Promise.all([
    "packages/runner/src/harness/durable/tools.ts",
    "packages/runner/src/harness/durable/environment.ts",
  ].map((path) => Deno.readTextFile(path)))).join("\n");
  for (
    const operation of [
      "guest.readFile",
      "guest.writeFile",
      "guest.run(",
      "guest.runShell",
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
