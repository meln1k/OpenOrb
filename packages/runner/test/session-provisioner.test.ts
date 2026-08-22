import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { delay } from "@std/async/delay";

import type {
  RunnerClientMessage,
  SessionEventPayload,
  SessionProvisionCommand,
} from "@openorb/protocol";
import { err, ok, type Result } from "@openorb/result";
import { SessionEventRelay } from "@/src/session-event-relay.ts";
import { GondolinRuntimeError } from "@/src/gondolin-tools.ts";
import { type ProvisioningRuntime, SessionProvisioner } from "@/src/session-provisioner.ts";
import { RunnerSessionStore, RunnerSessionStoreError } from "@/src/session-store.ts";
import { installLocalDeveloperImage } from "@/test/local-developer-image.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { OpenOrbPiSessionOptions } from "@/src/pi-session-factory.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
const REPOSITORY_URL = "https://github.com/meln1k/openorb.git";
const BRANCH_NAME = "openorb/session-test";
const INITIAL_PROMPT = "Inspect the repository and report what you find.";
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const GITHUB_TOKEN = "github-secret-token";
const MODEL_PROVIDER_KEY = "model-provider-secret-key";
const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: MODEL_PROVIDER_KEY },
};
const RUN_GONDOLIN_TESTS = Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") === "1";

interface FakeRuntimeOptions {
  cloneExitCode?: number;
  setupExitCode?: number;
  outputSecret?: string;
}

class FakeRuntime implements ProvisioningRuntime {
  readonly tools = [];
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
      return ok({ exitCode: this.#options.cloneExitCode ?? 0 });
    }
    if (command[1] === "rev-parse") {
      await options?.onOutput?.({ stream: "stdout", text: `${BASE_COMMIT}\n` });
      return ok({ exitCode: 0 });
    }
    if (command[1] === "switch") return ok({ exitCode: 0 });
    if (command[0] === "/bin/sh") {
      await options?.onOutput?.({ stream: "stdout", text: "setup output\n" });
      return ok({ exitCode: this.#options.setupExitCode ?? 0 });
    }
    throw new Error(`Unexpected guest command: ${command.join(" ")}`);
  };

  close(): Promise<Result<void, never>> {
    this.closed = true;
    return Promise.resolve(ok(undefined));
  }
}

class PausingCloneRuntime implements ProvisioningRuntime {
  readonly tools = [];
  readonly paused = Promise.withResolvers<void>();
  readonly resumed = Promise.withResolvers<void>();

  run: ProvisioningRuntime["run"] = async (command, options) => {
    if (command[1] !== "clone") throw new Error(`Unexpected guest command: ${command.join(" ")}`);
    await options?.onOutput?.({ stream: "stderr", text: "before disconnect\n" });
    this.paused.resolve();
    await this.resumed.promise;
    await options?.onOutput?.({ stream: "stderr", text: "after reconnect\n" });
    return ok({ exitCode: 128 });
  };

  close(): Promise<Result<void, never>> {
    return Promise.resolve(ok(undefined));
  }
}

Deno.test("durably accepts and provisions a repository entirely through the guest runtime", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const eventRelay = new SessionEventRelay(store);
    const runtime = new FakeRuntime({ outputSecret: GITHUB_TOKEN });
    let receivedToken: string | undefined;
    let receivedCpuCount: number | undefined;
    let receivedMemoryMiB: number | undefined;
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay,
      cpuCount: 4,
      memoryMiB: 8192,
      createRuntime(options) {
        receivedToken = options.github?.token;
        receivedCpuCount = options.cpuCount;
        receivedMemoryMiB = options.memoryMiB;
        return Promise.resolve(ok(runtime));
      },
      createPiSession: createFakePiSession,
    });
    const messages: RunnerClientMessage[] = [];
    const events: SessionEventPayload[] = [];
    const collectMessage = (message: RunnerClientMessage) => {
      messages.push(message);
      if (message.type === "session.event") events.push(message.payload);
    };
    const detach = success(
      await eventRelay.attach(
        collectMessage,
        () => Promise.resolve(ok(true)),
      ),
    );

    success(await provisioner.handleCommand(createCommand(), collectMessage));
    assertEquals(messages[0]?.type, "session.provision.accepted");
    const acceptedMetadata = success(await store.readMetadata(SESSION_ID));
    assertEquals(acceptedMetadata.state, "created");
    assertEquals(acceptedMetadata.initialPrompt, INITIAL_PROMPT);

    const metadata = await waitForState(store, "ready");
    await waitForEventType(events, "session.state", "ready");
    assertEquals(receivedToken, GITHUB_TOKEN);
    assertEquals(receivedCpuCount, 2);
    assertEquals(receivedMemoryMiB, 4096);
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

    const stages = messages.flatMap((message) =>
      message.type === "session.event" && message.payload.event.type === "session.state"
        ? [message.payload.event.stage]
        : []
    );
    assertEquals(stages, [
      "starting-vm",
      "cloning",
      "creating-branch",
      "setup",
      "running",
      "ready",
    ]);
    const persisted = await readSessionText(workingDirectory);
    assert(!persisted.includes(GITHUB_TOKEN));
    assert(!persisted.includes(MODEL_PROVIDER_KEY));
    assert(!persisted.includes("remote output"));
    assert(
      messages.some((message) =>
        message.type === "session.event" &&
        message.payload.event.type === "provisioning.log" &&
        message.payload.event.text.includes("[REDACTED]")
      ),
    );
    assertEquals(messages.at(-1)?.type, "session.event");
    detach();
    success(await provisioner.close());
    assert(runtime.closed);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("rejects an orb size above runner capacity before creating session state", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    let runtimeCreated = false;
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay: new SessionEventRelay(store),
      cpuCount: 1,
      memoryMiB: 2048,
      createRuntime: () => {
        runtimeCreated = true;
        return Promise.resolve(ok(new FakeRuntime()));
      },
      createPiSession: createFakePiSession,
    });
    const messages: RunnerClientMessage[] = [];

    success(await provisioner.handleCommand(createCommand(), (message) => messages.push(message)));

    assertEquals(messages[0]?.type, "session.provision.rejected");
    assert(
      messages[0]?.type === "session.provision.rejected" &&
        messages[0].payload.message.includes("small orb size"),
    );
    assertEquals(runtimeCreated, false);
    assertEquals(provisioner.activeSessionCount, 0);
    const [, metadataError] = await store.readMetadata(SESSION_ID);
    assert(metadataError);
    success(await provisioner.close());
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("retries with the orb size stored by the original create command", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const runtime = new FakeRuntime();
    const resources: Array<{ cpuCount: number | undefined; memoryMiB: number | undefined }> = [];
    let attempt = 0;
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay: new SessionEventRelay(store),
      cpuCount: 4,
      memoryMiB: 8192,
      createRuntime: (options) => {
        resources.push({ cpuCount: options.cpuCount, memoryMiB: options.memoryMiB });
        attempt++;
        return attempt === 1
          ? Promise.resolve(
            err(new GondolinRuntimeError("Could not create the first runtime.", undefined)),
          )
          : Promise.resolve(ok(runtime));
      },
      createPiSession: createFakePiSession,
    });

    success(await provisioner.handleCommand(createCommand(), () => {}));
    await waitForState(store, "error");
    await delay(0);
    success(
      await provisioner.handleCommand({
        ...createCommand(),
        id: "retry-command",
        payload: {
          mode: "retry",
          modelRuntime: MODEL_RUNTIME,
          githubToken: GITHUB_TOKEN,
        },
      }, () => {}),
    );
    const metadata = await waitForState(store, "ready");

    assertEquals(metadata.orbSize, "small");
    assertEquals(resources, [
      { cpuCount: 2, memoryMiB: 4096 },
      { cpuCount: 2, memoryMiB: 4096 },
    ]);
    success(await provisioner.close());
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("keeps clone failure non-fatal and skips checkout-dependent setup", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const runtime = new FakeRuntime({ cloneExitCode: 128 });
    const eventRelay = new SessionEventRelay(store);
    const messages: RunnerClientMessage[] = [];
    const detach = success(
      await eventRelay.attach((message) => messages.push(message), () => Promise.resolve(ok(true))),
    );
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay,
      cpuCount: 2,
      memoryMiB: 4096,
      createRuntime: () => Promise.resolve(ok(runtime)),
      createPiSession: createFakePiSession,
    });

    success(await provisioner.handleCommand(createCommand(), () => {}));
    const metadata = await waitForState(store, "ready");
    assertEquals(metadata.checkoutState, "unavailable");
    assertEquals(runtime.commands.length, 1);
    assertEquals(runtime.commands[0]?.slice(0, 2), ["/usr/bin/git", "clone"]);
    assert(
      messages.some((message) =>
        message.type === "session.event" &&
        message.payload.event.type === "provisioning.log" &&
        message.payload.event.text.includes("Repository clone failed")
      ),
    );
    detach();
    success(await provisioner.close());
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("a terminal Pi error marks the session failed and disposes Pi", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const runtime = new FakeRuntime();
    const eventRelay = new SessionEventRelay(store);
    const messages: RunnerClientMessage[] = [];
    const detach = success(
      await eventRelay.attach((message) => messages.push(message), () => Promise.resolve(ok(true))),
    );
    let piDisposed = false;
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay,
      cpuCount: 2,
      memoryMiB: 4096,
      createRuntime: () => Promise.resolve(ok(runtime)),
      createPiSession: () => {
        let listener: (event: AgentSessionEvent) => void = () => {};
        return Promise.resolve({
          session: {
            sessionManager: EMPTY_PI_SESSION_MANAGER,
            subscribe(nextListener: (event: AgentSessionEvent) => void) {
              listener = nextListener;
              return () => {
                listener = () => {};
              };
            },
            prompt() {
              const failed = assistantMessage(
                [],
                "error",
                `Provider rejected ${MODEL_PROVIDER_KEY}`,
              );
              listener({ type: "message_start", message: failed });
              listener({ type: "message_end", message: failed });
              return Promise.resolve();
            },
            dispose() {
              piDisposed = true;
            },
          },
        });
      },
    });

    success(await provisioner.handleCommand(createCommand(), () => {}));
    const metadata = await waitForState(store, "error");
    await delay(0);

    assertEquals(metadata.state, "error");
    assert(piDisposed);
    assertEquals(
      messages.some((message) =>
        message.type === "session.event" && message.payload.event.type === "session.state" &&
        message.payload.event.stage === "ready"
      ),
      false,
    );
    assert(!JSON.stringify(messages).includes(MODEL_PROVIDER_KEY));

    detach();
    success(await provisioner.close());
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("releases capacity when provisioning failure recovery also fails", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const originalReadMetadata = store.readMetadata.bind(store);
    const recoveryRead = Promise.withResolvers<void>();
    let failMetadataRead = false;
    store.readMetadata = (sessionId) => {
      if (!failMetadataRead) return originalReadMetadata(sessionId);
      recoveryRead.resolve();
      return Promise.resolve(
        err(
          new RunnerSessionStoreError(
            "read-metadata",
            "Provisioning failure recovery could not read metadata.",
            undefined,
          ),
        ),
      );
    };
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay: new SessionEventRelay(store),
      cpuCount: 2,
      memoryMiB: 4096,
      createRuntime: () => {
        failMetadataRead = true;
        return Promise.resolve(
          err(new GondolinRuntimeError("Could not create the test runtime.", undefined)),
        );
      },
      createPiSession: createFakePiSession,
    });

    success(await provisioner.handleCommand(createCommand(), () => {}));
    await recoveryRead.promise;
    await delay(0);

    assertEquals(provisioner.activeSessionCount, 0);
    success(await provisioner.close());
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
      createRuntime: () => Promise.resolve(ok(runtime)),
      createPiSession: createFakePiSession,
    });
    const firstEvents: SessionEventPayload[] = [];
    const secondEvents: SessionEventPayload[] = [];
    const detachFirst = success(
      await eventRelay.attach(
        collectEvents(firstEvents),
        () => Promise.resolve(ok(true)),
      ),
    );

    success(await provisioner.handleCommand(createCommand(), () => {}));
    await runtime.paused.promise;
    detachFirst();

    const detachSecond = success(
      await eventRelay.attach(collectEvents(secondEvents), () => Promise.resolve(ok(true))),
    );
    success(
      await eventRelay.replayEvents(SESSION_ID, 0, (event) => {
        secondEvents.push(event);
      }),
    );
    runtime.resumed.resolve();
    await waitForState(store, "ready");
    await waitForEventType(secondEvents, "session.state", "ready");

    assert(firstEvents.some((event) => event.event.type === "provisioning.log"));
    assert(secondEvents.some((event) => event.event.type === "conversation.reset"));
    assert(
      secondEvents.some((event) =>
        event.event.type === "session.state" && event.event.stage === "ready"
      ),
    );
    assertEquals(success(await eventRelay.readEvents(SESSION_ID)), []);

    detachSecond();
    success(await provisioner.close());
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("maps replay callback failures to a relay domain error", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    success(
      await store.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        repositoryUrl: REPOSITORY_URL,
        ref: "main",
        branchName: BRANCH_NAME,
        initialPrompt: INITIAL_PROMPT,
        model: "opencode-go/deepseek-v4-flash",
        orbSize: "medium",
      }),
    );
    const relay = new SessionEventRelay(store);
    const cause = new Error("consumer failed");

    const [, replayError] = await relay.replayEvents(SESSION_ID, 0, () => {
      throw cause;
    });

    assert(replayError);
    assertEquals(replayError.message, "Could not reset replayed conversation state.");
    assertStrictEquals(replayError.cause, cause);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("resumes Pi replay after a known cursor and resets a stale cursor", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    success(
      await store.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        repositoryUrl: REPOSITORY_URL,
        ref: "main",
        branchName: BRANCH_NAME,
        initialPrompt: INITIAL_PROMPT,
        model: "opencode-go/deepseek-v4-flash",
        orbSize: "medium",
      }),
    );
    const paths = success(await store.getSessionPiPaths(SESSION_ID));
    const pi = SessionManager.open(paths.sessionFile, undefined, "/workspace");
    pi.appendMessage({ role: "user", content: "First", timestamp: 1 });
    const secondMessageId = pi.appendMessage({ role: "user", content: "Second", timestamp: 2 });
    const relay = new SessionEventRelay(store);

    const resumed: SessionEventPayload[] = [];
    assertEquals(
      success(
        await relay.replayEvents(SESSION_ID, 1, (event) => {
          resumed.push(event);
        }),
      ),
      2,
    );
    assertEquals(resumed, [{
      cursor: 2,
      event: { type: "user.message", messageId: secondMessageId, text: "Second" },
    }]);

    const reset: SessionEventPayload[] = [];
    assertEquals(
      success(
        await relay.replayEvents(SESSION_ID, 3, (event) => {
          reset.push(event);
        }),
      ),
      2,
    );
    assertEquals(reset.map((event) => "cursor" in event ? event.cursor : event.event.type), [
      "conversation.reset",
      1,
      2,
    ]);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("delivers live activity only after an in-flight Pi replay completes", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    success(
      await store.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        repositoryUrl: REPOSITORY_URL,
        ref: "main",
        branchName: BRANCH_NAME,
        initialPrompt: INITIAL_PROMPT,
        model: "opencode-go/deepseek-v4-flash",
        orbSize: "medium",
      }),
    );
    const relay = new SessionEventRelay(store);
    const liveEvents: SessionEventPayload[] = [];
    const deliveryOrder: string[] = [];
    const detach = success(
      await relay.attach((message) => {
        if (message.type !== "session.event") return;
        liveEvents.push(message.payload);
        deliveryOrder.push("live");
      }, () => Promise.resolve(ok(true))),
    );
    const replayPaused = Promise.withResolvers<void>();
    const resumeReplay = Promise.withResolvers<void>();
    const replayEvents: SessionEventPayload[] = [];

    const replay = relay.replayEvents(
      SESSION_ID,
      0,
      async (event) => {
        replayEvents.push(event);
        deliveryOrder.push("replay");
        replayPaused.resolve();
        await resumeReplay.promise;
      },
      () => {
        deliveryOrder.push("complete");
      },
    );
    await replayPaused.promise;
    const live = relay.publishLive(SESSION_ID, "run-1", { type: "agent.started" });
    await delay(0);
    assertEquals(liveEvents, []);

    resumeReplay.resolve();
    assertEquals(success(await replay), 0);
    success(await live);
    assertEquals(replayEvents.map((event) => event.event.type), ["conversation.reset"]);
    assertEquals(liveEvents.map((event) => event.event.type), ["agent.started"]);
    assertEquals(deliveryOrder, ["replay", "complete", "live"]);

    detach();
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("continues to Pi when repository setup fails", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const runtime = new FakeRuntime({ setupExitCode: 7 });
    const eventRelay = new SessionEventRelay(store);
    let promptCalls = 0;
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay,
      cpuCount: 4,
      memoryMiB: 8192,
      createRuntime: () => Promise.resolve(ok(runtime)),
      createPiSession: () => {
        return Promise.resolve({
          session: {
            sessionManager: EMPTY_PI_SESSION_MANAGER,
            subscribe() {
              return () => {};
            },
            prompt() {
              promptCalls += 1;
              return Promise.resolve();
            },
            dispose() {},
          },
        });
      },
    });
    const messages: RunnerClientMessage[] = [];
    const detach = success(
      await eventRelay.attach((message) => messages.push(message), () => Promise.resolve(ok(true))),
    );

    success(await provisioner.handleCommand(createCommand(), (message) => messages.push(message)));
    const metadata = await waitForState(store, "ready");

    assertEquals(promptCalls, 1);
    assertEquals(metadata.initialPrompt, INITIAL_PROMPT);
    assertEquals(metadata.checkoutState, "available");
    assertEquals(metadata.baseCommit, BASE_COMMIT);
    assert(
      messages.some((message) =>
        message.type === "session.event" && message.payload.event.type === "provisioning.log" &&
        message.payload.event.text.includes("continuing to Pi")
      ),
    );
    detach();
    success(await provisioner.close());
    assert(runtime.closed);
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
        memoryMiB: 2048,
        createPiSession: createFakePiSession,
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
          orbSize: "tiny",
          initialPrompt: INITIAL_PROMPT,
          modelRuntime: MODEL_RUNTIME,
        },
      };
      const messages: RunnerClientMessage[] = [];

      success(await provisioner.handleCommand(command, (message) => messages.push(message)));
      assertEquals(messages[0]?.type, "session.provision.accepted");
      const metadata = await waitForState(store, "ready", 240_000);
      assertEquals(metadata.checkoutState, "available");
      assertEquals(
        await Deno.readTextFile(`${workingDirectory}/sessions/${SESSION_ID}/workspace/.git/HEAD`),
        `ref: refs/heads/${branchName}\n`,
      );
    } finally {
      if (provisioner) success(await provisioner.close());
      await Deno.remove(workingDirectory, { recursive: true });
    }
  },
});

async function createStore(workingDirectory: string): Promise<RunnerSessionStore> {
  const store = new RunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID });
  success(await store.initialize());
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
      orbSize: "small",
      initialPrompt: INITIAL_PROMPT,
      modelRuntime: MODEL_RUNTIME,
      githubToken: GITHUB_TOKEN,
    },
  };
}

async function waitForState(
  store: RunnerSessionStore,
  state: "ready" | "error",
  timeoutMs = 1_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = success(await store.readMetadata(SESSION_ID));
    if (metadata.state === state) return metadata;
    if (state === "ready" && metadata.state === "error") {
      throw new Error("Session provisioning failed.");
    }
    await delay(10);
  }
  throw new Error(`Session did not reach ${state}.`);
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

async function waitForEventType(
  events: SessionEventPayload[],
  type: SessionEventPayload["event"]["type"],
  stage: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    !events.some((event) =>
      event.event.type === type && "stage" in event.event && event.event.stage === stage
    )
  ) {
    if (Date.now() >= deadline) throw new Error(`Session event ${type} was not delivered.`);
    await delay(10);
  }
}

function createFakePiSession(_options: OpenOrbPiSessionOptions) {
  return Promise.resolve({
    session: {
      sessionManager: EMPTY_PI_SESSION_MANAGER,
      subscribe(_listener: (event: AgentSessionEvent) => void) {
        return () => {};
      },
      prompt(_input: string) {
        return Promise.resolve();
      },
      dispose() {},
    },
  });
}

const EMPTY_PI_SESSION_MANAGER = {
  getLeafEntry: () => undefined,
};

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0,
  };
}

function success<T, E>(result: Result<T, E>): T {
  const [value, error] = result;
  if (error !== undefined) throw error;
  // SAFETY: The Result success variant always contains T when the error slot is undefined.
  return value as T;
}
