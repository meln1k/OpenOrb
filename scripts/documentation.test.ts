import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import rootConfiguration from "../deno.json" with { type: "json" };

const ROOT_DOCUMENTS = ["README.md", "security.md"] as const;

Deno.test("documentation has valid local links, anchors, and root task references", async () => {
  const markdownFiles = [
    ...ROOT_DOCUMENTS,
    ...await markdownFilesUnder("docs"),
  ];
  const rootTasks = new Set(Object.keys(rootConfiguration.tasks));
  const failures: string[] = [];

  for (const path of markdownFiles) {
    const markdown = await Deno.readTextFile(path);
    const anchors = markdownAnchors(markdown);
    for (const link of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
      const rawTarget = link[1]?.trim();
      if (!rawTarget || isExternalLink(rawTarget)) continue;
      const target = rawTarget.replace(/^<|>$/g, "").split(/\s+["']/u, 1)[0]!;
      const [rawFile, rawAnchor] = target.split("#", 2);
      const linkedPath = rawFile
        ? new URL(decodeURIComponent(rawFile), new URL(`file://${Deno.cwd()}/${path}`)).pathname
        : `${Deno.cwd()}/${path}`;
      try {
        const info = await Deno.stat(linkedPath);
        if (!info.isFile) failures.push(`${path}: local link is not a file: ${target}`);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          failures.push(`${path}: local link does not exist: ${target}`);
          continue;
        }
        throw error;
      }
      if (!rawAnchor) continue;
      const linkedMarkdown = linkedPath === `${Deno.cwd()}/${path}`
        ? markdown
        : await Deno.readTextFile(linkedPath);
      const linkedAnchors = linkedPath === `${Deno.cwd()}/${path}`
        ? anchors
        : markdownAnchors(linkedMarkdown);
      if (!linkedAnchors.has(decodeURIComponent(rawAnchor))) {
        failures.push(`${path}: local anchor does not exist: ${target}`);
      }
    }

    for (const command of markdown.matchAll(/\bdeno task (?!-{1,2})([a-z0-9:_-]+)/giu)) {
      const task = command[1]!;
      if (!rootTasks.has(task)) failures.push(`${path}: unknown root Deno task: ${task}`);
    }
  }

  assertEquals(failures, []);
});

Deno.test("operations documentation records the OO-024 recovery contract and release pins", async () => {
  const operations = await Deno.readTextFile("docs/operations.md");
  const normalizedOperations = operations.replaceAll(/\s+/gu, " ");
  for (
    const required of [
      "PostgreSQL",
      "OPENORB_MASTER_KEY",
      "SESSION_SECRET",
      "PUBLIC_URL=https://openorb.example.com",
      "no persistent local application volume",
      "no durable gateway files",
      "non-self-contained",
      "mutated in place",
      "Contents: Read and write",
      "opencode-go/deepseek-v4-flash",
      "Deno / standalone runner denort",
      "Gondolin",
      "OpenOrb guest image",
      "Pi AI / Pi coding-agent",
      "Remix",
      "Runner protocol",
    ]
  ) {
    assertStringIncludes(normalizedOperations, required);
  }

  const release = await Deno.readTextFile(
    "packages/runner/src/environment/gondolin/guest-image/release.ts",
  );
  const protocol = await Deno.readTextFile("packages/protocol/src/runner-api-schemas.ts");
  const rootConfiguration = await Deno.readTextFile("deno.json");
  const runnerConfiguration = await Deno.readTextFile("packages/runner/deno.json");
  assert(release.includes('id: "mvp-5"'));
  assert(protocol.includes("RUNNER_PROTOCOL_VERSION = 14"));
  for (const pin of ["2.9.5", "0.12.0", "0.84.2", "3.0.0-beta.10"]) {
    assert(
      operations.includes(pin) &&
        (pin === "2.9.5" || rootConfiguration.includes(pin) || runnerConfiguration.includes(pin)),
      `operations documentation does not match pin ${pin}`,
    );
  }
});

Deno.test("release guide and workflows preserve acceptance traceability and secret policy", async () => {
  const guide = await Deno.readTextFile("docs/release-acceptance.md");
  for (let criterion = 1; criterion <= 18; criterion += 1) {
    assert(
      new RegExp(`^\\|\\s*${criterion}\\s*\\|`, "mu").test(guide),
      `release guide does not map MVP criterion ${criterion}`,
    );
  }
  for (
    const invariant of [
      "No native host Git consumes a session workspace",
      "Hostile Git config, hooks, helpers, filters, textconv, fsmonitor",
      "DefaultResourceLoader",
      "Hostile `.pi` resources/settings",
      "All Pi file and shell tools execute through Gondolin",
      "Real Git and model credentials",
      "GH_TOKEN",
      "Path traversal and escaping symlinks",
    ]
  ) {
    assertStringIncludes(guide, invariant);
  }

  const ci = await Deno.readTextFile(".github/workflows/ci.yml");
  assertStringIncludes(ci, "deno task test:security");
  assertStringIncludes(ci, "deno task test:gondolin");
  assertStringIncludes(ci, "OPENORB_TEST_DATABASE_URL:");
  assert(!ci.includes("${{ secrets."));

  const acceptance = await Deno.readTextFile(".github/workflows/release-acceptance.yml");
  assertStringIncludes(acceptance, "workflow_dispatch:");
  assert(!acceptance.includes("pull_request:"));
  for (
    const secret of [
      "OPENORB_GITHUB_TEST_REPOSITORY",
      "OPENORB_GITHUB_TEST_TOKEN",
      "OPENCODE_API_KEY",
    ]
  ) {
    assertStringIncludes(acceptance, `secrets.${secret}`);
  }

  const smoke = await Deno.readTextFile(".github/workflows/runner-smoke.yml");
  assertStringIncludes(smoke, "runner: ubuntu-24.04");
  assertStringIncludes(smoke, "runner: ubuntu-24.04-arm");
  assertStringIncludes(smoke, "PATH=/nonexistent");

  const packageConfiguration = await Deno.readTextFile("package.json");
  assertStringIncludes(packageConfiguration, '"playwright": "1.55.0"');
});

async function markdownFilesUnder(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) paths.push(...await markdownFilesUnder(path));
    else if (entry.isFile && entry.name.endsWith(".md")) paths.push(path);
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
