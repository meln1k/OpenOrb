import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import {
  AbortSessionPayload,
  ProjectId,
  PromptSessionPayload,
  ProvisionSessionPayload,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Effect, Schema } from "effect";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";

import {
  type AgentEnvironment,
  AgentEnvironmentProvider,
} from "../../src/environment/agent-environment.ts";
import { AgentHarness, AgentHarnessError } from "../../src/harness/agent-harness.ts";
import { type CreateRawPiSession, makePiAgentHarness } from "../../src/harness/pi/layer.ts";
import type { OpenOrbPiSessionOptions } from "../../src/harness/pi/session.ts";
import { makeSessionEvents, SessionEvents } from "../../src/session/events.ts";
import {
  makeSessionSupervisor,
  type SessionSupervisor,
  type SessionSupervisorOptions,
} from "../../src/session/supervisor.ts";
import {
  makeRunnerSessionStore,
  RunnerSessionStore,
  type RunnerSessionStore as RunnerSessionStoreService,
  RunnerSessionStoreFailure,
} from "../../src/session/store.ts";
import { makeSessionWorkerFactory, SessionWorkerFactory } from "../../src/session/worker.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c11",
);
const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "model-secret" },
};

class FakeEnvironment implements AgentEnvironment {
  readonly commands: string[][] = [];
  closed = false;

  run: AgentEnvironment["run"] = (command, options = {}) => {
    this.commands.push([...command]);
    return Effect.gen(function* () {
      if (command[1] === "rev-parse") {
        if (options.onOutput) {
          yield* options.onOutput({
            stream: "stdout",
            text: "0123456789abcdef0123456789abcdef01234567\n",
          }).pipe(Effect.orDie);
        }
      }
      return { exitCode: 0 };
    });
  };
  runShell: AgentEnvironment["runShell"] = () => Effect.succeed({ exitCode: 0 });
  readFile: AgentEnvironment["readFile"] = () => Effect.succeed(new Uint8Array());
  access: AgentEnvironment["access"] = () => Effect.void;
  writeFile: AgentEnvironment["writeFile"] = () => Effect.void;
  makeDirectory: AgentEnvironment["makeDirectory"] = () => Effect.void;
  detectImageMimeType: AgentEnvironment["detectImageMimeType"] = () => Effect.succeed(null);
}

Deno.test("SessionSupervisor accepts typed provisioning and owns the background Pi job", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const runtime = new FakeEnvironment();
    let piCreations = 0;
    let piDisposals = 0;
    const createPiSession: CreateRawPiSession = (options) =>
      Effect.map(createSettlingPiSession(options), (created) => {
        piCreations++;
        return {
          session: {
            ...created.session,
            dispose: () => {
              piDisposals++;
              created.session.dispose();
            },
          },
        };
      });
    const payload = Schema.decodeUnknownSync(ProvisionSessionPayload)({
      mode: "create",
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/meln1k/openorb.git",
      ref: "main",
      branchName: "openorb/session-supervisor-test",
      orbSize: "small",
      initialPrompt: "Inspect the repository",
      modelRuntime: MODEL_RUNTIME,
      githubToken: "github-secret",
    });

    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        maxConcurrentSessions: 2,
        createPiSession,
      },
      store,
      fakeEnvironmentProvider(runtime),
      async (supervisor) => {
        const accepted = await Effect.runPromise(supervisor.provision(payload));
        assertEquals(accepted.session.id, SESSION_ID);
        assertEquals((await Effect.runPromise(store.readMetadata(SESSION_ID))).state, "created");
        await waitForState(store, "ready");
        assertEquals(runtime.commands.map((command) => command.slice(0, 2)), [
          ["/usr/bin/git", "clone"],
          ["/usr/bin/git", "rev-parse"],
          ["/usr/bin/git", "switch"],
          ["/bin/sh", "-lc"],
        ]);

        const prompt = Schema.decodeUnknownSync(PromptSessionPayload)({
          sessionId: SESSION_ID,
          clientRequestId: crypto.randomUUID(),
          prompt: "Continue",
          modelRuntime: MODEL_RUNTIME,
        });
        const promptAccepted = await Effect.runPromise(supervisor.prompt(prompt));
        assertEquals(promptAccepted.mode, "started");
        assert(String(promptAccepted.runId) !== String(prompt.clientRequestId));
        await waitForState(store, "ready");
        assertEquals(piCreations, 1);
      },
    );
    assert(runtime.closed);
    assertEquals(piDisposals, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor aborts only the exact active run after clearing follow-ups", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const runtime = new FakeEnvironment();
    const promptStarted = Promise.withResolvers<void>();
    const promptFinished = Promise.withResolvers<void>();
    let active = false;
    let clearCalls = 0;
    let abortCalls = 0;
    let followUpCalls = 0;
    const supervisorOptions = {
      cpuCount: 4,
      memoryMiB: 8192,
      maxConcurrentSessions: 2,
      createPiSession: (_options: OpenOrbPiSessionOptions) =>
        Effect.succeed({
          session: {
            get isIdle() {
              return !active;
            },
            sessionManager: EMPTY_PI_SESSION_MANAGER,
            subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
            prompt: async (
              _input: string,
              options?: { preflightResult?: (success: boolean) => void },
            ) => {
              active = true;
              options?.preflightResult?.(true);
              promptStarted.resolve();
              await promptFinished.promise;
              active = false;
            },
            followUp: () => {
              followUpCalls++;
              return Promise.resolve();
            },
            clearQueue: () => {
              clearCalls++;
              return { steering: [], followUp: [] };
            },
            abort: () => {
              abortCalls++;
              promptFinished.resolve();
              return Promise.resolve();
            },
            dispose() {},
          },
        }),
    };
    const provision = Schema.decodeUnknownSync(ProvisionSessionPayload)({
      mode: "create",
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/meln1k/openorb.git",
      ref: "main",
      branchName: "openorb/abort-test",
      orbSize: "small",
      initialPrompt: "Inspect",
      modelRuntime: MODEL_RUNTIME,
    });
    await withSupervisor(
      supervisorOptions,
      store,
      fakeEnvironmentProvider(runtime),
      async (supervisor) => {
        await Effect.runPromise(supervisor.provision(provision));
        await promptStarted.promise;
        const activeRunId = await waitForActiveRun(supervisor);
        const followUp = Schema.decodeUnknownSync(PromptSessionPayload)({
          sessionId: SESSION_ID,
          clientRequestId: crypto.randomUUID(),
          prompt: "Continue while active",
          modelRuntime: MODEL_RUNTIME,
        });
        const followUpAccepted = await Effect.runPromise(supervisor.prompt(followUp));
        assertEquals(followUpAccepted.mode, "follow-up");
        assertEquals(followUpAccepted.runId, activeRunId);
        assertEquals(followUpCalls, 1);

        const stale = Schema.decodeUnknownSync(AbortSessionPayload)({
          sessionId: SESSION_ID,
          runId: crypto.randomUUID(),
        });
        assertEquals((await Effect.runPromiseExit(supervisor.abort(stale)))._tag, "Failure");
        assertEquals([clearCalls, abortCalls], [0, 0]);

        const exact = Schema.decodeUnknownSync(AbortSessionPayload)({
          sessionId: SESSION_ID,
          runId: activeRunId,
        });
        await Effect.runPromise(supervisor.abort(exact));
        assertEquals([clearCalls, abortCalls], [1, 1]);
        await waitForState(store, "ready");
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor reconstructs a ready durable session for continuation", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const payload = createProvisionPayload("openorb/restart-ready-test");

    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        maxConcurrentSessions: 2,
        createPiSession: createSettlingPiSession,
      },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        await Effect.runPromise(supervisor.provision(payload));
        await waitForState(store, "ready");
      },
    );

    const restartedStore = await makeStore(directory);
    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        maxConcurrentSessions: 2,
        createPiSession: createSettlingPiSession,
      },
      restartedStore,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (restarted) => {
        const prompt = Schema.decodeUnknownSync(PromptSessionPayload)({
          sessionId: SESSION_ID,
          clientRequestId: crypto.randomUUID(),
          prompt: "Continue after restart",
          modelRuntime: MODEL_RUNTIME,
        });
        const accepted = await Effect.runPromise(restarted.prompt(prompt));
        assertEquals(accepted.mode, "started");
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor marks durable created metadata for explicit retry", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const payload = createProvisionPayload("openorb/restart-created-test");
    await Effect.runPromise(store.createSession({
      id: payload.sessionId,
      projectId: payload.projectId,
      repositoryUrl: payload.repositoryUrl,
      ref: payload.ref,
      branchName: payload.branchName,
      initialPrompt: payload.initialPrompt,
      model: payload.modelRuntime.model,
      orbSize: payload.orbSize,
    }));

    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        maxConcurrentSessions: 2,
        createPiSession: createSettlingPiSession,
      },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        assertEquals((await Effect.runPromise(store.readMetadata(SESSION_ID))).state, "error");
        const retry = Schema.decodeUnknownSync(ProvisionSessionPayload)({
          mode: "retry",
          sessionId: SESSION_ID,
          modelRuntime: MODEL_RUNTIME,
        });
        await Effect.runPromise(supervisor.provision(retry));
        await waitForState(store, "ready");
        assertEquals(supervisor.activeSessionCount(), 1);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor reconciles orphaned durable states before accepting commands", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const ids = {
      created: SESSION_ID,
      provisioning: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c12",
      ),
      running: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c13",
      ),
      ready: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c14",
      ),
      error: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c15",
      ),
    };
    const sessions = [
      ["created", ids.created],
      ["provisioning", ids.provisioning],
      ["running", ids.running],
      ["ready", ids.ready],
      ["error", ids.error],
    ] as const;
    for (const [state, id] of sessions) {
      await Effect.runPromise(store.createSession({
        id,
        projectId: PROJECT_ID,
        repositoryUrl: "https://github.com/meln1k/openorb.git",
        ref: "main",
        branchName: `openorb/reconcile-${state}`,
        initialPrompt: "Inspect the repository",
        model: MODEL_RUNTIME.model,
        orbSize: "small",
      }));
      if (state !== "created") {
        await Effect.runPromise(store.updateSessionState(id, state));
      }
    }

    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        maxConcurrentSessions: 2,
        createPiSession: createSettlingPiSession,
      },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        assertEquals((await Effect.runPromise(store.readMetadata(ids.created))).state, "error");
        assertEquals(
          (await Effect.runPromise(store.readMetadata(ids.provisioning))).state,
          "error",
        );
        assertEquals((await Effect.runPromise(store.readMetadata(ids.running))).state, "ready");
        assertEquals((await Effect.runPromise(store.readMetadata(ids.ready))).state, "ready");
        assertEquals((await Effect.runPromise(store.readMetadata(ids.error))).state, "error");
        assertEquals(supervisor.activeSessionCount(), 0);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor fails construction when startup reconciliation cannot load storage", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const cause = new RunnerSessionStoreFailure({
      operation: "load-session-manifest",
      message: "unavailable",
      cause: undefined,
    });
    const failingStore: RunnerSessionStoreService = {
      ...store,
      loadSessionManifest: () => Effect.fail(cause),
    };
    const workerFactory = SessionWorkerFactory.of({
      spawn: () => Effect.die("A worker must not be spawned during reconciliation."),
    });
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          makeSessionSupervisor({
            cpuCount: 4,
            memoryMiB: 8192,
            maxConcurrentSessions: 2,
          }).pipe(
            Effect.provideService(RunnerSessionStore, failingStore),
            Effect.provideService(SessionWorkerFactory, workerFactory),
          ),
        ),
      ),
    );
    assertEquals(error._tag, "SessionSupervisorInitializationError");
    assertEquals(error.cause, cause);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor enforces the configured concurrent session maximum", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const secondSessionId = Schema.decodeUnknownSync(SessionId)(
      "01989d78-65ee-7f6a-a97e-0f16ad134c12",
    );
    const first = createProvisionPayload("openorb/capacity-first-test");
    const second = Schema.decodeUnknownSync(ProvisionSessionPayload)({
      ...createProvisionPayload("openorb/capacity-second-test"),
      sessionId: secondSessionId,
    });
    const neverSettlingPiSession: CreateRawPiSession = () =>
      Effect.succeed({
        session: {
          isIdle: false,
          sessionManager: EMPTY_PI_SESSION_MANAGER,
          subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
          prompt: (_input, options) => {
            options?.preflightResult?.(true);
            return new Promise<void>(() => {});
          },
          followUp: () => Promise.resolve(),
          clearQueue: () => ({ steering: [], followUp: [] }),
          abort: () => Promise.resolve(),
          dispose() {},
        },
      });
    const configuredOptions: SessionSupervisorOptions = {
      cpuCount: 4,
      memoryMiB: 8192,
      maxConcurrentSessions: 1,
    };

    await withSupervisor(
      { ...configuredOptions, createPiSession: neverSettlingPiSession },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        await Effect.runPromise(supervisor.provision(first));
        assertEquals(supervisor.activeSessionCount(), 1);
        const secondExit = await Effect.runPromiseExit(supervisor.provision(second));
        assertEquals(secondExit._tag, "Failure");
        assertEquals(supervisor.activeSessionCount(), 1);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor serializes two closely queued idle prompts into one run", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const firstContinuationStarted = Promise.withResolvers<void>();
    const followUpAccepted = Promise.withResolvers<void>();
    const releaseContinuations = Promise.withResolvers<void>();
    let promptCalls = 0;
    const createPiSession: CreateRawPiSession = () =>
      Effect.succeed({
        session: {
          isIdle: true,
          sessionManager: EMPTY_PI_SESSION_MANAGER,
          subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
          prompt: async (_input, options) => {
            const call = promptCalls++;
            options?.preflightResult?.(true);
            if (call > 0) {
              firstContinuationStarted.resolve();
              await releaseContinuations.promise;
            }
          },
          followUp: () => {
            followUpAccepted.resolve();
            return Promise.resolve();
          },
          clearQueue: () => ({ steering: [], followUp: [] }),
          abort: () => Promise.resolve(),
          dispose() {},
        },
      });

    await withSupervisor(
      { cpuCount: 4, memoryMiB: 8192, maxConcurrentSessions: 2, createPiSession },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        await Effect.runPromise(
          supervisor.provision(createProvisionPayload("openorb/prompt-order-test")),
        );
        await waitForState(store, "ready");
        const prompt = (text: string) =>
          Schema.decodeUnknownSync(PromptSessionPayload)({
            sessionId: SESSION_ID,
            clientRequestId: crypto.randomUUID(),
            prompt: text,
            modelRuntime: MODEL_RUNTIME,
          });
        const first = Effect.runPromise(supervisor.prompt(prompt("First continuation")));
        await firstContinuationStarted.promise;
        const second = Effect.runPromise(supervisor.prompt(prompt("Second continuation")));
        await followUpAccepted.promise;
        releaseContinuations.resolve();
        const [firstAccepted, secondAccepted] = await Promise.all([first, second]);

        assertEquals(firstAccepted.mode, "started");
        assertEquals(secondAccepted.mode, "follow-up");
        assertEquals(secondAccepted.runId, firstAccepted.runId);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

function createProvisionPayload(
  branchName: string,
): Extract<typeof ProvisionSessionPayload.Type, { mode: "create" }> {
  const payload = Schema.decodeUnknownSync(ProvisionSessionPayload)({
    mode: "create",
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://github.com/meln1k/openorb.git",
    ref: "main",
    branchName,
    orbSize: "small",
    initialPrompt: "Inspect the repository",
    modelRuntime: MODEL_RUNTIME,
  });
  if (payload.mode !== "create") throw new Error("Expected a create payload.");
  return payload;
}

function createSettlingPiSession(_options: OpenOrbPiSessionOptions) {
  let active = false;
  return Effect.succeed({
    session: {
      get isIdle() {
        return !active;
      },
      sessionManager: EMPTY_PI_SESSION_MANAGER,
      subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
      prompt: async (
        _input: string,
        options?: { preflightResult?: (success: boolean) => void },
      ) => {
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

async function waitForState(
  store: RunnerSessionStoreService,
  state: "ready",
  timeoutMs = 1_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = await Effect.runPromise(store.readMetadata(SESSION_ID));
    if (metadata.state === state) return;
    if (metadata.state === "error") throw new Error("Session provisioning failed.");
    await delay(10);
  }
  throw new Error(`Session did not reach ${state}.`);
}

function makeStore(workingDirectory: string) {
  return Effect.runPromise(
    makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
      Effect.provide(DenoFileSystem.layer),
    ),
  );
}

async function waitForActiveRun(supervisor: SessionSupervisor, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runId = supervisor.getActiveRunId(SESSION_ID);
    if (runId) return runId;
    await delay(10);
  }
  throw new Error("Session did not expose its active run.");
}

const EMPTY_PI_SESSION_MANAGER: Pick<SessionManager, "getLeafEntry"> = {
  getLeafEntry: () => undefined,
};

function fakeEnvironmentProvider(environment: FakeEnvironment): AgentEnvironmentProvider {
  return {
    make: () =>
      Effect.acquireRelease(
        Effect.succeed(environment),
        () => Effect.sync(() => environment.closed = true),
      ),
  };
}

async function withSupervisor(
  options: SessionSupervisorOptions & { readonly createPiSession?: CreateRawPiSession },
  store: RunnerSessionStoreService,
  environmentProvider: AgentEnvironmentProvider,
  use: (supervisor: SessionSupervisor) => Promise<void>,
): Promise<void> {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeSessionEvents().pipe(
          Effect.provideService(RunnerSessionStore, store),
        );
        const harness = makePiAgentHarness({
          conversationProjection: {
            activate: (sessionId, initial) =>
              events.activateConversation(sessionId, initial).pipe(
                Effect.mapError((cause) =>
                  new AgentHarnessError("Could not activate the conversation cache.", cause)
                ),
              ),
          },
          ...(options.createPiSession === undefined ? {} : { create: options.createPiSession }),
        });
        const workerFactory = yield* makeSessionWorkerFactory().pipe(
          Effect.provideService(RunnerSessionStore, store),
          Effect.provideService(SessionEvents, events),
          Effect.provideService(AgentEnvironmentProvider, environmentProvider),
          Effect.provideService(AgentHarness, harness),
        );
        const supervisor = yield* makeSessionSupervisor({
          cpuCount: options.cpuCount,
          memoryMiB: options.memoryMiB,
          maxConcurrentSessions: options.maxConcurrentSessions,
        }).pipe(
          Effect.provideService(RunnerSessionStore, store),
          Effect.provideService(SessionWorkerFactory, workerFactory),
        );
        yield* Effect.promise(() => use(supervisor));
      }),
    ),
  );
}
