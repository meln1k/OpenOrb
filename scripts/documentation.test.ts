import { readdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { readFile as readTextFileBytes } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@jsr/std__assert";
import rootConfiguration from "../package.json" with { type: "json" };

const ROOT_DOCUMENTS = ["README.md", "security.md"] as const;

test("documentation has valid local links, anchors, and root task references", async () => {
  const markdownFiles = [...ROOT_DOCUMENTS, ...(await markdownFilesUnder("docs"))];
  const rootTasks = new Set(Object.keys(rootConfiguration.scripts));
  const workspaceTasks = new Map<string, Set<string>>();
  for (const directory of ["gateway", "pi-env", "protocol", "result", "runner"]) {
    const manifest = JSON.parse(await readTextFile(`packages/${directory}/package.json`));
    workspaceTasks.set(manifest.name, new Set(Object.keys(manifest.scripts ?? {})));
    workspaceTasks.set(`packages/${directory}`, workspaceTasks.get(manifest.name)!);
  }
  const failures: string[] = [];

  for (const path of markdownFiles) {
    const markdown = await readTextFile(path);
    const anchors = markdownAnchors(markdown);
    for (const link of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
      const rawTarget = link[1]?.trim();
      if (!rawTarget || isExternalLink(rawTarget)) continue;
      const target = rawTarget.replace(/^<|>$/g, "").split(/\s+["']/u, 1)[0]!;
      const [rawFile, rawAnchor] = target.split("#", 2);
      const linkedPath = rawFile
        ? new URL(decodeURIComponent(rawFile), new URL(`file://${process.cwd()}/${path}`)).pathname
        : `${process.cwd()}/${path}`;
      try {
        const info = await stat(linkedPath);
        if (!info.isFile()) failures.push(`${path}: local link is not a file: ${target}`);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          failures.push(`${path}: local link does not exist: ${target}`);
          continue;
        }
        throw error;
      }
      if (!rawAnchor) continue;
      const linkedMarkdown =
        linkedPath === `${process.cwd()}/${path}` ? markdown : await readTextFile(linkedPath);
      const linkedAnchors =
        linkedPath === `${process.cwd()}/${path}` ? anchors : markdownAnchors(linkedMarkdown);
      if (!linkedAnchors.has(decodeURIComponent(rawAnchor))) {
        failures.push(`${path}: local anchor does not exist: ${target}`);
      }
    }

    for (const command of markdown.matchAll(
      /\bnpm run ([a-z0-9:_-]+)(?:\s+(?:--workspace|-w)(?:=|\s+)([@a-z0-9/._-]+))?/giu,
    )) {
      const task = command[1]!;
      const workspace = command[2];
      const tasks = workspace ? workspaceTasks.get(workspace) : rootTasks;
      if (!tasks?.has(task))
        failures.push(`${path}: unknown npm script: ${workspace ?? "root"}/${task}`);
    }
    for (const command of markdown.matchAll(
      /\bnpm (?:--workspace|-w)(?:=|\s+)([@a-z0-9/._-]+)\s+run\s+([a-z0-9:_-]+)/giu,
    )) {
      if (!workspaceTasks.get(command[1]!)?.has(command[2]!)) {
        failures.push(`${path}: unknown npm workspace script: ${command[1]}/${command[2]}`);
      }
    }
  }

  assertEquals(failures, []);
});

test("operations documentation records the recovery contract and release pins", async () => {
  const operations = await readTextFile("docs/operations.md");
  const normalizedOperations = operations.replaceAll(/\s+/gu, " ");
  for (const required of [
    "stateless Worker",
    "SQLite-backed configuration",
    "named RPC methods",
    "alarm-driven provider OAuth",
    "OPENORB_MASTER_KEY",
    "SESSION_SECRET",
    "PUBLIC_URL=https://openorb.example.com",
    "packages/gateway/.celld/dev",
    "Keep all SQLite/WAL sidecars together",
    "original secrets",
    "Existing PostgreSQL data is not imported",
    "Runners DO live projections are not a Session backup",
    "persistent root disk",
    "mutates the persistent root disk in place",
    "Contents: Read and write",
    "opencode-go/deepseek-v4-flash",
    "Node",
    "Vite+",
    "Gondolin",
    "OpenOrb guest image",
    "Pi AI / Pi Durable",
    "Remix",
    "Runner protocol",
  ]) {
    assertStringIncludes(normalizedOperations, required);
  }
  assert(!normalizedOperations.includes("no persistent local application volume"));
  assert(!normalizedOperations.includes("no durable gateway files"));

  const workerConfiguration = await readTextFile("packages/gateway/wrangler.jsonc");
  for (const className of ["Workspace", "Runners", "Session"]) {
    assert(
      new RegExp(`"class_name"\\s*:\\s*"${className}"`, "u").test(workerConfiguration),
      `${className} must be a native DO binding`,
    );
    assert(
      new RegExp(`"new_sqlite_classes"\\s*:\\s*\\[[^\\]]*"${className}"`, "u").test(
        workerConfiguration,
      ),
      `${className} must use SQLite-backed persistence`,
    );
  }
  assertStringIncludes(workerConfiguration, '"main": "dist/worker.js"');
  assertStringIncludes(workerConfiguration, '"binding": "ASSETS"');

  const release = await readTextFile(
    "packages/runner/src/environment/gondolin/guest-image/release.ts",
  );
  const protocol = await readTextFile("packages/protocol/src/runner-api-schemas.ts");
  const rootConfiguration = await readTextFile("package.json");
  const runnerConfiguration = await readTextFile("packages/runner/package.json");
  // Pi packages are pinned where the Session Durable Object uses them, not by the runner.
  const gatewayConfiguration = await readTextFile("packages/gateway/package.json");
  assert(release.includes('id: "mvp-7"'));
  assert(release.includes('id: "release-1"'));
  assert(release.includes('id: "release-2"'));
  assert(release.includes("GUEST_IMAGE_RELEASE = RELEASE_2"));
  assert(protocol.includes("RUNNER_PROTOCOL_VERSION = 28"));
  for (const pin of ["26.11.1", "0.12.0", "1.2.0", "3.0.0"]) {
    assert(
      operations.includes(pin) &&
        (rootConfiguration.includes(pin) ||
          runnerConfiguration.includes(pin) ||
          gatewayConfiguration.includes(pin)),
      `operations documentation does not match pin ${pin}`,
    );
  }
  assertStringIncludes(rootConfiguration, '"vite-plus": "1.1.0"');
  assertStringIncludes(await readTextFile(".tool-versions"), "nodejs 26.11.1");
  const installer = await readTextFile("scripts/install-celld.sh");
  for (const [tool, pin] of [
    ["celld", "0.6.2"],
    ["esbuild", "0.28.2"],
  ] as const) {
    assertStringIncludes(installer, `${tool}_version=${pin}`);
    assertStringIncludes(operations, pin);
  }
});

test("release guide and workflows preserve acceptance traceability and secret policy", async () => {
  const guide = await readTextFile("docs/release-acceptance.md");
  for (let criterion = 1; criterion <= 19; criterion += 1) {
    assert(
      new RegExp(`^\\|\\s*${criterion}\\s*\\|`, "mu").test(guide),
      `release guide does not map release criterion ${criterion}`,
    );
  }
  for (const invariant of [
    "No native host Git consumes a session workspace",
    "Hostile Git config, hooks, helpers, filters, textconv, fsmonitor",
    "DefaultResourceLoader",
    "Hostile `.pi` resources/settings",
    "All Pi file and shell tools execute through Gondolin",
    "Git credentials remain mediated; model credentials are not supplied to the guest",
    "Conversation content has no credential-redaction filter.",
    "GH_TOKEN",
    "remain in the guest namespace and cannot access runner-host files",
  ]) {
    assertStringIncludes(guide, invariant);
  }

  const acceptanceScript = await readTextFile("scripts/release-acceptance.ts");
  for (const assertion of [
    "routes.app.settings.secrets.index.href()",
    'GENERIC_SECRET_NAME = "ACCEPTANCE_GITHUB_TOKEN"',
    'GENERIC_SECRET_HOST = "api.github.com"',
    'getByRole("dialog", { name: "Add secret" })',
    "mediatedGenericSecretProbe(repository)",
  ]) {
    assertStringIncludes(acceptanceScript, assertion);
  }

  const ci = await readTextFile(".github/workflows/ci.yml");
  assertStringIncludes(ci, "bash scripts/install-celld.sh");
  assertStringIncludes(ci, "npm run check");
  assertStringIncludes(ci, "npm run check:docs");
  assertStringIncludes(ci, "npm run test");
  assertStringIncludes(ci, "npm run test:security");
  assertStringIncludes(ci, "npm run test:gondolin");
  assert(!/postgres|DATABASE_URL/iu.test(ci));
  assert(!ci.includes("${{ secrets."));

  const acceptance = await readTextFile(".github/workflows/release-acceptance.yml");
  assertStringIncludes(acceptance, "workflow_dispatch:");
  assert(!acceptance.includes("pull_request:"));
  for (const secret of [
    "OPENORB_GITHUB_TEST_REPOSITORY",
    "OPENORB_GITHUB_TEST_TOKEN",
    "OPENCODE_API_KEY",
  ]) {
    assertStringIncludes(acceptance, `secrets.${secret}`);
  }

  const smoke = await readTextFile(".github/workflows/runner-smoke.yml");
  assertStringIncludes(smoke, "runner: ubuntu-24.04");
  assertStringIncludes(smoke, "runner: ubuntu-24.04-arm");
  assertStringIncludes(smoke, "PATH=/nonexistent");

  const packageConfiguration = await readTextFile("package.json");
  assertStringIncludes(packageConfiguration, '"playwright": "1.55.0"');
});

async function markdownFilesUnder(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await markdownFilesUnder(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
  }
  return paths.sort();
}

function isExternalLink(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target);
}

function markdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    const base = match[1]!
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/gu, "")
      .replace(/[`*_~]/gu, "")
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
      .replace(/\s+/gu, "-");
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    anchors.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }
  return anchors;
}

function readTextFile(path: string | URL): Promise<string> {
  return readTextFileBytes(path, "utf8");
}
