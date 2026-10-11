import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const RUNNER_SOURCE_ROOT = "packages/runner/src";
const SESSION_SOURCE_ROOT = "packages/gateway/app/cells/session";

Deno.test("runner source hosts no agent and launches only audited host processes", async () => {
  const hostProcessUsers: string[] = [];
  for (const path of await typescriptSourcesUnder(RUNNER_SOURCE_ROOT)) {
    const source = await Deno.readTextFile(path);
    // ADR 0005: the agent runs in the Session Durable Object; the runner only supplies compute.
    for (
      const forbidden of ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "pi-coding-agent"]
    ) {
      assert(!source.includes(forbidden), `${path} imports ${forbidden}`);
    }
    if (source.includes("node:child_process") || source.includes("new Deno.Command")) {
      hostProcessUsers.push(path);
    }
    assert(
      !/new\s+Deno\.Command\s*\(\s*["'](?:\/usr\/bin\/)?git["']/u.test(source),
      `${path} can launch native host Git`,
    );
  }
  assertEquals(hostProcessUsers, [
    "packages/runner/src/environment/gondolin/persistent-root-disk.ts",
    "packages/runner/src/runtime/prerequisites.ts",
  ]);
});

Deno.test("the Session Durable Object reaches the guest only through the provider ExecutionEnv", async () => {
  const harnessFactories: string[] = [];
  for (const path of await typescriptSourcesUnder(SESSION_SOURCE_ROOT)) {
    const source = await Deno.readTextFile(path);
    assert(!source.includes("NodeExecutionEnv"), `${path} exposes host execution`);
    assert(!source.includes("DefaultResourceLoader"), `${path} loads host resources`);
    assert(!source.includes("pi-coding-agent"), `${path} imports the retired SDK`);
    assert(!source.includes("Deno.Command"), `${path} launches host processes`);
    if (source.includes("Harness.open(")) harnessFactories.push(path);
  }
  assertEquals(harnessFactories, [`${SESSION_SOURCE_ROOT}/agent.ts`]);

  const agent = await Deno.readTextFile(`${SESSION_SOURCE_ROOT}/agent.ts`);
  assertStringIncludes(agent, "createRegistry()");
  assertStringIncludes(agent, "env: () => options.env");
  // Neither ambient environment variables nor host files may supply model credentials.
  assertStringIncludes(agent, "env: () => Promise.resolve(undefined)");
  assertStringIncludes(agent, "fileExists: () => Promise.resolve(false)");

  const skills = await Deno.readTextFile(`${SESSION_SOURCE_ROOT}/skills.ts`);
  assertStringIncludes(skills, '"/workspace/.agents/skills"');
  assertStringIncludes(skills, "env.listDir");
  assertStringIncludes(skills, "env.readTextFile");
  for (const forbidden of ["node:fs", "Deno.read", "env.exec", "import("]) {
    assert(!skills.includes(forbidden), `skill discovery includes ${forbidden}`);
  }
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
