import { basename, join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { routes } from "../packages/gateway/app/routes.ts";

const REPOSITORY_ROOT = new URL("../", import.meta.url).pathname;
const GATEWAY_PORT = 8787;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const ACCEPTANCE_TIMEOUT_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 500;
const INITIAL_FILE = "acceptance-initial.txt";
const RESUMED_FILE = "acceptance-resumed.txt";
const COMMIT_MESSAGE = "OpenOrb release acceptance";

interface AcceptanceConfiguration {
  readonly githubRepository: string;
  readonly githubToken: string;
  readonly openCodeApiKey: string;
  readonly postgresUrl: string;
  readonly chromiumExecutablePath: string | undefined;
}

interface GitHubRepository {
  readonly private: boolean;
  readonly default_branch: string;
}

interface GitHubReference {
  readonly object: { readonly sha: string };
}

interface GitHubCommit {
  readonly message: string;
  readonly tree: { readonly sha: string };
}

interface GitHubObject {
  readonly sha: string;
}

interface GitHubTree {
  readonly tree: readonly {
    readonly path: string;
    readonly sha: string;
    readonly type: string;
  }[];
}

interface GitHubBlob {
  readonly content: string;
  readonly encoding: string;
}

interface GitHubRepositoryIdentity {
  readonly owner: string;
  readonly repository: string;
}

const configuration = readConfiguration();
Deno.env.delete("OPENORB_GITHUB_TEST_TOKEN");
Deno.env.delete("OPENCODE_API_KEY");
const runId = crypto.randomUUID().replaceAll("-", "");
const databaseName = `openorb_acceptance_${runId}`;
const fixtureBranch = `openorb-e2e-fixture-${runId}`;
const sessionBranch = `openorb/e2e-${runId}`;
const sessionId = crypto.randomUUID();
const runnerName = `release-acceptance-${runId.slice(0, 12)}`;
const adminPassword = `OpenOrb-${runId}`;
const setupMarker = `setup-${runId}`;
const resumeMarker = `resume-${runId}`;
const initialMarker = `initial-${runId}`;
const resumedMarker = `resumed-${runId}`;
const databaseUrl = databaseUrlForName(configuration.postgresUrl, databaseName);
const temporaryDirectory = await Deno.makeTempDir({ prefix: "openorb-release-acceptance-" });
const runnerDirectory = join(temporaryDirectory, "runner");
const runnerSessionDirectory = join(runnerDirectory, "sessions", sessionId);

let gateway: ManagedProcess | undefined;
let runner: ManagedProcess | undefined;

async function runAcceptance(): Promise<void> {
  const github = new GitHubClient(configuration.githubRepository, configuration.githubToken);
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => Deno.remove(temporaryDirectory, { recursive: true }));

  await preflight();
  const repository = await github.getRepository();
  invariant(
    repository.private,
    "OPENORB_GITHUB_TEST_REPOSITORY must identify a private repository.",
  );
  cleanup.defer(() => github.deleteBranch(fixtureBranch));
  cleanup.defer(() => github.deleteBranch(sessionBranch));
  await github.createFixtureBranch(repository.default_branch, fixtureBranch, {
    setup: setupScript(setupMarker),
    resume: resumeScript(setupMarker, resumeMarker),
  });
  console.log(`[acceptance] created fixture branch ${fixtureBranch}`);

  await createDatabase(configuration.postgresUrl, databaseName);
  cleanup.defer(() => dropDatabase(configuration.postgresUrl, databaseName));
  await Deno.mkdir(runnerDirectory, { recursive: true, mode: 0o700 });
  await Deno.mkdir(join(runnerDirectory, "tmp"));
  await Deno.mkdir(join(runnerDirectory, "cache"));

  gateway = spawnGateway(databaseUrl, [
    configuration.githubToken,
    configuration.openCodeApiKey,
    configuration.postgresUrl,
    databaseUrl,
  ]);
  cleanup.defer(async () => {
    await gateway?.stop();
    assertNoLogLeaks();
  });
  await waitForGateway(gateway);

  const browser = await chromium.launch({
    headless: true,
    ...(configuration.chromiumExecutablePath === undefined
      ? {}
      : { executablePath: configuration.chromiumExecutablePath }),
  });
  cleanup.defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  await configureGateway(page);
  const enrollmentToken = await readEnrollmentToken(page);
  runner = spawnRunner(enrollmentToken, [configuration.githubToken, configuration.openCodeApiKey]);
  cleanup.defer(async () => {
    await runner?.stop();
    assertNoLogLeaks();
  });
  await waitForRunner(page, runnerName, runner);

  const gitMonitor = new LinuxHostGitProcessMonitor(join(runnerSessionDirectory, "workspace"));
  gitMonitor.start();
  cleanup.defer(async () => {
    const findings = await gitMonitor.stop();
    invariant(
      findings.length === 0,
      `Host Git processes touched the runner workspace: ${findings.join(", ")}`,
    );
  });

  await createSession(page);
  await waitForSessionState(page, "ready");
  const changesPanel = page.locator('[data-slot="changes-panel"]');
  await waitForText(changesPanel, INITIAL_FILE);
  await waitForText(changesPanel, initialMarker);

  await page.getByRole("button", { name: "Stop Gondolin VM" }).click();
  await waitForSessionState(page, "stopped");
  await assertSingleCheckpoint();

  await page.getByLabel("Continue session").fill(continuationPrompt());
  await page.getByRole("button", { name: "Send prompt" }).click();
  await waitForSessionState(page, "ready");
  await assertTranscriptContinuity(page);
  await github.waitForBranchFiles(sessionBranch, {
    [INITIAL_FILE]: `${initialMarker}\n`,
    [RESUMED_FILE]: `${resumedMarker}\n`,
  });

  const hostGitFindings = await gitMonitor.stop();
  invariant(
    hostGitFindings.length === 0,
    `Host Git processes touched the runner workspace: ${hostGitFindings.join(", ")}`,
  );
  await assertNoPersistedSecrets();
  assertNoLogLeaks();

  await page.getByRole("button", { name: "Delete session" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete session" }).click();
  await waitForSessionDeletion(page);
}

function readConfiguration(): AcceptanceConfiguration {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = Deno.env.get(name)?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const result = {
    githubRepository: required("OPENORB_GITHUB_TEST_REPOSITORY"),
    githubToken: required("OPENORB_GITHUB_TEST_TOKEN"),
    openCodeApiKey: required("OPENCODE_API_KEY"),
    postgresUrl: Deno.env.get("OPENORB_E2E_POSTGRES_URL")?.trim() ||
      "postgres://localhost/postgres",
    chromiumExecutablePath: Deno.env.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")?.trim() ||
      undefined,
  };
  if (missing.length > 0) {
    throw new Error(`Missing required release acceptance secrets: ${missing.join(", ")}`);
  }
  return result;
}

async function preflight(): Promise<void> {
  invariant(Deno.build.os === "linux", "Release acceptance requires Linux.");
  invariant(Deno.build.arch === "x86_64", "Release acceptance requires Linux x64.");
  const kvm = await Deno.stat("/dev/kvm").catch(() => undefined);
  invariant(kvm?.isCharDevice === true, "Release acceptance requires hardware KVM at /dev/kvm.");
  await command("psql", [configuration.postgresUrl, "-Atqc", "SELECT 1"]);
}

function spawnGateway(url: string, secrets: readonly string[]): ManagedProcess {
  const masterKey = randomHex(32);
  const sessionSecret = randomHex(32);
  const user = Deno.env.get("USER");
  return new ManagedProcess(
    "gateway",
    new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        "--allow-env",
        "--allow-ffi",
        "--allow-net",
        "--allow-read",
        "server.ts",
      ],
      cwd: join(REPOSITORY_ROOT, "packages/gateway"),
      clearEnv: true,
      env: {
        DATABASE_URL: url,
        NODE_ENV: "acceptance",
        OPENORB_MASTER_KEY: masterKey,
        PATH: Deno.env.get("PATH") ?? "",
        PORT: String(GATEWAY_PORT),
        SESSION_SECRET: sessionSecret,
        ...(user === undefined ? {} : { USER: user }),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }),
    [...secrets, masterKey, sessionSecret],
  );
}

function spawnRunner(enrollmentToken: string, secrets: readonly string[]): ManagedProcess {
  return new ManagedProcess(
    "runner",
    new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--unstable-net",
        "--unstable-process",
        "--frozen",
        `--config=${join(REPOSITORY_ROOT, "packages/runner/deno.json")}`,
        "--node-modules-dir=auto",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        `--allow-write=${runnerDirectory}`,
        "--allow-run=qemu-system-x86_64,qemu-img",
        "--allow-sys=cpus,gid,homedir,hostname,networkInterfaces,osRelease,statfs,systemMemoryInfo,uid",
        join(REPOSITORY_ROOT, "packages/runner/src/standalone.ts"),
        "--gateway",
        GATEWAY_URL,
        "--enrollment-token",
        enrollmentToken,
        "--name",
        runnerName,
      ],
      cwd: runnerDirectory,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        PWD: runnerDirectory,
        TMPDIR: join(runnerDirectory, "tmp"),
        XDG_CACHE_HOME: join(runnerDirectory, "cache"),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }),
    [...secrets, enrollmentToken],
  );
}

async function waitForGateway(process: ManagedProcess): Promise<void> {
  await poll("gateway readiness", async () => {
    process.assertRunning();
    const response = await fetch(gatewayUrl(routes.health.href())).catch(() => undefined);
    return response?.ok === true;
  }, 60_000);
}

async function configureGateway(page: Page): Promise<void> {
  const setupResponse = await page.goto(gatewayUrl(routes.auth.setup.index.href()));
  invariant(
    setupResponse?.ok() === true,
    `Gateway setup page returned HTTP ${setupResponse?.status() ?? "no response"}.`,
  );
  const password = page.getByLabel("Password", { exact: true });
  if (await password.count() === 0) {
    const body = (await page.locator("body").innerText()).slice(0, 2_000);
    throw new Error(
      `Gateway setup page did not render its password field at ${page.url()}: ${body}`,
    );
  }
  await password.fill(adminPassword);
  await page.getByLabel("Confirm password", { exact: true }).fill(adminPassword);
  await page.getByRole("button", { name: "Create administrator" }).click();
  await page.waitForURL(gatewayUrl(routes.auth.login.index.href()));
  await page.getByLabel("Password", { exact: true }).fill(adminPassword);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(gatewayUrl(routes.app.index.href()));

  await page.goto(gatewayUrl(routes.app.settings.providers.index.href()));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const providerDialog = page.getByRole("dialog", { name: "Configure model provider" });
  await providerDialog.getByLabel("Provider").selectOption("opencode-go");
  await providerDialog.getByLabel("API key").fill(configuration.openCodeApiKey);
  await providerDialog.getByRole("button", { name: "Save provider" }).click();
  await waitForText(page.getByLabel("Configured model providers"), "opencode-go");

  await page.goto(gatewayUrl(routes.app.settings.github.index.href()));
  await page.getByRole("button", { name: "Add token" }).click();
  const githubDialog = page.getByRole("dialog", { name: "Add GitHub token" });
  await githubDialog.getByLabel("GitHub token").fill(configuration.githubToken);
  await githubDialog.getByRole("button", { name: "Save token" }).click();
  await waitForText(page.locator('[aria-labelledby="github-heading"]'), "Configured");

  await page.goto(gatewayUrl(routes.app.settings.gitAuthor.index.href()));
  await page.getByLabel("Name", { exact: true }).fill("OpenOrb Release Acceptance");
  await page.getByLabel("Email", { exact: true }).fill("release-acceptance@openorb.invalid");
  await page.getByRole("button", { name: "Save Git author" }).click();
  await waitForText(page.locator('[aria-labelledby="git-author-heading"]'), "Configured");

  await page.goto(gatewayUrl(routes.app.projects.index.href()));
  await page.getByRole("button", { name: "Add project" }).click();
  const projectDialog = page.getByRole("dialog", { name: "Add project" });
  await projectDialog.getByLabel("Name", { exact: true }).fill("Release acceptance");
  await projectDialog.getByLabel("GitHub repository").fill(configuration.githubRepository);
  await projectDialog.getByRole("button", { name: "Add project" }).click();
  await waitForText(page.getByLabel("Configured projects"), "Release acceptance");
}

async function readEnrollmentToken(page: Page): Promise<string> {
  await page.goto(gatewayUrl(routes.app.settings.runners.index.href()));
  const commandText = await page.locator('section[aria-label="Runner enrollment command"] code')
    .innerText();
  const match = commandText.match(/--enrollment-token\s+([^\s\\]+)/u);
  invariant(match?.[1] !== undefined, "Runner enrollment token was absent from the settings UI.");
  return match[1];
}

async function waitForRunner(
  page: Page,
  name: string,
  process: ManagedProcess,
): Promise<void> {
  await poll("runner enrollment", async () => {
    process.assertRunning();
    await page.reload();
    const enrolled = page.getByLabel("Enrolled runners");
    const text = await enrolled.innerText();
    return text.includes(name) && text.includes("Online");
  }, ACCEPTANCE_TIMEOUT_MS);
}

async function createSession(page: Page): Promise<void> {
  await page.goto(gatewayUrl(routes.app.index.href()));
  await page.getByRole("button", { name: "New session" }).click();
  const composer = page.getByRole("dialog", { name: "New session" });
  await setHiddenInput(composer.locator('input[name="sessionId"]'), sessionId);
  await setHiddenInput(composer.locator('input[name="ref"]'), fixtureBranch);
  await setHiddenInput(composer.locator('input[name="branchName"]'), sessionBranch);
  await composer.getByLabel("Orb size").locator("select").selectOption("tiny");
  await composer.getByLabel("Initial prompt").fill(initialPrompt());
  await composer.getByRole("button", { name: "Start session" }).click();
  await page.waitForURL(gatewayUrl(routes.app.sessions.detail.href({ sessionId })));
}

function gatewayUrl(path: string): string {
  return new URL(path, GATEWAY_URL).href;
}

async function setHiddenInput(input: Locator, value: string): Promise<void> {
  await input.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLInputElement)) throw new Error("Expected a hidden input.");
    element.value = nextValue;
  }, value);
}

function initialPrompt(): string {
  return [
    "Use shell commands to perform this acceptance task exactly.",
    "Without printing either value, first assert that GITHUB_TOKEN is unset and GH_TOKEN contains the mediated placeholder.",
    `Create ${INITIAL_FILE} containing exactly ${initialMarker} followed by a newline.`,
    "Do not commit or push anything during this turn.",
    `Reply with ${initialMarker} after the file has been written.`,
  ].join(" ");
}

function continuationPrompt(): string {
  return [
    "Use shell commands to perform this acceptance task exactly.",
    "Without printing either value, assert that GITHUB_TOKEN is unset and GH_TOKEN contains the mediated placeholder.",
    `Assert that /opt/openorb-acceptance-resume-ok contains exactly ${resumeMarker}.`,
    `Assert that ${INITIAL_FILE} still contains exactly ${initialMarker}.`,
    `Create ${RESUMED_FILE} containing exactly ${resumedMarker} followed by a newline.`,
    `Stage ${INITIAL_FILE} and ${RESUMED_FILE}, commit with the exact message '${COMMIT_MESSAGE}',`,
    "then push the current branch to origin. Do not print credentials or environment values.",
    `Reply with ${resumedMarker} only after the push succeeds.`,
  ].join(" ");
}

async function waitForSessionState(page: Page, expected: string): Promise<void> {
  await poll(`session state ${expected}`, async () => {
    runner?.assertRunning();
    const conversation = page.getByLabel("Session conversation");
    const state = await conversation.getAttribute("data-session-state");
    if (state === "error") {
      throw new FatalAcceptanceError(`Session failed while waiting for ${expected}.`);
    }
    return state === expected;
  }, ACCEPTANCE_TIMEOUT_MS);
}

async function assertSingleCheckpoint(): Promise<void> {
  const checkpointDirectory = join(runnerSessionDirectory, "checkpoints");
  const files: string[] = [];
  for await (const entry of Deno.readDir(checkpointDirectory)) {
    if (entry.isFile) files.push(entry.name);
  }
  invariant(files.length === 1, `Expected one retained checkpoint, found ${files.length}.`);
}

async function assertTranscriptContinuity(page: Page): Promise<void> {
  const transcript = await page.getByLabel("Session conversation").innerText();
  for (const expected of [initialMarker, resumedMarker, INITIAL_FILE, RESUMED_FILE]) {
    invariant(transcript.includes(expected), `Session transcript does not contain ${expected}.`);
  }
  invariant(
    !transcript.includes(configuration.githubToken),
    "GitHub token leaked into transcript.",
  );
  invariant(
    !transcript.includes(configuration.openCodeApiKey),
    "Model key leaked into transcript.",
  );
}

async function assertNoPersistedSecrets(): Promise<void> {
  const secrets = [configuration.githubToken, configuration.openCodeApiKey];
  for await (const path of ordinaryFiles(runnerDirectory)) {
    const information = await Deno.stat(path);
    if (information.size > 2 * 1024 * 1024) continue;
    const contents = await Deno.readTextFile(path).catch(() => undefined);
    if (contents === undefined) continue;
    for (const secret of secrets) {
      invariant(!contents.includes(secret), `A credential was persisted in ${path}.`);
    }
  }
}

async function* ordinaryFiles(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      if (entry.name !== "images" && entry.name !== "checkpoints") yield* ordinaryFiles(path);
    } else if (entry.isFile && !entry.name.endsWith(".qcow2")) {
      yield path;
    }
  }
}

function assertNoLogLeaks(): void {
  for (const process of [gateway, runner]) {
    if (process?.secretLeak === true) throw new Error(`${process.name} emitted a raw credential.`);
  }
}

async function waitForSessionDeletion(page: Page): Promise<void> {
  await poll("session deletion", async () => {
    const sessionExists = await Deno.stat(runnerSessionDirectory).then(
      () => true,
      (error) => {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      },
    );
    return !sessionExists && !page.url().includes(sessionId) &&
      await page.getByText(initialMarker, { exact: false }).count() === 0;
  }, 90_000);
}

function setupScript(marker: string): string {
  return `#!/bin/sh
set -eu
count_file=/opt/openorb-acceptance-setup-count
count=0
if [ -f "$count_file" ]; then count="$(cat "$count_file")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$count_file"
printf '%s\\n' '${marker}' > /opt/openorb-acceptance-setup-ok
`;
}

function resumeScript(expectedSetupMarker: string, marker: string): string {
  return `#!/bin/sh
set -eu
test "$(cat /opt/openorb-acceptance-setup-count)" = "1"
test "$(cat /opt/openorb-acceptance-setup-ok)" = '${expectedSetupMarker}'
printf '%s\\n' '${marker}' > /opt/openorb-acceptance-resume-ok
`;
}

class GitHubClient {
  readonly #owner: string;
  readonly #repository: string;
  readonly #token: string;

  constructor(repository: string, token: string) {
    const parsed = parseGitHubRepository(repository);
    this.#owner = parsed.owner;
    this.#repository = parsed.repository;
    this.#token = token;
  }

  getRepository(): Promise<GitHubRepository> {
    return this.#request<GitHubRepository>("GET", "");
  }

  async createFixtureBranch(
    baseBranch: string,
    branch: string,
    scripts: { readonly setup: string; readonly resume: string },
  ): Promise<void> {
    const baseReference = await this.#request<GitHubReference>(
      "GET",
      `/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    );
    const baseCommit = await this.#request<GitHubCommit>(
      "GET",
      `/git/commits/${baseReference.object.sha}`,
    );
    const setup = await this.#request<GitHubObject>("POST", "/git/blobs", {
      content: scripts.setup,
      encoding: "utf-8",
    });
    const resume = await this.#request<GitHubObject>("POST", "/git/blobs", {
      content: scripts.resume,
      encoding: "utf-8",
    });
    const tree = await this.#request<GitHubObject>("POST", "/git/trees", {
      base_tree: baseCommit.tree.sha,
      tree: [
        { path: ".agents/setup", mode: "100755", type: "blob", sha: setup.sha },
        { path: ".agents/resume", mode: "100755", type: "blob", sha: resume.sha },
      ],
    });
    const commit = await this.#request<GitHubObject>("POST", "/git/commits", {
      message: "OpenOrb release acceptance fixture",
      tree: tree.sha,
      parents: [baseReference.object.sha],
    });
    await this.#request("POST", "/git/refs", {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  }

  async waitForBranchFiles(branch: string, expectedFiles: Record<string, string>): Promise<void> {
    await poll("pushed GitHub branch", async () => {
      try {
        const reference = await this.#request<GitHubReference>(
          "GET",
          `/git/ref/heads/${encodeURIComponent(branch)}`,
        );
        const commit = await this.#request<GitHubCommit>(
          "GET",
          `/git/commits/${reference.object.sha}`,
        );
        if (commit.message !== COMMIT_MESSAGE) return false;
        const tree = await this.#request<GitHubTree>(
          "GET",
          `/git/trees/${commit.tree.sha}?recursive=1`,
        );
        for (const [path, expected] of Object.entries(expectedFiles)) {
          const entry = tree.tree.find((candidate) =>
            candidate.path === path && candidate.type === "blob"
          );
          if (entry === undefined) return false;
          const blob = await this.#request<GitHubBlob>("GET", `/git/blobs/${entry.sha}`);
          if (decodeGitHubBlob(blob) !== expected) return false;
        }
        return true;
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return false;
        throw error;
      }
    }, ACCEPTANCE_TIMEOUT_MS);
  }

  async deleteBranch(branch: string): Promise<void> {
    try {
      await this.#request<GitHubReference>(
        "GET",
        `/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      await this.#request("DELETE", `/git/refs/heads/${encodeURIComponent(branch)}`);
      console.log(`[acceptance] deleted branch ${branch}`);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return;
      throw error;
    }
  }

  async #request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(
      `https://api.github.com/repos/${this.#owner}/${this.#repository}${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 2_000);
      throw new GitHubApiError(response.status, method, path, responseBody);
    }
    // SAFETY: Callers bind T to the documented response for the fixed endpoint passed here.
    if (response.status === 204) return undefined as T;
    const value: unknown = await response.json();
    // SAFETY: Callers bind T to the documented response for the fixed endpoint passed here.
    return value as T;
  }
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    body: string,
  ) {
    super(`GitHub API ${method} ${path || "/"} failed (${status}): ${body}`);
  }
}

class ManagedProcess {
  readonly name: string;
  readonly #process: Deno.ChildProcess;
  readonly #secrets: readonly string[];
  readonly #outputTasks: readonly Promise<void>[];
  #diagnostic = "";
  #status: Deno.CommandStatus | undefined;
  #secretLeak = false;

  constructor(name: string, command: Deno.Command, secrets: readonly string[]) {
    this.name = name;
    this.#secrets = secrets;
    this.#process = command.spawn();
    this.#outputTasks = [
      this.#capture("stdout", this.#process.stdout),
      this.#capture("stderr", this.#process.stderr),
    ];
    void this.#process.status.then((status) => this.#status = status);
  }

  get secretLeak(): boolean {
    return this.#secretLeak;
  }

  get diagnostic(): string {
    return this.#diagnostic.trim();
  }

  assertRunning(): void {
    if (this.#status !== undefined) {
      throw new FatalAcceptanceError(
        `${this.name} exited early with code ${this.#status.code}.${this.#diagnostic}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.#status === undefined) {
      this.#process.kill("SIGTERM");
      await Promise.race([
        this.#process.status,
        delay(10_000).then(() => {
          if (this.#status === undefined) this.#process.kill("SIGKILL");
        }),
      ]);
    }
    this.#status ??= await this.#process.status;
    await Promise.all(this.#outputTasks);
  }

  async #capture(streamName: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const retentionLength = Math.max(0, ...this.#secrets.map((secret) => secret.length - 1));
    let pending = "";
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      if (this.#secrets.some((secret) => pending.includes(secret))) this.#secretLeak = true;
      if (pending.length > retentionLength) {
        this.#appendDiagnostic(streamName, pending.slice(0, -retentionLength || undefined));
        pending = retentionLength === 0 ? "" : pending.slice(-retentionLength);
      }
    }
    pending += decoder.decode();
    if (this.#secrets.some((secret) => pending.includes(secret))) this.#secretLeak = true;
    this.#appendDiagnostic(streamName, pending);
  }

  #appendDiagnostic(streamName: string, text: string): void {
    const redacted = this.#secrets.reduce(
      (value, secret) => value.replaceAll(secret, "[REDACTED]"),
      text,
    );
    this.#diagnostic = `${this.#diagnostic}\n[${this.name}:${streamName}] ${redacted}`.slice(
      -16_000,
    );
  }
}

class FatalAcceptanceError extends Error {}

class LinuxHostGitProcessMonitor {
  readonly #workspacePath: string;
  readonly #findings = new Set<string>();
  #running: Promise<void> | undefined;
  #error: unknown;
  #stopping = false;

  constructor(workspacePath: string) {
    this.#workspacePath = workspacePath;
  }

  start(): void {
    this.#running ??= this.#run().catch((error) => this.#error = error);
  }

  async stop(): Promise<string[]> {
    this.#stopping = true;
    await this.#running;
    if (this.#error !== undefined) throw this.#error;
    return [...this.#findings].sort();
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      await this.#sample();
      await delay(50);
    }
    await this.#sample();
  }

  async #sample(): Promise<void> {
    const processList = await new Deno.Command("ps", {
      args: ["-eww", "-o", "pid=,comm=,args="],
      stdout: "piped",
      stderr: "null",
    }).output();
    invariant(processList.success, "Unable to inspect host processes with ps.");

    for (const line of new TextDecoder().decode(processList.stdout).split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/u);
      if (!match) continue;
      const [, pid, executable, argumentsAndEnvironment] = match;
      if (!pid || !executable || basename(executable) !== "git") continue;
      let workspaceEvidence = argumentsAndEnvironment?.includes(this.#workspacePath) ?? false;
      if (!workspaceEvidence) {
        const workingDirectory = await new Deno.Command("pwdx", {
          args: [pid],
          stdout: "piped",
          stderr: "null",
        }).output();
        workspaceEvidence = workingDirectory.success &&
          new TextDecoder().decode(workingDirectory.stdout).includes(this.#workspacePath);
      }
      if (workspaceEvidence) this.#findings.add(`pid ${pid}`);
    }
  }
}

function parseGitHubRepository(value: string): GitHubRepositoryIdentity {
  const normalized = value.match(/^https:\/\/github\.com\//u) ? new URL(value).pathname : value;
  const parts = normalized.replace(/^\/+|\/+$/gu, "").split("/");
  invariant(
    parts.length === 2 && parts[0] !== "" && parts[1] !== "",
    [
      "OPENORB_GITHUB_TEST_REPOSITORY must be owner/repository or an HTTPS github.com URL.",
    ].join(" "),
  );
  return { owner: parts[0]!, repository: parts[1]!.replace(/\.git$/u, "") };
}

function databaseUrlForName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function createDatabase(adminUrl: string, name: string): Promise<void> {
  await command("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${name}"`]);
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await command("psql", [
    adminUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
  ]);
}

async function command(executable: string, args: readonly string[]): Promise<void> {
  const output = await new Deno.Command(executable, {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `${executable} failed (${output.code}): ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
}

async function poll(
  description: string,
  operation: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await operation()) return;
      lastError = undefined;
    } catch (error) {
      if (error instanceof FatalAcceptanceError) throw error;
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for ${description}.${
      lastError === undefined ? "" : ` Last error: ${String(lastError)}`
    }`,
  );
}

async function waitForText(locator: Locator, expected: string): Promise<void> {
  await poll(
    `text ${expected}`,
    async () => (await locator.innerText()).includes(expected),
    60_000,
  );
}

function decodeGitHubBlob(blob: GitHubBlob): string {
  invariant(blob.encoding === "base64", `Unexpected GitHub blob encoding ${blob.encoding}.`);
  const compact = blob.content.replaceAll(/\s/gu, "");
  return new TextDecoder().decode(
    Uint8Array.from(atob(compact), (character) => character.charCodeAt(0)),
  );
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sanitizedErrorDetails(cause: unknown): string {
  const details = cause instanceof SuppressedError
    ? `${sanitizedErrorDetails(cause.error)}\nSuppressed during cleanup:\n${
      sanitizedErrorDetails(cause.suppressed)
    }`
    : cause instanceof Error
    ? cause.stack ?? `${cause.name}: ${cause.message}`
    : String(cause);
  return [
    configuration.githubToken,
    configuration.openCodeApiKey,
    configuration.postgresUrl,
    databaseUrl,
    adminPassword,
  ].reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), details);
}

try {
  await runAcceptance();
} catch (cause) {
  const diagnostics = [gateway, runner]
    .flatMap((process) => process?.diagnostic ? [`${process.name}:\n${process.diagnostic}`] : []);
  throw new Error(
    `Release acceptance failed.\nCause details:\n${sanitizedErrorDetails(cause)}${
      diagnostics.length === 0 ? "" : `\nSanitized process output:\n${diagnostics.join("\n---\n")}`
    }`,
    { cause },
  );
}
console.log("[acceptance] PASS: browser-to-Pi private GitHub lifecycle completed");
