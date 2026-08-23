import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { delay } from "@std/async/delay";

import type {
  RunnerClientMessage,
  SessionAbortCommand,
  SessionEventPayload,
  SessionPromptCommand,
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
import { eventsFromPiEntries } from "@/src/pi-session-history.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const PROJECT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";
const REPOSITORY_URL = "https://github.com/meln1k/openorb.git";
const BRANCH_NAME = "openorb/session-test";
const INITIAL_PROMPT = "Inspect the repository and report what you find.";
const CONTINUATION_PROMPT = "Continue with the implementation.";
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

Deno.test("abort clears queued follow-ups, rejects new prompts, and cannot hit a settled run", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const eventRelay = new SessionEventRelay(store);
    const runtime = new FakeRuntime();
    const messages: RunnerClientMessage[] = [];
    const events: SessionEventPayload[] = [];
    const promptStarted = Promise.withResolvers<void>();
    const finishPrompt = Promise.withResolvers<void>();
    const promptSettled = Promise.withResolvers<void>();
    const completeAbort = Promise.withResolvers<void>();
    const queuedFollowUps: string[] = [];
    const abortCalls: string[] = [];
    let listener: (event: AgentSessionEvent) => void = () => {};
    let active = false;
    const detach = success(
      await eventRelay.attach((message) => {
        messages.push(message);
        if (message.type === "session.event") events.push(message.payload);
      }, () => Promise.resolve(ok(true))),
    );
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay,
      cpuCount: 2,
      memoryMiB: 4096,
      createRuntime: () => Promise.resolve(ok(runtime)),
      createPiSession: () =>
        Promise.resolve({
          session: {
            get isIdle() {
              return !active;
            },
            sessionManager: EMPTY_PI_SESSION_MANAGER,
            subscribe(nextListener: (event: AgentSessionEvent) => void) {
              listener = nextListener;
              return () => {
                listener = () => {};
              };
            },
            async prompt(
              _input: string,
              options?: { preflightResult?: (success: boolean) => void },
            ) {
              active = true;
              options?.preflightResult?.(true);
              promptStarted.resolve();
              await finishPrompt.promise;
              listener({ type: "message_end", message: assistantMessage([], "aborted") });
              active = false;
              promptSettled.resolve();
            },
            followUp(input: string) {
              queuedFollowUps.push(input);
              listener({
                type: "queue_update",
                steering: [],
                followUp: [...queuedFollowUps],
              });
              return Promise.resolve();
            },
            clearQueue() {
              abortCalls.push("clearQueue");
              const followUp = queuedFollowUps.splice(0);
              listener({ type: "queue_update", steering: [], followUp: [] });
              return { steering: [], followUp };
            },
            async abort() {
              abortCalls.push("abort");
              await completeAbort.promise;
              finishPrompt.resolve();
              await promptSettled.promise;
            },
            dispose() {},
          },
        }),
    });

    success(await provisioner.handleCommand(createCommand(), (message) => messages.push(message)));
    await promptStarted.promise;
    await waitForEventType(events, "session.state", "running");
    assertEquals(provisioner.getActiveRunId(SESSION_ID), "create-command");
    const firstFollowUp = promptCommand("abort-follow-up-1", "First queued follow-up");
    const secondFollowUp = promptCommand("abort-follow-up-2", "Second queued follow-up");
    success(
      await provisioner.handlePromptCommand(firstFollowUp, (message) => messages.push(message)),
    );
    success(
      await provisioner.handlePromptCommand(secondFollowUp, (message) => messages.push(message)),
    );
    assertEquals(queuedFollowUps, ["First queued follow-up", "Second queued follow-up"]);

    const racedFollowUp = promptCommand("abort-follow-up-3", "Follow-up racing Abort");
    const abort = abortCommand("abort-active", "create-command");
    const [racedFollowUpResult, abortResult] = await Promise.all([
      provisioner.handlePromptCommand(racedFollowUp, (message) => messages.push(message)),
      provisioner.handleAbortCommand(abort, (message) => messages.push(message)),
    ]);
    success(racedFollowUpResult);
    success(abortResult);
    assertEquals(abortCalls, ["clearQueue", "abort"]);
    assertEquals(queuedFollowUps, []);
    assert(
      messages.some((message) =>
        message.type === "session.prompt.accepted" &&
        message.correlationId === racedFollowUp.id
      ),
    );
    assert(
      messages.some((message) =>
        message.type === "session.abort.accepted" && message.correlationId === abort.id
      ),
    );

    const whileAborting = promptCommand("prompt-while-aborting", "Do not accept this prompt");
    const duplicateAbort = abortCommand("duplicate-abort", "create-command");
    const [duplicateAbortResult, whileAbortingResult] = await Promise.all([
      provisioner.handleAbortCommand(duplicateAbort, (message) => messages.push(message)),
      provisioner.handlePromptCommand(whileAborting, (message) => messages.push(message)),
    ]);
    success(duplicateAbortResult);
    success(whileAbortingResult);
    assert(
      messages.some((message) =>
        message.type === "session.abort.rejected" &&
        message.correlationId === duplicateAbort.id &&
        message.payload.message === "That Pi run is no longer active."
      ),
    );
    assert(
      messages.some((message) =>
        message.type === "session.prompt.rejected" &&
        message.correlationId === whileAborting.id && message.payload.message ===
          "The session is aborting."
      ),
    );

    completeAbort.resolve();
    await waitForState(store, "ready");
    const staleAbort = abortCommand("stale-abort", "create-command");
    success(await provisioner.handleAbortCommand(staleAbort, (message) => messages.push(message)));
    assert(
      messages.some((message) =>
        message.type === "session.abort.rejected" &&
        message.correlationId === staleAbort.id &&
        message.payload.message === "That Pi run is no longer active."
      ),
    );
    const queueUpdates = messages.flatMap((message) =>
      message.type === "session.event" && message.payload.event.type === "queue.updated"
        ? [message.payload.event.followUp]
        : []
    );
    assertEquals(queueUpdates, [
      ["First queued follow-up"],
      ["First queued follow-up", "Second queued follow-up"],
      ["First queued follow-up", "Second queued follow-up", "Follow-up racing Abort"],
      [],
    ]);

    detach();
    success(await provisioner.close());
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("reopens the same Pi JSONL and retained runtime for an accepted continuation", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await createStore(workingDirectory);
    const eventRelay = new SessionEventRelay(store);
    const runtime = new FakeRuntime();
    const messages: RunnerClientMessage[] = [];
    const contexts: Array<ReturnType<SessionManager["buildSessionContext"]>> = [];
    const piOptions: OpenOrbPiSessionOptions[] = [];
    const promptInputs: string[] = [];
    const followUpInputs: string[] = [];
    const pendingFollowUps: string[] = [];
    const continuationStarted = Promise.withResolvers<void>();
    const finishContinuation = Promise.withResolvers<void>();
    let runtimeCreations = 0;
    let piIdle = true;
    const detach = success(
      await eventRelay.attach((message) => messages.push(message), () => Promise.resolve(ok(true))),
    );
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay,
      cpuCount: 4,
      memoryMiB: 8192,
      createRuntime: () => {
        runtimeCreations += 1;
        return Promise.resolve(ok(runtime));
      },
      createPiSession(options) {
        piOptions.push(options);
        const sessionManager = SessionManager.open(
          options.runnerSessionFile,
          undefined,
          "/workspace",
        );
        contexts.push(sessionManager.buildSessionContext());
        const idle = piIdle;
        let active = false;
        let listener: (event: AgentSessionEvent) => void = () => {};
        return Promise.resolve({
          session: {
            get isIdle() {
              return idle && !active;
            },
            sessionManager,
            subscribe(nextListener: (event: AgentSessionEvent) => void) {
              listener = nextListener;
              return () => {
                listener = () => {};
              };
            },
            async prompt(
              input: string,
              promptOptions?: { preflightResult?: (success: boolean) => void },
            ) {
              active = true;
              try {
                promptInputs.push(input);
                promptOptions?.preflightResult?.(true);
                if (input === CONTINUATION_PROMPT) {
                  continuationStarted.resolve();
                  await finishContinuation.promise;
                }
                const userMessage = {
                  role: "user" as const,
                  content: input,
                  timestamp: Date.now(),
                };
                sessionManager.appendMessage(userMessage);
                listener({ type: "message_end", message: userMessage });
                await Promise.resolve();
                const answer = assistantMessage([
                  {
                    type: "text",
                    text: input === INITIAL_PROMPT ? "Initial answer" : "Continuation answer",
                  },
                ], "stop");
                sessionManager.appendMessage(answer);
                listener({ type: "message_end", message: answer });
                await Promise.resolve();
                while (pendingFollowUps.length > 0) {
                  const followUp = pendingFollowUps.shift()!;
                  listener({
                    type: "queue_update",
                    steering: [],
                    followUp: [...pendingFollowUps],
                  });
                  const followUpMessage = {
                    role: "user" as const,
                    content: followUp,
                    timestamp: Date.now(),
                  };
                  sessionManager.appendMessage(followUpMessage);
                  listener({ type: "message_end", message: followUpMessage });
                  const followUpAnswer = assistantMessage([
                    { type: "text", text: `Follow-up answer: ${followUp}` },
                  ], "stop");
                  sessionManager.appendMessage(followUpAnswer);
                  listener({ type: "message_end", message: followUpAnswer });
                  await Promise.resolve();
                }
              } finally {
                active = false;
              }
            },
            followUp(input: string) {
              followUpInputs.push(input);
              pendingFollowUps.push(input);
              listener({
                type: "queue_update",
                steering: [],
                followUp: [...pendingFollowUps],
              });
              return Promise.resolve();
            },
            clearQueue() {
              const followUp = pendingFollowUps.splice(0);
              listener({ type: "queue_update", steering: [], followUp: [] });
              return { steering: [], followUp };
            },
            abort: () => Promise.resolve(),
            dispose() {},
          },
        });
      },
    });

    success(await provisioner.handleCommand(createCommand(), (message) => messages.push(message)));
    await waitForState(store, "ready");
    await delay(0);
    const piPaths = success(await store.getSessionPiPaths(SESSION_ID));
    assertEquals(runtimeCreations, 1);
    assertEquals(promptInputs, [INITIAL_PROMPT]);

    piIdle = false;
    const idleRejection = promptCommand("pi-busy", "Reject while Pi is busy");
    success(
      await provisioner.handlePromptCommand(idleRejection, (message) => messages.push(message)),
    );
    assert(
      messages.some((message) =>
        message.type === "session.prompt.rejected" &&
        message.correlationId === idleRejection.id &&
        message.payload.message === "Pi did not accept the prompt."
      ),
    );
    assertEquals(success(await store.readMetadata(SESSION_ID)).state, "ready");
    await delay(0);

    piIdle = true;
    const continuationRuntime = {
      ...MODEL_RUNTIME,
      credential: { type: "api_key" as const, value: "current-model-provider-key" },
    };
    const continuation = provisioner.handlePromptCommand(
      promptCommand("continue-command", CONTINUATION_PROMPT, continuationRuntime),
      (message) => messages.push(message),
    );
    await continuationStarted.promise;
    success(await continuation);
    assert(
      messages.some((message) =>
        message.type === "session.prompt.accepted" &&
        message.correlationId === "continue-command"
      ),
    );
    assertEquals(success(await store.readMetadata(SESSION_ID)).state, "running");

    const staleInitialAbort = abortCommand("stale-initial-abort", "create-command");
    success(
      await provisioner.handleAbortCommand(
        staleInitialAbort,
        (message) => messages.push(message),
      ),
    );
    assert(
      messages.some((message) =>
        message.type === "session.abort.rejected" &&
        message.correlationId === staleInitialAbort.id &&
        message.payload.message === "That Pi run is no longer active."
      ),
    );
    assertEquals(provisioner.getActiveRunId(SESSION_ID), "continue-command");

    const concurrent = promptCommand("concurrent-command", "Queue this follow-up");
    const secondFollowUp = promptCommand("second-follow-up", "Queue this second follow-up");
    const [firstFollowUpResult, secondFollowUpResult] = await Promise.all([
      provisioner.handlePromptCommand(concurrent, (message) => messages.push(message)),
      provisioner.handlePromptCommand(secondFollowUp, (message) => messages.push(message)),
    ]);
    success(firstFollowUpResult);
    success(secondFollowUpResult);
    assert(
      messages.some((message) =>
        message.type === "session.prompt.accepted" && message.correlationId === concurrent.id
      ),
    );
    assert(
      messages.some((message) =>
        message.type === "session.prompt.accepted" && message.correlationId === secondFollowUp.id
      ),
    );
    assertEquals(followUpInputs, ["Queue this follow-up", "Queue this second follow-up"]);

    finishContinuation.resolve();
    await waitForState(store, "ready");
    await waitForEventType(
      messages.flatMap((message) => message.type === "session.event" ? [message.payload] : []),
      "session.state",
      "ready",
    );
    await delay(0);

    assertEquals(runtimeCreations, 1);
    assertEquals(runtime.commands.length, 4);
    assertEquals(promptInputs, [INITIAL_PROMPT, CONTINUATION_PROMPT]);
    assertEquals(piOptions.map((options) => options.runnerSessionFile), [
      piPaths.sessionFile,
      piPaths.sessionFile,
      piPaths.sessionFile,
    ]);
    assertEquals(piOptions.map((options) => options.runnerAgentDirectory), [
      piPaths.agentDirectory,
      piPaths.agentDirectory,
      piPaths.agentDirectory,
    ]);
    assertStrictEquals(piOptions[2]?.tools, runtime.tools);
    assertEquals(piOptions[2]?.modelRuntime, continuationRuntime);
    assertEquals(contexts.map((context) => context.messages.length), [0, 2, 2]);
    assertEquals(contexts[2]?.messages.map((message) => message.role), ["user", "assistant"]);
    const priorUserMessage = contexts[2]?.messages[0];
    assert(priorUserMessage?.role === "user");
    assertEquals(priorUserMessage.content, INITIAL_PROMPT);

    const history = eventsFromPiEntries(SessionManager.open(piPaths.sessionFile).getBranch());
    assertEquals(history.map((event) => event.type), [
      "user.message",
      "assistant.completed",
      "user.message",
      "assistant.completed",
      "user.message",
      "assistant.completed",
      "user.message",
      "assistant.completed",
    ]);
    assertEquals(
      history.flatMap((event) => event.type === "user.message" ? [event.text] : []),
      [
        INITIAL_PROMPT,
        CONTINUATION_PROMPT,
        "Queue this follow-up",
        "Queue this second follow-up",
      ],
    );
    assertEquals(
      history.flatMap((event) => event.type === "assistant.completed" ? [event.text] : []),
      [
        "Initial answer",
        "Continuation answer",
        "Follow-up answer: Queue this follow-up",
        "Follow-up answer: Queue this second follow-up",
      ],
    );
    const persisted = await readSessionText(workingDirectory);
    assert(!persisted.includes(continuationRuntime.credential.value));

    detach();
    success(await provisioner.close());
    assert(runtime.closed);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("rejects continuation without ready metadata, the original model, or a VM", async () => {
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
        model: MODEL_RUNTIME.model,
        orbSize: "small",
      }),
    );
    const provisioner = new SessionProvisioner({
      sessionStore: store,
      eventRelay: new SessionEventRelay(store),
      cpuCount: 2,
      memoryMiB: 4096,
      createRuntime: () => Promise.resolve(ok(new FakeRuntime())),
      createPiSession: createFakePiSession,
    });
    const messages: RunnerClientMessage[] = [];

    const notReady = promptCommand("not-ready", CONTINUATION_PROMPT);
    success(await provisioner.handlePromptCommand(notReady, (message) => messages.push(message)));
    await delay(0);
    success(
      await store.updateProvisioning(SESSION_ID, {
        state: "ready",
        checkoutState: "pending",
      }),
    );

    const wrongModel = promptCommand("wrong-model", CONTINUATION_PROMPT, {
      ...MODEL_RUNTIME,
      model: "openai/gpt-4.1",
    });
    success(await provisioner.handlePromptCommand(wrongModel, (message) => messages.push(message)));
    await delay(0);
    const noVm = promptCommand("no-vm", CONTINUATION_PROMPT);
    success(await provisioner.handlePromptCommand(noVm, (message) => messages.push(message)));

    assertEquals(
      messages.flatMap((message) =>
        message.type === "session.prompt.rejected"
          ? [{ correlationId: message.correlationId, text: message.payload.message }]
          : []
      ),
      [
        { correlationId: "not-ready", text: "The session is not ready and idle." },
        {
          correlationId: "wrong-model",
          text: "The session model cannot change during continuation.",
        },
        { correlationId: "no-vm", text: "This session orb is unavailable." },
      ],
    );
    success(await provisioner.close());
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
            isIdle: true,
            sessionManager: EMPTY_PI_SESSION_MANAGER,
            subscribe(nextListener: (event: AgentSessionEvent) => void) {
              listener = nextListener;
              return () => {
                listener = () => {};
              };
            },
            prompt(
              _input: string,
              options?: { preflightResult?: (success: boolean) => void },
            ) {
              options?.preflightResult?.(true);
              const failed = assistantMessage(
                [],
                "error",
                `Provider rejected ${MODEL_PROVIDER_KEY}`,
              );
              listener({ type: "message_start", message: failed });
              listener({ type: "message_end", message: failed });
              return Promise.resolve();
            },
            followUp: () => Promise.resolve(),
            clearQueue: () => ({ steering: [], followUp: [] }),
            abort: () => Promise.resolve(),
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
            isIdle: true,
            sessionManager: EMPTY_PI_SESSION_MANAGER,
            subscribe() {
              return () => {};
            },
            prompt(
              _input: string,
              options?: { preflightResult?: (success: boolean) => void },
            ) {
              promptCalls += 1;
              options?.preflightResult?.(true);
              return Promise.resolve();
            },
            followUp: () => Promise.resolve(),
            clearQueue: () => ({ steering: [], followUp: [] }),
            abort: () => Promise.resolve(),
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

function promptCommand(
  id: string,
  prompt: string,
  modelRuntime = MODEL_RUNTIME,
): SessionPromptCommand {
  return {
    version: 1,
    id,
    type: "session.prompt",
    sessionId: SESSION_ID,
    payload: { prompt, modelRuntime },
  };
}

function abortCommand(id: string, runId: string): SessionAbortCommand {
  return {
    version: 1,
    id,
    type: "session.abort",
    sessionId: SESSION_ID,
    payload: { runId },
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
  let active = false;
  return Promise.resolve({
    session: {
      get isIdle() {
        return !active;
      },
      sessionManager: EMPTY_PI_SESSION_MANAGER,
      subscribe(_listener: (event: AgentSessionEvent) => void) {
        return () => {};
      },
      async prompt(
        _input: string,
        options?: { preflightResult?: (success: boolean) => void },
      ) {
        active = true;
        options?.preflightResult?.(true);
        await delay(0);
        active = false;
      },
      followUp: () => Promise.resolve(),
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: () => Promise.resolve(),
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
