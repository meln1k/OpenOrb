import { readdir } from "node:fs/promises";
import { readFile as readTextFileBytes } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@jsr/std__assert";

const RUNNER_SOURCE_ROOT = "packages/runner/src";
const SESSION_SOURCE_ROOT = "packages/gateway/app/cells/session";

test("runner source hosts no agent and launches only audited host processes", async () => {
  const hostProcessUsers: string[] = [];
  const processAdapters: string[] = [];
  for (const path of await typescriptSourcesUnder(RUNNER_SOURCE_ROOT)) {
    const source = await readTextFile(path);
    // ADR 0005: the agent runs in the Session Durable Object; the runner only supplies compute.
    for (const forbidden of [
      "@earendil-works/pi-durable",
      "@earendil-works/pi-ai",
      "pi-coding-agent",
    ]) {
      assert(!source.includes(forbidden), `${path} imports ${forbidden}`);
    }
    if (/(?:node:)?child_process/u.test(source) || source.includes("new Deno.Command")) {
      processAdapters.push(path);
    }
    if (/from\s+["'][^"']*\/process\.ts["']/u.test(source)) {
      hostProcessUsers.push(path);
    }
    assert(
      !/(?:new\s+Deno\.Command|\b(?:execute|spawn|spawnSync|exec|execSync|execFile|execFileSync))\s*\(\s*["'](?:\/usr\/bin\/)?git(?:["'\s])/u.test(
        source,
      ),
      `${path} can launch native host Git`,
    );
  }
  assertEquals(processAdapters, ["packages/runner/src/runtime/process.ts"]);
  assertEquals(hostProcessUsers, [
    "packages/runner/src/environment/gondolin/persistent-root-disk.ts",
    "packages/runner/src/runtime/prerequisites.ts",
  ]);
});

test("the standalone Node runner retains its hardened OS security boundary", async () => {
  const unit = await readTextFile("packages/runner/systemd/openorb-runner.service");
  for (const directive of [
    "User=openorb-runner",
    "Group=openorb-runner",
    "StateDirectoryMode=0700",
    "UMask=0077",
    "NoNewPrivileges=true",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "ProtectSystem=strict",
    "ReadWritePaths=/var/lib/openorb-runner",
    "ProtectHome=true",
    "PrivateTmp=true",
    "DevicePolicy=closed",
    "DeviceAllow=/dev/kvm rw",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictSUIDSGID=true",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  ]) {
    const key = directive.slice(0, directive.indexOf("=") + 1);
    assertEquals(
      unit.split(/\r?\n/u).filter((line) => line.startsWith(key)),
      [directive],
      `runner unit changes or overrides ${directive}`,
    );
  }
  assert(!/^ReadWritePaths=.*(?:\s\/\s|=\/$)/mu.test(unit));
  assert(!/^DeviceAllow=(?!\/dev\/kvm rw$)/mu.test(unit));
  const disk = await readTextFile(
    `${RUNNER_SOURCE_ROOT}/environment/gondolin/persistent-root-disk.ts`,
  );
  assertStringIncludes(disk, "sync()");
  assertStringIncludes(disk, "0o600");
  const store = await readTextFile(`${RUNNER_SOURCE_ROOT}/environment/session/store.ts`);
  assertStringIncludes(store, "0o700");
});

test("the Session Durable Object reaches the guest only through the provider ExecutionEnv", async () => {
  const harnessFactories: string[] = [];
  for (const path of await typescriptSourcesUnder(SESSION_SOURCE_ROOT)) {
    const source = await readTextFile(path);
    assert(!source.includes("NodeExecutionEnv"), `${path} exposes host execution`);
    assert(!source.includes("DefaultResourceLoader"), `${path} loads host resources`);
    assert(!source.includes("pi-coding-agent"), `${path} imports the retired SDK`);
    assert(!source.includes("Deno.Command"), `${path} launches host processes`);
    assert(!/(?:node:)?child_process/u.test(source), `${path} launches Node host processes`);
    if (source.includes("Harness.open(")) harnessFactories.push(path);
  }
  assertEquals(harnessFactories, [`${SESSION_SOURCE_ROOT}/agent.ts`]);

  const agent = await readTextFile(`${SESSION_SOURCE_ROOT}/agent.ts`);
  assertStringIncludes(agent, "createRegistry()");
  assertStringIncludes(agent, "env: () => options.env");
  // Neither ambient environment variables nor host files may supply model credentials.
  assertStringIncludes(agent, "env: () => Promise.resolve(undefined)");
  assertStringIncludes(agent, "fileExists: () => Promise.resolve(false)");

  const skills = await readTextFile(`${SESSION_SOURCE_ROOT}/skills.ts`);
  assertStringIncludes(skills, '"/workspace/.agents/skills"');
  assertStringIncludes(skills, "env.listDir");
  assertStringIncludes(skills, "env.readTextFile");
  for (const forbidden of ["node:fs", "Deno.read", "env.exec", "import("]) {
    assert(!skills.includes(forbidden), `skill discovery includes ${forbidden}`);
  }
});

test("the sandbox runs in a capability-free isolate without network", async () => {
  // ADR 0007: an escape from just-bash must find no bindings, network, or shared isolate.
  const provider = await readTextFile(`${SESSION_SOURCE_ROOT}/environment/sandbox-provider.ts`);
  assertStringIncludes(provider, "env: {},");
  assertStringIncludes(provider, "globalOutbound: null,");
  assertStringIncludes(provider, 'credentials: "none",');
  assertStringIncludes(provider, "limits: { cpuMs: SANDBOX_CPU_MS }");
  assertStringIncludes(provider, "`openorb-sandbox:${sessionId}:${SANDBOX_WORKER.hash}`");
  const sandboxRoot = `${SESSION_SOURCE_ROOT}/environment/sandbox`;
  for (const path of await typescriptSourcesUnder(sandboxRoot)) {
    const source = await readTextFile(path);
    // Only the browser build: no host filesystem adapters, Python, JavaScript, or SQLite.
    assert(!/from "just-bash"/u.test(source), `${path} imports just-bash's Node build`);
    for (const forbidden of ["network:", "fetch:", "python:", "javascript:", "OverlayFs"]) {
      assert(!source.includes(forbidden), `${path} enables ${forbidden}`);
    }
  }
});

test("release routes and runner protocol keep deferred product surfaces absent", async () => {
  const routes = await readTextFile("packages/gateway/app/routes.ts");
  const protocol = (
    await Promise.all(
      (await typescriptSourcesUnder("packages/protocol/src")).map((path) => readTextFile(path)),
    )
  ).join("\n");
  const deferredRouteNames = ["terminal", "preview", "portal", "passkey", "archive"];
  for (const name of deferredRouteNames) {
    assert(!new RegExp(`\\b${name}\\b`, "iu").test(routes), `deferred ${name} route is present`);
  }
  for (const name of [
    "TerminalSession",
    "PreviewSession",
    "Portal",
    "MigrateSession",
    "ArchiveSession",
  ]) {
    assert(!protocol.includes(name), `deferred ${name} protocol is present`);
  }
  assert(!protocol.includes("forcePush"));
  assert(!protocol.includes("maxConcurrentSessions"));
});

async function typescriptSourcesUnder(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await typescriptSourcesUnder(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) paths.push(path);
  }
  return paths.sort();
}

function readTextFile(path: string | URL): Promise<string> {
  return readTextFileBytes(path, "utf8");
}
