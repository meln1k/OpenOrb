import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { delay } from "@std/async/delay";

import type {
  RunnerClientMessage,
  SessionEventPayload,
  SessionProvisionCommand,
} from "@openorb/protocol";
import { SessionEventRelay } from "@/src/session-event-relay.ts";
import { type ProvisioningRuntime, SessionProvisioner } from "@/src/session-provisioner.ts";
import { RunnerSessionStore } from "@/src/session-store.ts";
import { installLocalDeveloperImage } from "@/test/local-developer-image.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
const REPOSITORY_URL = "https://github.com/meln1k/openorb.git";
const BRANCH_NAME = "openorb/session-test";
const INITIAL_PROMPT = "Inspect the repository and report what you find.";
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const GITHUB_TOKEN = "github-secret-token";
const RUN_GONDOLIN_TESTS = Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") === "1";

interface FakeRuntimeOptions {
  cloneExitCode?: number;
  setupExitCode?: number;
  outputSecret?: string;
}

class FakeRuntime implements ProvisioningRuntime {
  readonly commands: string[][] = [];
  closed = false;
  readonly #options: FakeRuntimeOptions;

  constructor(options: FakeRuntimeOptions = {}) {
    this.#options = options;
  }

  run: ProvisioningRuntime["run"] = async (command, options) => {
    this.commands.push([...command]);
    if (command[1] === "clone") {
      if (this.#options.outputSecret) {
        await options?.onOutput?.({
          stream: "stderr",
          text: `remote output ${this.#options.outputSecret}\n`,
        });
      }
      return { exitCode: this.#options.cloneExitCode ?? 0 };
    }
    if (command[1] === "rev-parse") {
      await options?.onOutput?.({ stream: "stdout", text: `${BASE_COMMIT}\n` });
      return { exitCode: 0 };
    }
    if (command[1] === "switch") return { exitCode: 0 };
    if (command[0] === "/bin/sh") {
      await options?.onOutput?.({ stream: "stdout", text: "setup output\n" });
      return { exitCode: this.#options.setupExitCode ?? 0 };
    }
    throw new Error(`Unexpected guest command: ${command.join(" ")}`);
  };

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class PausingCloneRuntime implements ProvisioningRuntime {
  readonly paused = Promise.withResolvers<void>();
  readonly resumed = Promise.withResolvers<void>();

  run: ProvisioningRuntime["run"] = async (command, options) => {
    if (command[1] !== "clone") throw new Error(`Unexpected guest command: ${command.join(" ")}`);
    await options?.onOutput?.({ stream: "stderr", text: "before disconnect\n" });
    this.paused.resolve();
    await this.resumed.promise;
    await options?.onOutput?.({ stream: "stderr", text: "after reconnect\n" });
    return { exitCode: 128 };
  };

  close(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("durably accepts and provisions a repository entirely through the guest runtime", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const eventRelay = new SessionEventRelay(store);
    const runtime = new FakeRuntime({ outputSecret: GITHUB_TOKEN });
    let receivedToken: string | undefined;
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay,
      cpuCount: 4,
      memoryMiB: 8192,
      createRuntime(options) {
        receivedToken = options.github?.token;
        return Promise.resolve(runtime);
      },
    });
    const messages: RunnerClientMessage[] = [];
    const detach = await eventRelay.attach(
      (message) => messages.push(message),
      () => Promise.resolve(true),
    );

    await provisioner.handleCommand(createCommand(), (message) => messages.push(message));
    assertEquals(messages[0]?.type, "session.provision.accepted");
    const acceptedMetadata = await store.readMetadata(SESSION_ID);
    assertEquals(acceptedMetadata.state, "created");
    assertEquals(acceptedMetadata.initialPrompt, INITIAL_PROMPT);

    const metadata = await waitForState(store, "ready");
    assertEquals(receivedToken, GITHUB_TOKEN);
    assertEquals(metadata.checkoutState, "available");
    assertEquals(metadata.baseCommit, BASE_COMMIT);
    assertEquals(runtime.commands, [
      [
        "/usr/bin/git",
        "clone",
        "--no-recurse-submodules",
        "--branch",
        "main",
        "--single-branch",
        REPOSITORY_URL,
        ".",
      ],
      ["/usr/bin/git", "rev-parse", "HEAD"],
      ["/usr/bin/git", "switch", "-c", BRANCH_NAME],
      ["/bin/sh", "-lc", "if [ -x .agents/setup ]; then exec ./.agents/setup; fi"],
    ]);

    const events = await store.readEvents(SESSION_ID);
    const stages = events.flatMap((record) =>
      record.event.type === "session.state" ? [record.event.stage] : []
    );
    assertEquals(stages, ["starting-vm", "cloning", "creating-branch", "setup", "ready"]);
    const persisted = await readSessionText(workingDirectory);
    assert(!persisted.includes(GITHUB_TOKEN));
    assertStringIncludes(persisted, "[REDACTED]");
    assertEquals(messages.at(-1)?.type, "session.event");
    detach();
    await provisioner.close();
    assert(runtime.closed);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("keeps clone failure non-fatal and skips checkout-dependent setup", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const runtime = new FakeRuntime({ cloneExitCode: 128 });
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay: new SessionEventRelay(store),
      cpuCount: 2,
      memoryMiB: 4096,
      createRuntime: () => Promise.resolve(runtime),
    });

    await provisioner.handleCommand(createCommand(), () => {});
    const metadata = await waitForState(store, "ready");
    assertEquals(metadata.checkoutState, "unavailable");
    assertEquals(runtime.commands.length, 1);
    assertEquals(runtime.commands[0]?.slice(0, 2), ["/usr/bin/git", "clone"]);
    const persisted = await readSessionText(workingDirectory);
    assertStringIncludes(persisted, "Repository clone failed");
    await provisioner.close();
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("continues active provisioning through a replacement event consumer", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const eventRelay = new SessionEventRelay(store);
    const runtime = new PausingCloneRuntime();
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay,
      cpuCount: 2,
      memoryMiB: 4096,
      createRuntime: () => Promise.resolve(runtime),
    });
    const firstEvents: SessionEventPayload[] = [];
    const secondEvents: SessionEventPayload[] = [];
    const detachFirst = await eventRelay.attach(
      collectEvents(firstEvents),
      () => Promise.resolve(true),
    );

    await provisioner.handleCommand(createCommand(), () => {});
    await runtime.paused.promise;
    detachFirst();

    const detachSecond = await eventRelay.attach(collectEvents(secondEvents), async () => {
      secondEvents.push(...await eventRelay.readEvents(SESSION_ID));
      return true;
    });
    runtime.resumed.resolve();
    await waitForState(store, "ready");
    await delay(0);

    assertEquals(firstEvents.map((event) => event.cursor), [1, 2, 3]);
    assertEquals(secondEvents.map((event) => event.cursor), [1, 2, 3, 4, 5, 6]);
    assertEquals(
      (await store.readEvents(SESSION_ID)).map((event) => event.cursor),
      [1, 2, 3, 4, 5, 6],
    );

    detachSecond();
    await provisioner.close();
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("retries fatal setup failure in a fresh VM without replacing stored prompt", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const firstRuntime = new FakeRuntime({ setupExitCode: 7 });
    const secondRuntime = new FakeRuntime();
    const runtimes = [firstRuntime, secondRuntime];
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay: new SessionEventRelay(store),
      cpuCount: 4,
      memoryMiB: 8192,
      createRuntime: () => {
        const runtime = runtimes.shift();
        if (!runtime) throw new Error("No fake runtime remains.");
        return Promise.resolve(runtime);
      },
    });
    const messages: RunnerClientMessage[] = [];

    await provisioner.handleCommand(createCommand(), (message) => messages.push(message));
    await waitForFailedEvent(store);
    await delay(0);
    await provisioner.handleCommand(retryCommand(), (message) => messages.push(message));
    const metadata = await waitForState(store, "ready");

    assert(firstRuntime.closed);
    assertEquals(secondRuntime.commands, [
      ["/bin/sh", "-lc", "if [ -x .agents/setup ]; then exec ./.agents/setup; fi"],
    ]);
    assertEquals(metadata.initialPrompt, INITIAL_PROMPT);
    assertEquals(metadata.checkoutState, "available");
    assertEquals(metadata.baseCommit, BASE_COMMIT);
    assertEquals(
      messages.filter((message) => message.type === "session.provision.accepted").length,
      2,
    );
    await provisioner.close();
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test({
  name: "real public repository provisioning clones and creates the branch inside Gondolin",
  ignore: !RUN_GONDOLIN_TESTS,
  async fn() {
    const workingDirectory = await Deno.makeTempDir();
    let provisioner: SessionProvisioner | undefined;
    try {
      const store = await createStore(workingDirectory);
      provisioner = new SessionProvisioner({
        sessionStore: store,
        eventRelay: new SessionEventRelay(store),
        developerImage: await installLocalDeveloperImage(workingDirectory),
        cpuCount: 1,
        memoryMiB: 512,
      });
      const branchName = `openorb/oo-012-${crypto.randomUUID()}`;
      const command: SessionProvisionCommand = {
        version: 1,
        id: crypto.randomUUID(),
        type: "session.provision",
        sessionId: SESSION_ID,
        payload: {
          mode: "create",
          projectId: PROJECT_ID,
          repositoryUrl: "https://github.com/octocat/Hello-World.git",
          ref: "master",
          branchName,
          initialPrompt: INITIAL_PROMPT,
        },
      };
      const messages: RunnerClientMessage[] = [];

      await provisioner.handleCommand(command, (message) => messages.push(message));
      assertEquals(messages[0]?.type, "session.provision.accepted");
      const metadata = await waitForState(store, "ready", 240_000);
      assertEquals(metadata.checkoutState, "available");
      assertEquals(
        await Deno.readTextFile(`${workingDirectory}/sessions/${SESSION_ID}/workspace/.git/HEAD`),
        `ref: refs/heads/${branchName}\n`,
      );
      const stages = (await store.readEvents(SESSION_ID)).flatMap((record) =>
        record.event.type === "session.state" ? [record.event.stage] : []
      );
      assertEquals(stages, ["starting-vm", "cloning", "creating-branch", "setup", "ready"]);
    } finally {
      await provisioner?.close();
      await Deno.remove(workingDirectory, { recursive: true });
    }
  },
});

async function createStore(workingDirectory: string): Promise<RunnerSessionStore> {
  const store = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
  await store.initialize();
  return store;
}

function createCommand(): SessionProvisionCommand {
  return {
    version: 1,
    id: "create-command",
    type: "session.provision",
    sessionId: SESSION_ID,
    payload: {
      mode: "create",
      projectId: PROJECT_ID,
      repositoryUrl: REPOSITORY_URL,
      ref: "main",
      branchName: BRANCH_NAME,
      initialPrompt: INITIAL_PROMPT,
      githubToken: GITHUB_TOKEN,
    },
  };
}

function retryCommand(): SessionProvisionCommand {
  return {
    version: 1,
    id: "retry-command",
    type: "session.provision",
    sessionId: SESSION_ID,
    payload: { mode: "retry", githubToken: GITHUB_TOKEN },
  };
}

async function waitForState(
  store: RunnerSessionStore,
  state: "ready" | "error",
  timeoutMs = 1_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = await store.readMetadata(SESSION_ID);
    if (metadata.state === state) return metadata;
    if (state === "ready" && metadata.state === "error") {
      throw new Error(
        `Session provisioning failed: ${JSON.stringify(await store.readEvents(SESSION_ID))}`,
      );
    }
    await delay(10);
  }
  throw new Error(`Session did not reach ${state}.`);
}

async function waitForFailedEvent(
  store: RunnerSessionStore,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await store.readEvents(SESSION_ID);
    if (
      events.some((record) =>
        record.event.type === "session.state" && record.event.stage === "failed"
      )
    ) {
      return;
    }
    await delay(10);
  }
  throw new Error("Session did not emit failed.");
}

async function readSessionText(workingDirectory: string): Promise<string> {
  const sessionDirectory = `${workingDirectory}/sessions/${SESSION_ID}`;
  let text = "";
  for await (const entry of Deno.readDir(sessionDirectory)) {
    if (!entry.isFile) continue;
    text += await Deno.readTextFile(`${sessionDirectory}/${entry.name}`);
  }
  return text;
}

function collectEvents(events: SessionEventPayload[]) {
  return (message: RunnerClientMessage) => {
    if (message.type === "session.event") events.push(message.payload);
  };
}
