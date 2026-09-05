import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import {
  AbortSessionPayload,
  GitAuthor,
  MAX_RPC_SESSION_EVENT_TEXT_BYTES,
  ProjectId,
  PromptSessionPayload,
  ProvisionSessionPayload,
  RunId,
  RunnerId,
  SessionId,
  type SessionIssueCategory,
  StopSessionPayload,
  UpdateSessionGitFilePayload,
  WakeSessionPayload,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import {
  type AgentEnvironment,
  AgentEnvironmentCheckpointError,
  AgentEnvironmentError,
  type AgentEnvironmentOptions,
  AgentEnvironmentProvider,
} from "../../src/environment/agent-environment.ts";
import { AgentHarness, AgentHarnessError } from "../../src/harness/agent-harness.ts";
import { type CreateRawPiSession, makePiAgentHarness } from "../../src/harness/pi/layer.ts";
import type { OpenOrbPiSessionOptions } from "../../src/harness/pi/session.ts";
import { Journal } from "../../src/session/persistent-actor/journal.ts";
import { PersistentActorError } from "../../src/session/persistent-actor/persistent-actor.ts";
import { RunnerSessionDefinition } from "../../src/session/definition.ts";
import { makeSessionEvents, SessionEvents } from "../../src/session/events.ts";
import { sessionJournalLayer } from "../../src/session/persistent-actor/session-journal.ts";
import {
  makeSessionSupervisor,
  type SessionSupervisor,
  type SessionSupervisorOptions,
} from "../../src/session/supervisor.ts";
import {
  RunnerSessionStore,
  type RunnerSessionStore as RunnerSessionStoreService,
  RunnerSessionStoreFailure,
  runnerSessionStoreLayer,
} from "../../src/session/store.ts";
import {
  makeSessionActorFactory,
  type SessionActor,
  SessionActorFactory,
  type SessionActorInput,
} from "../../src/session/actor/index.ts";
import { makeSessionFixture, type SessionFixture } from "./session-fixture.ts";

const platformLayer = Layer.merge(DenoFileSystem.layer, DenoPath.layer);

const RUNNER_ID = Schema.decodeUnknownSync(RunnerId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c09",
);
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c11",
);
const WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c12",
);
const GIT_AUTHOR = new GitAuthor({ name: "OpenOrb User", email: "user@example.com" });
const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "model-secret" },
};
const CREATED_AT = "2026-08-17T12:00:00Z";

interface TestStore extends RunnerSessionStoreService {
  readonly journal: Journal;
  readonly session: SessionFixture;
}

function sessionDefinition(branchName: string): RunnerSessionDefinition {
  return new RunnerSessionDefinition({
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    ref: "main",
    branchName,
    gitAuthor: GIT_AUTHOR,
    initialPrompt: "Inspect the repository",
    model: MODEL_RUNTIME.model,
    orbSize: "small",
  });
}

class FakeEnvironment implements AgentEnvironment {
  readonly commands: string[][] = [];
  checkpointCalls = 0;
  checkpointFailureConsumed: boolean | undefined;
  gitSnapshotBlock:
    | { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    | undefined;
  resumeHookExitCode = 0;
  cloneResult:
    | { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }
    | undefined;
  setupResult:
    | { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }
    | undefined;
  closed = false;

  run: AgentEnvironment["run"] = (command, options = {}) => {
    this.commands.push([...command]);
    const resumeHookExitCode = this.resumeHookExitCode;
    const gitSnapshotBlock = this.gitSnapshotBlock;
    const injectedResult = command[1] === "clone"
      ? this.cloneResult
      : command.some((argument) => argument.includes(".agents/setup"))
      ? this.setupResult
      : undefined;
    return Effect.gen(function* () {
      if (gitSnapshotBlock !== undefined && command.includes("--porcelain=v2")) {
        gitSnapshotBlock.started.resolve();
        yield* Effect.promise(() => gitSnapshotBlock.release.promise);
      }
      if (command.includes("rev-parse")) {
        if (options.onOutput) {
          yield* options.onOutput({
            stream: "stdout",
            text: "0123456789abcdef0123456789abcdef01234567\n",
          }).pipe(Effect.orDie);
        }
      }
      if (options.onOutput && injectedResult?.stdout) {
        yield* options.onOutput({ stream: "stdout", text: injectedResult.stdout }).pipe(
          Effect.orDie,
        );
      }
      if (options.onOutput && injectedResult?.stderr) {
        yield* options.onOutput({ stream: "stderr", text: injectedResult.stderr }).pipe(
          Effect.orDie,
        );
      }
      return {
        exitCode: injectedResult?.exitCode ??
          (command.some((argument) => argument.includes(".agents/resume"))
            ? resumeHookExitCode
            : 0),
      };
    });
  };
  runShell: AgentEnvironment["runShell"] = () => Effect.succeed({ exitCode: 0 });
  readFile: AgentEnvironment["readFile"] = () => Effect.succeed(new Uint8Array());
  access: AgentEnvironment["access"] = () => Effect.void;
  writeFile: AgentEnvironment["writeFile"] = () => Effect.void;
  makeDirectory: AgentEnvironment["makeDirectory"] = () => Effect.void;
  detectImageMimeType: AgentEnvironment["detectImageMimeType"] = () => Effect.succeed(null);
  checkpoint: AgentEnvironment["checkpoint"] = (path) => {
    this.checkpointCalls++;
    return Effect.promise(() => Deno.writeTextFile(path, `fake checkpoint ${this.checkpointCalls}`))
      .pipe(
        Effect.flatMap(() =>
          this.checkpointFailureConsumed === undefined
            ? Effect.succeed({
              path,
              guestAssetBuildId: "02e784cb-e063-5138-b1c4-334e8a3307a9",
              createdWithVmm: "qemu" as const,
              compatibleVmm: ["qemu" as const],
            })
            : Effect.fail(
              new AgentEnvironmentCheckpointError(
                "Injected checkpoint failure.",
                undefined,
                this.checkpointFailureConsumed,
              ),
            )
        ),
      );
  };
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
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
      ref: "main",
      branchName: "openorb/session-supervisor-test",
      gitAuthor: GIT_AUTHOR,
      orbSize: "small",
      initialPrompt: "Inspect the repository",
      modelRuntime: MODEL_RUNTIME,
      githubToken: "github-secret",
    });

    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        createPiSession,
      },
      store,
      fakeEnvironmentProvider(runtime),
      async (supervisor) => {
        const accepted = await Effect.runPromise(supervisor.provision(payload));
        assertEquals(accepted.session.id, SESSION_ID);
        await waitForState(store, "ready");
        assertEquals(runtime.commands.map((command) => command.slice(0, 2)), [
          ["/usr/bin/git", "clone"],
          ["/usr/bin/git", "rev-parse"],
          ["/usr/bin/git", "switch"],
          ["/bin/sh", "-lc"],
          ["/usr/bin/timeout", "--signal=KILL"],
          ["/usr/bin/timeout", "--signal=KILL"],
          ["/usr/bin/timeout", "--signal=KILL"],
        ]);

        const prompt = Schema.decodeUnknownSync(PromptSessionPayload)({
          sessionId: SESSION_ID,
          clientRequestId: crypto.randomUUID(),
          prompt: "Continue",
          modelRuntime: MODEL_RUNTIME,
        });
        const promptAccepted = await Effect.runPromise(requireActor(supervisor).prompt(prompt));
        assert(promptAccepted.ok);
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

Deno.test("clone and setup failures remain bounded warnings and still dispatch the stored prompt", async () => {
  for (const failure of ["clone", "setup"] as const) {
    const directory = await Deno.makeTempDir();
    try {
      const store = await makeStore(directory);
      const environment = new FakeEnvironment();
      if (failure === "clone") {
        environment.cloneResult = {
          exitCode: 128,
          stderr: "fatal: authentication failed\n",
        };
      } else {
        environment.setupResult = {
          exitCode: 23,
          stdout: `setup warning ${"x".repeat(20_000)}`,
          stderr: `setup failed ${"y".repeat(20_000)}`,
        };
      }
      const prompts: string[] = [];
      const createPiSession: CreateRawPiSession = (options) =>
        createSettlingPiSession(options).pipe(
          Effect.map((created) => ({
            session: {
              ...created.session,
              prompt: async (input, promptOptions) => {
                prompts.push(input);
                return await created.session.prompt(input, promptOptions);
              },
            },
          })),
        );

      await withSupervisor(
        { cpuCount: 4, memoryMiB: 8192, createPiSession },
        store,
        fakeEnvironmentProvider(environment),
        async (supervisor) => {
          const payload = Schema.decodeUnknownSync(ProvisionSessionPayload)({
            ...createProvisionPayload(`openorb/${failure}-warning-test`),
            githubToken: "github-secret",
          });
          await Effect.runPromise(
            supervisor.provision(payload),
          );
          await waitForState(store, "ready");
          const metadata = await Effect.runPromise(store.readMetadata(SESSION_ID));
          assertEquals(metadata.checkoutState, failure === "clone" ? "unavailable" : "available");
          const issue = metadata.issues.find((issue) =>
            issue.category === (failure === "clone" ? "github-authentication" : "setup")
          );
          assert(issue);
          assertEquals(issue.severity, "warning");
          assertEquals(issue.recovery, "none");
          assert(
            issue.diagnostics?.includes(
              failure === "clone" ? "authentication failed" : "setup warning",
            ),
          );
          assert(
            new TextEncoder().encode(issue.diagnostics).byteLength <=
              MAX_RPC_SESSION_EVENT_TEXT_BYTES,
          );
          assertEquals(prompts, ["Inspect the repository"]);
        },
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("manual Stop checkpoints and repeatedly resumes the newest Pi session generation", async () => {
  const directory = await Deno.makeTempDir();
  const environments: FakeEnvironment[] = [];
  const environmentOptions: AgentEnvironmentOptions[] = [];
  const piSessionFiles: string[] = [];
  const prompts: string[] = [];
  let piDisposals = 0;
  const environmentProvider = AgentEnvironmentProvider.of({
    make: (options) => {
      environmentOptions.push(options);
      const environment = new FakeEnvironment();
      if (options.resumeCheckpoint !== undefined && environments.length === 2) {
        environment.resumeHookExitCode = 23;
      }
      environments.push(environment);
      return Effect.acquireRelease(
        Effect.succeed(environment),
        () => Effect.sync(() => environment.closed = true),
      );
    },
  });
  const createPiSession: CreateRawPiSession = (options) => {
    piSessionFiles.push(options.runnerSessionFile);
    let active = false;
    return Effect.succeed({
      session: {
        get isIdle() {
          return !active;
        },
        sessionManager: EMPTY_PI_SESSION_MANAGER,
        subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
        prompt: async (input, promptOptions) => {
          active = true;
          prompts.push(input);
          promptOptions?.preflightResult?.(true);
          await delay(0);
          active = false;
        },
        followUp: () => Promise.resolve(),
        clearQueue: () => ({ steering: [], followUp: [] }),
        abort: () => Promise.resolve(),
        dispose() {
          piDisposals++;
        },
      },
    });
  };

  try {
    const store = await makeStore(directory);
    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        createPiSession,
      },
      store,
      environmentProvider,
      async (supervisor, events) => {
        await Effect.runPromise(
          supervisor.provision(createProvisionPayload("openorb/checkpoint-cycle-test")),
        );
        await waitForState(store, "ready");
        const actor = requireActor(supervisor);

        assertEquals(await Effect.runPromise(actor.stop(stopPayload())), { ok: true });
        const first = await Effect.runPromise(store.readCurrentCheckpoint(SESSION_ID));
        assertEquals((await Effect.runPromise(store.readMetadata(SESSION_ID))).state, "stopped");
        assertEquals(supervisor.activeSessionCount(), 0);
        assertEquals(piDisposals, 1);

        assertEquals(
          await Effect.runPromise(
            actor.wake(wakePayload(undefined, "resume-prior-checkpoint")),
          ),
          { ok: false, message: "This session does not require environment recovery." },
        );
        const woken = await Effect.runPromise(actor.wake(wakePayload(
          "continuation-github-token",
        )));
        assertEquals(woken, { ok: true });
        await waitForState(store, "ready");
        assertEquals(environmentOptions[1]?.resumeCheckpoint, first);
        assertEquals(environmentOptions[1]?.github?.token, "continuation-github-token");
        assert(
          environments[1]?.commands.some((command) =>
            command.some((argument) => argument.includes(".agents/resume"))
          ),
        );
        assertEquals(prompts, ["Inspect the repository"]);

        const firstContinuation = await Effect.runPromise(actor.prompt(promptPayload(
          "Continue after first checkpoint",
          "continuation-github-token",
        )));
        assert(firstContinuation.ok);
        await waitForState(store, "ready");

        assertEquals(await Effect.runPromise(actor.stop(stopPayload())), { ok: true });
        const second = await Effect.runPromise(store.readCurrentCheckpoint(SESSION_ID));
        assert(second.path !== first.path);
        await assertPathMissing(first.path);
        assertEquals(piDisposals, 2);

        const resumeFailureLog = Effect.runPromise(
          events.watch(SESSION_ID, 0).pipe(
            Stream.filter((item) =>
              item.event.type === "provisioning.log" &&
              item.event.text.includes(".agents/resume exited with status 23")
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("1 second"),
          ),
        );
        await delay(0);
        const secondContinuation = await Effect.runPromise(
          actor.prompt(promptPayload("Continue despite resume hook failure")),
        );
        assert(secondContinuation.ok);
        await waitForState(store, "ready");
        assertEquals(Array.from(await resumeFailureLog).length, 1);
        assertEquals(environmentOptions[2]?.resumeCheckpoint, second);
        assertEquals(environments[2]?.resumeHookExitCode, 23);
        assertEquals(
          environments.flatMap((environment) => environment.commands).filter((command) =>
            command.some((argument) => argument.includes(".agents/setup"))
          ).length,
          1,
        );
        assertEquals(piSessionFiles.length, 3);
        assertEquals(new Set(piSessionFiles).size, 1);
        assertEquals(prompts, [
          "Inspect the repository",
          "Continue after first checkpoint",
          "Continue despite resume hook failure",
        ]);
      },
    );
    assert(environments.every((environment) => environment.closed));
    assertEquals(piDisposals, 3);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Stop rejects active Pi work and the shortened idle timeout stops after it settles", async () => {
  const directory = await Deno.makeTempDir();
  const continuationStarted = Promise.withResolvers<void>();
  const releaseContinuation = Promise.withResolvers<void>();
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
            continuationStarted.resolve();
            await releaseContinuation.promise;
          }
        },
        followUp: () => Promise.resolve(),
        clearQueue: () => ({ steering: [], followUp: [] }),
        abort: () => {
          releaseContinuation.resolve();
          return Promise.resolve();
        },
        dispose() {},
      },
    });

  try {
    const store = await makeStore(directory);
    const environment = new FakeEnvironment();
    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        idleTimeoutMs: 100,
        createPiSession,
      },
      store,
      fakeEnvironmentProvider(environment),
      async (supervisor) => {
        await Effect.runPromise(
          supervisor.provision(createProvisionPayload("openorb/idle-stop-test")),
        );
        await waitForState(store, "ready");
        const actor = requireActor(supervisor);
        const continued = await Effect.runPromise(
          actor.prompt(promptPayload("Keep working past the idle threshold")),
        );
        assert(continued.ok);
        await continuationStarted.promise;
        await delay(150);
        assertEquals((await Effect.runPromise(store.readMetadata(SESSION_ID))).state, "running");
        assertEquals(environment.checkpointCalls, 0);
        const rejected = await Effect.runPromise(actor.stop(stopPayload()));
        assertEquals(rejected.ok, false);

        releaseContinuation.resolve();
        await waitForState(store, "stopped");
        assertEquals(environment.checkpointCalls, 1);
        await waitForActorInactive(actor);
        assertEquals(supervisor.activeSessionCount(), 0);
      },
    );
  } finally {
    releaseContinuation.resolve();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Stop rejects an active Git Snapshot and succeeds after it finishes", async () => {
  const directory = await Deno.makeTempDir();
  const snapshotStarted = Promise.withResolvers<void>();
  const releaseSnapshot = Promise.withResolvers<void>();
  try {
    const store = await makeStore(directory);
    const environment = new FakeEnvironment();
    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        createPiSession: createSettlingPiSession,
      },
      store,
      fakeEnvironmentProvider(environment),
      async (supervisor) => {
        await Effect.runPromise(
          supervisor.provision(createProvisionPayload("openorb/stop-git-snapshot-test")),
        );
        await waitForState(store, "ready");
        environment.gitSnapshotBlock = {
          started: snapshotStarted,
          release: releaseSnapshot,
        };
        const actor = requireActor(supervisor);
        const update = Effect.runPromise(actor.updateGitFile(
          Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
            sessionId: SESSION_ID,
            action: "stage",
            path: "src/main.ts",
          }),
        ));
        await snapshotStarted.promise;
        const rejected = await Effect.runPromise(actor.stop(stopPayload()));
        assertEquals(rejected.ok, false);
        assertEquals((await Effect.runPromise(supervisor.deleteSession(SESSION_ID))).ok, false);

        environment.gitSnapshotBlock = undefined;
        releaseSnapshot.resolve();
        assertEquals(await update, { ok: true });
        assertEquals(await Effect.runPromise(actor.stop(stopPayload())), { ok: true });
        assertEquals((await Effect.runPromise(store.readMetadata(SESSION_ID))).state, "stopped");
      },
    );
  } finally {
    releaseSnapshot.resolve();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("checkpoint failures distinguish reusable and consumed VMs", async () => {
  for (const consumed of [false, true]) {
    const directory = await Deno.makeTempDir();
    try {
      const store = await makeStore(directory);
      const environment = new FakeEnvironment();
      environment.checkpointFailureConsumed = consumed;
      let piCreations = 0;
      const createPiSession: CreateRawPiSession = (options) => {
        piCreations++;
        return createSettlingPiSession(options);
      };
      await withSupervisor(
        {
          cpuCount: 4,
          memoryMiB: 8192,
          createPiSession,
        },
        store,
        fakeEnvironmentProvider(environment),
        async (supervisor, events) => {
          await Effect.runPromise(supervisor.provision(
            createProvisionPayload(`openorb/checkpoint-failure-${consumed}`),
          ));
          await waitForState(store, "ready");
          const actor = requireActor(supervisor);
          const visibleIssue = waitForVisibleIssue(
            events,
            SESSION_ID,
            consumed ? "checkpoint-publish" : "checkpoint-create",
          );
          const stopped = await Effect.runPromise(actor.stop(stopPayload()));
          assertEquals(stopped.ok, false);
          const { issue, state } = await visibleIssue;
          assertEquals(issue.severity, consumed ? "failure" : "warning");
          assertEquals(state.stage, consumed ? "failed" : "ready");
          const metadata = await Effect.runPromise(store.readMetadata(SESSION_ID));
          assertEquals(metadata.state, consumed ? "error" : "ready");
          assertEquals(metadata.checkpoint, undefined);
          assertEquals(metadata.checkpointCandidate, undefined);
          assertEquals(
            metadata.issues.findLast((issue) => issue.severity === "failure")?.recovery,
            consumed ? "start-clean-vm" : undefined,
          );
          assertEquals(
            (await Array.fromAsync(
              Deno.readDir(join(directory, "sessions", SESSION_ID, "checkpoints")),
            )).length,
            0,
          );
          assertEquals(actor.active, !consumed);

          if (consumed) {
            const setupCalls = environment.commands.filter((command) =>
              command.some((argument) =>
                argument.includes(".agents/setup")
              )
            ).length;
            assertEquals(
              await Effect.runPromise(actor.wake(wakePayload(undefined, "start-clean-vm"))),
              { ok: true },
            );
            await waitForState(store, "ready");
            assertEquals(
              environment.commands.filter((command) =>
                command.some((argument) => argument.includes(".agents/setup"))
              ).length,
              setupCalls + 1,
            );
          }

          const prompted = await Effect.runPromise(
            actor.prompt(promptPayload("Try after failed checkpoint")),
          );
          assertEquals(prompted.ok, true);
          await waitForState(store, "ready");
          assertEquals(piCreations, 2);
        },
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("checkpoint resume failure requires explicit retry and leaves the prompt undispatched", async () => {
  const directory = await Deno.makeTempDir();
  let environmentCreations = 0;
  let piPromptCalls = 0;
  const environment = new FakeEnvironment();
  const environmentProvider = AgentEnvironmentProvider.of({
    make: (options) => {
      environmentCreations++;
      return options.resumeCheckpoint === undefined
        ? Effect.acquireRelease(
          Effect.succeed(environment),
          () => Effect.sync(() => environment.closed = true),
        )
        : Effect.fail(
          new AgentEnvironmentError(
            "Injected incompatible checkpoint backend.",
            undefined,
          ),
        );
    },
  });
  const createPiSession: CreateRawPiSession = (options) =>
    createSettlingPiSession(options).pipe(
      Effect.map((created) => ({
        session: {
          ...created.session,
          prompt: async (
            input: string,
            promptOptions?: { preflightResult?: (success: boolean) => void },
          ) => {
            piPromptCalls++;
            return await created.session.prompt(input, promptOptions);
          },
        },
      })),
    );

  try {
    const store = await makeStore(directory);
    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        createPiSession,
      },
      store,
      environmentProvider,
      async (supervisor) => {
        await Effect.runPromise(
          supervisor.provision(createProvisionPayload("openorb/resume-failure-test")),
        );
        await waitForState(store, "ready");
        const actor = requireActor(supervisor);
        assertEquals(await Effect.runPromise(actor.stop(stopPayload())), { ok: true });
        const promptCallsBeforeResume = piPromptCalls;
        const resumed = await Effect.runPromise(
          actor.prompt(promptPayload("This must remain undispatched")),
        );
        assertEquals(resumed.ok, false);
        const failed = await Effect.runPromise(store.readMetadata(SESSION_ID));
        assertEquals(failed.state, "error");
        assert(failed.checkpoint !== undefined);
        assertEquals(
          failed.issues.findLast((issue) => issue.severity === "failure")?.recovery,
          "resume-prior-checkpoint",
        );
        assertEquals(piPromptCalls, promptCallsBeforeResume);
        assertEquals(environmentCreations, 2);
        assertEquals(actor.active, false);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("session owners retain separate immutable Git identities in guest environments", async () => {
  const directory = await Deno.makeTempDir();
  const identities = [
    {
      workspaceId: WORKSPACE_ID,
      gitAuthor: GIT_AUTHOR,
    },
    {
      workspaceId: Schema.decodeUnknownSync(WorkspaceId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c13",
      ),
      gitAuthor: new GitAuthor({ name: "Second User", email: "second@example.com" }),
    },
  ] as const;
  const observed: AgentEnvironmentOptions[] = [];

  try {
    for (const [index, identity] of identities.entries()) {
      const sessionDirectory = `${directory}/${index}`;
      await Deno.mkdir(sessionDirectory);
      const store = await makeStore(sessionDirectory);
      const environment = new FakeEnvironment();
      const environmentProvider: AgentEnvironmentProvider = {
        make: (options) => {
          observed.push(options);
          return Effect.acquireRelease(
            Effect.succeed(environment),
            () => Effect.sync(() => environment.closed = true),
          );
        },
      };
      const payload = Schema.decodeUnknownSync(ProvisionSessionPayload)({
        ...createProvisionPayload(`openorb/identity-${index}`),
        workspaceId: identity.workspaceId,
        gitAuthor: identity.gitAuthor,
      });
      if (payload.mode !== "create") throw new Error("Expected a create payload.");

      await withSupervisor(
        {
          cpuCount: 4,
          memoryMiB: 8192,
          createPiSession: createSettlingPiSession,
        },
        store,
        environmentProvider,
        async (supervisor) => {
          await Effect.runPromise(supervisor.provision(payload));
          await waitForState(store, "ready");
          const metadata = await Effect.runPromise(store.readMetadata(SESSION_ID));
          assertEquals(metadata.definition.workspaceId, identity.workspaceId);
          assertEquals(metadata.definition.gitAuthor, identity.gitAuthor);
        },
      );
    }

    assertEquals(
      observed.map((options) => options.github?.gitAuthor),
      identities.map((identity) => identity.gitAuthor),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionActor awaits a failed run-end Git Snapshot refresh without failing the run", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const failingSnapshotStore: TestStore = {
      ...store,
      writeGitSnapshotState: () =>
        Effect.sync(() => writeStarted.resolve()).pipe(
          Effect.andThen(Effect.promise(() => releaseWrite.promise)),
          Effect.andThen(Effect.fail(
            new RunnerSessionStoreFailure({
              operation: "write-git-snapshot",
              message: "Git Snapshot storage is unavailable.",
              cause: undefined,
            }),
          )),
        ),
    };
    const runtime = new FakeEnvironment();
    const payload = createProvisionPayload("openorb/final-snapshot-failure-test");

    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        createPiSession: createSettlingPiSession,
      },
      failingSnapshotStore,
      fakeEnvironmentProvider(runtime),
      async (supervisor) => {
        await Effect.runPromise(supervisor.provision(payload));
        await writeStarted.promise;
        assertEquals((await Effect.runPromise(store.readMetadata(SESSION_ID))).state, "running");

        releaseWrite.resolve();
        await waitForState(store, "ready");
        assertEquals(
          (await Effect.runPromise(store.readMetadata(SESSION_ID))).issues.some((issue) =>
            issue.category === "report" && issue.severity === "warning"
          ),
          true,
        );
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor records failed follow-ups and aborts only the active run", async () => {
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
              return followUpCalls === 1
                ? Promise.reject(new Error("Injected follow-up failure."))
                : Promise.resolve();
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
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
      ref: "main",
      branchName: "openorb/abort-test",
      gitAuthor: GIT_AUTHOR,
      orbSize: "small",
      initialPrompt: "Inspect",
      modelRuntime: MODEL_RUNTIME,
    });
    await withSupervisor(
      supervisorOptions,
      store,
      fakeEnvironmentProvider(runtime),
      async (supervisor, events) => {
        await Effect.runPromise(supervisor.provision(provision));
        await promptStarted.promise;
        const activeRunId = await waitForActiveRun(supervisor);
        const followUp = Schema.decodeUnknownSync(PromptSessionPayload)({
          sessionId: SESSION_ID,
          clientRequestId: crypto.randomUUID(),
          prompt: "Continue while active",
          modelRuntime: MODEL_RUNTIME,
        });
        const actor = requireActor(supervisor);
        const visibleIssue = waitForVisibleIssue(
          events,
          SESSION_ID,
          "operation-uncertain",
          "could not confirm the follow-up",
        );
        assertEquals((await Effect.runPromise(actor.prompt(followUp))).ok, false);
        const failedFollowUp = await visibleIssue;
        assertEquals(failedFollowUp.issue.severity, "warning");
        assertEquals(failedFollowUp.state.stage, "running");
        const followUpAccepted = await Effect.runPromise(actor.prompt(
          Schema.decodeUnknownSync(PromptSessionPayload)({
            ...followUp,
            clientRequestId: crypto.randomUUID(),
          }),
        ));
        assert(followUpAccepted.ok);
        assertEquals(followUpAccepted.mode, "follow-up");
        assertEquals(followUpAccepted.runId, activeRunId);
        assertEquals(followUpCalls, 2);

        const update = Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
          sessionId: SESSION_ID,
          action: "stage",
          path: "src/main.ts",
        });
        assertEquals(await Effect.runPromise(actor.updateGitFile(update)), { ok: true });
        assert(runtime.commands.some((command) => command.includes("add")));

        const stale = Schema.decodeUnknownSync(AbortSessionPayload)({
          sessionId: SESSION_ID,
          runId: crypto.randomUUID(),
        });
        assertEquals((await Effect.runPromise(actor.abort(stale))).ok, false);
        assertEquals([clearCalls, abortCalls], [0, 0]);

        const exact = Schema.decodeUnknownSync(AbortSessionPayload)({
          sessionId: SESSION_ID,
          runId: activeRunId,
        });
        assertEquals(await Effect.runPromise(actor.abort(exact)), { ok: true });
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
        const actor = await Effect.runPromise(
          restarted.findOrRestoreActor(SESSION_ID),
        );
        assert(actor);
        const accepted = await Effect.runPromise(actor.prompt(prompt));
        assert(accepted.ok);
        assertEquals(accepted.mode, "started");
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor lazily restores a ready actor for Git file updates", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const payload = createProvisionPayload("openorb/restart-git-update-test");
    await Effect.runPromise(
      store.session.create(payload.sessionId, sessionDefinition(payload.branchName), CREATED_AT),
    );
    await Effect.runPromise(store.session.completeInitialRun(
      SESSION_ID,
      "available",
      "0123456789abcdef0123456789abcdef01234567",
    ));
    const spawns: SessionActorInput[] = [];
    const updates: UpdateSessionGitFilePayload[] = [];
    const actor: SessionActor = {
      sessionId: SESSION_ID,
      activeRunId: undefined,
      active: true,
      wake: () => Effect.die("unexpected wake"),
      prompt: () => Effect.die("unexpected prompt"),
      abort: () => Effect.die("unexpected abort"),
      stop: () => Effect.die("unexpected stop"),
      delete: () => Effect.succeed({ ok: true }),
      updateGitFile: (update) =>
        Effect.sync(() => {
          updates.push(update);
          return { ok: true as const };
        }),
      awaitTermination: Effect.never,
      shutdown: Effect.void,
    };
    const actorFactory = SessionActorFactory.of({
      spawn: (input) =>
        Effect.sync(() => {
          spawns.push(input);
          return actor;
        }),
    });

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeSessionEvents().pipe(
        Effect.provideService(RunnerSessionStore, store),
      );
      const supervisor = yield* makeSessionSupervisor({
        runnerId: RUNNER_ID,
        cpuCount: 4,
        memoryMiB: 8192,
      }).pipe(
        Effect.provideService(RunnerSessionStore, store),
        Effect.provideService(SessionActorFactory, actorFactory),
        Effect.provideService(SessionEvents, events),
      );
      const update = Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
        sessionId: SESSION_ID,
        action: "stage",
        path: "src/main.ts",
      });
      const restored = yield* supervisor.findOrRestoreActor(SESSION_ID);
      assert(restored);
      assertEquals(yield* restored.updateGitFile(update), { ok: true });
      assertEquals(updates, [update]);
      assertEquals(spawns.length, 2);
      assertEquals(spawns.map((spawn) => spawn.mode), ["reconcile", "restore"]);
      assertEquals(spawns.some((spawn) => "modelRuntime" in spawn), false);
    })));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor removes terminated actors before restoring them again", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    await Effect.runPromise(
      store.session.create(
        SESSION_ID,
        sessionDefinition("openorb/actor-termination-test"),
        CREATED_AT,
      ),
    );
    await Effect.runPromise(store.session.completeInitialRun(SESSION_ID));

    const firstTermination = Promise.withResolvers<void>();
    const secondTermination = Promise.withResolvers<void>();
    let restoreSpawns = 0;
    const actorFactory = SessionActorFactory.of({
      spawn: (input) => {
        if (input.mode === "reconcile") {
          return Effect.succeed(unavailableActor(Promise.resolve()));
        }
        const termination = restoreSpawns++ === 0
          ? firstTermination.promise
          : secondTermination.promise;
        return Effect.succeed(unavailableActor(termination));
      },
    });

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeSessionEvents().pipe(
        Effect.provideService(RunnerSessionStore, store),
      );
      const supervisor = yield* makeSessionSupervisor({
        runnerId: RUNNER_ID,
        cpuCount: 4,
        memoryMiB: 8192,
      }).pipe(
        Effect.provideService(RunnerSessionStore, store),
        Effect.provideService(SessionActorFactory, actorFactory),
        Effect.provideService(SessionEvents, events),
      );
      const first = yield* supervisor.findOrRestoreActor(SESSION_ID);
      assert(first);
      firstTermination.resolve();
      yield* Effect.sleep(1);
      const second = yield* supervisor.findOrRestoreActor(SESSION_ID);
      assert(second);
      assert(first !== second);
      assertEquals(restoreSpawns, 2);
    })));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor restarts one crashed actor without replay and quarantines a crash loop", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const stableSessionId = Schema.decodeUnknownSync(SessionId)(
      "01989d78-65ee-7f6a-a97e-0f16ad134c19",
    );
    for (
      const [id, branch] of [
        [SESSION_ID, "openorb/crash-loop-test"],
        [stableSessionId, "openorb/stable-sibling-test"],
      ] as const
    ) {
      await Effect.runPromise(store.session.create(id, sessionDefinition(branch), CREATED_AT));
      await Effect.runPromise(store.session.completeInitialRun(id));
    }

    const crashSignals = Array.from(
      { length: 4 },
      () => Promise.withResolvers<Exit.Exit<void, PersistentActorError>>(),
    );
    const stableTermination = new Promise<void>(() => {});
    const spawns: SessionActorInput[] = [];
    let crashActorCount = 0;
    const actorFactory = SessionActorFactory.of({
      spawn: (input) =>
        Effect.sync(() => {
          spawns.push(input);
          if (input.mode === "reconcile" && input.trigger === "runner-start") {
            return passiveActor(
              input.metadata.id,
              Effect.never,
            );
          }
          if (input.metadata.id === stableSessionId) {
            return unavailableActor(stableTermination, stableSessionId);
          }
          const signal = crashSignals[crashActorCount++];
          assert(signal, "Unexpected actor spawn after the restart budget was exhausted.");
          return passiveActor(
            SESSION_ID,
            Effect.promise(() => signal.promise),
          );
        }),
    });

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeSessionEvents().pipe(
        Effect.provideService(RunnerSessionStore, store),
      );
      const supervisor = yield* makeSessionSupervisor({
        runnerId: RUNNER_ID,
        cpuCount: 4,
        memoryMiB: 8192,
      }).pipe(
        Effect.provideService(RunnerSessionStore, store),
        Effect.provideService(SessionActorFactory, actorFactory),
        Effect.provideService(SessionEvents, events),
      );
      const first = yield* supervisor.findOrRestoreActor(SESSION_ID);
      const sibling = yield* supervisor.findOrRestoreActor(stableSessionId);
      assert(first);
      assert(sibling);
      const quarantineObserved = yield* events.watch(SESSION_ID, 0).pipe(
        Stream.filter((item) =>
          item.event.type === "session.state" &&
          item.event.issues.some((issue) => issue.category === "actor-crash")
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("1 second"),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const crash = Exit.fail(
        new PersistentActorError({
          persistenceId: SESSION_ID,
          operation: "append",
          message: "Injected actor defect.",
          cause: new Error("injected"),
        }),
      );
      for (let index = 0; index < crashSignals.length; index++) {
        crashSignals[index]!.resolve(crash);
        if (index < crashSignals.length - 1) {
          yield* Effect.promise(() => waitForValue(() => crashActorCount, index + 2));
        }
      }
      yield* Fiber.join(quarantineObserved);

      assertEquals(supervisor.findActor(stableSessionId), sibling);
      assertEquals(yield* supervisor.findOrRestoreActor(SESSION_ID), undefined);
      const quarantined = supervisor.withQuarantineFailure(
        yield* store.getSessionSnapshot(SESSION_ID),
      );
      assertEquals(quarantined.state, "error");
      assertEquals(quarantined.issues.at(-1)?.category, "actor-crash");
      assertEquals(quarantined.issues.at(-1)?.recovery, "none");
      const restarts = spawns.filter((input) =>
        input.metadata.id === SESSION_ID && input.mode === "reconcile" &&
        input.trigger === "actor-crash"
      );
      assertEquals(restarts.length, 3);
      assertEquals(restarts.some((input) => "modelRuntime" in input), false);
    })));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a Git-only restore handles concurrent Git update and wake credentials", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const payload = createProvisionPayload("openorb/git-then-prompt-test");
    await Effect.runPromise(
      store.session.create(payload.sessionId, sessionDefinition(payload.branchName), CREATED_AT),
    );
    await Effect.runPromise(store.session.completeInitialRun(
      SESSION_ID,
      "available",
      "0123456789abcdef0123456789abcdef01234567",
    ));
    let piCreations = 0;
    const createPiSession: CreateRawPiSession = (options) => {
      piCreations++;
      return createSettlingPiSession(options);
    };

    await withSupervisor(
      { cpuCount: 4, memoryMiB: 8192, createPiSession },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        const update = Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
          sessionId: SESSION_ID,
          action: "stage",
          path: "src/main.ts",
        });
        const [updated, woken] = await Effect.runPromise(Effect.all([
          supervisor.findOrRestoreActor(SESSION_ID).pipe(
            Effect.flatMap((actor) =>
              actor ? actor.updateGitFile(update) : Effect.die("Git actor unavailable")
            ),
          ),
          supervisor.findOrRestoreActor(SESSION_ID).pipe(
            Effect.flatMap((actor) =>
              actor ? actor.wake(wakePayload()) : Effect.die("Wake actor unavailable")
            ),
          ),
        ], { concurrency: "unbounded" }));
        assertEquals(updated, { ok: true });
        assertEquals(woken, { ok: true });
        assertEquals(piCreations, 1);

        const actor = await Effect.runPromise(supervisor.findOrRestoreActor(SESSION_ID));
        assert(actor);

        const prompt = (text: string) =>
          Schema.decodeUnknownSync(PromptSessionPayload)({
            sessionId: SESSION_ID,
            clientRequestId: crypto.randomUUID(),
            prompt: text,
            modelRuntime: MODEL_RUNTIME,
          });
        const first = await Effect.runPromise(actor.prompt(prompt("Continue after staging")));
        assert(first.ok);
        assertEquals(first.mode, "started");
        await waitForState(store, "ready");
        const second = await Effect.runPromise(actor.prompt(prompt("Continue again")));
        assert(second.ok);
        assertEquals(second.mode, "started");
        await waitForState(store, "ready");
        assertEquals(piCreations, 1);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed Pi opens are visible and leave a Git-only restore retryable", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const payload = createProvisionPayload("openorb/lazy-open-retry-test");
    await Effect.runPromise(
      store.session.create(payload.sessionId, sessionDefinition(payload.branchName), CREATED_AT),
    );
    await Effect.runPromise(store.session.completeInitialRun(
      SESSION_ID,
      "available",
      "0123456789abcdef0123456789abcdef01234567",
    ));
    let piOpenAttempts = 0;
    const createPiSession: CreateRawPiSession = (options) => {
      piOpenAttempts++;
      return piOpenAttempts <= 2
        ? Effect.fail(new AgentHarnessError("Injected lazy Pi open failure.", undefined))
        : createSettlingPiSession(options);
    };

    await withSupervisor(
      { cpuCount: 4, memoryMiB: 8192, createPiSession },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor, events) => {
        const update = Schema.decodeUnknownSync(UpdateSessionGitFilePayload)({
          sessionId: SESSION_ID,
          action: "stage",
          path: "src/main.ts",
        });
        const actor = await Effect.runPromise(supervisor.findOrRestoreActor(SESSION_ID));
        assert(actor);
        const visibleWakeIssue = waitForVisibleIssue(
          events,
          SESSION_ID,
          "model",
          "model session could not be restored",
        );
        assertEquals(await Effect.runPromise(actor.wake(wakePayload())), {
          ok: false,
          message: "The agent session could not be restored.",
        });
        assertEquals((await visibleWakeIssue).state.stage, "ready");
        assertEquals(piOpenAttempts, 1);
        assertEquals(await Effect.runPromise(actor.updateGitFile(update)), { ok: true });

        const prompt = (text: string) =>
          Schema.decodeUnknownSync(PromptSessionPayload)({
            sessionId: SESSION_ID,
            clientRequestId: crypto.randomUUID(),
            prompt: text,
            modelRuntime: MODEL_RUNTIME,
          });
        const visiblePromptIssue = waitForVisibleIssue(
          events,
          SESSION_ID,
          "model",
          "model run failed",
        );
        const first = await Effect.runPromise(
          actor.prompt(prompt("First attempt")).pipe(Effect.timeout("1 second")),
        );
        assertEquals(first.ok, false);
        assertEquals((await visiblePromptIssue).state.stage, "ready");
        assertEquals(piOpenAttempts, 2);
        const issue = (await Effect.runPromise(store.readMetadata(SESSION_ID))).issues.findLast(
          (candidate) => candidate.category === "model",
        );
        assert(issue);
        assertEquals(issue.diagnostics, undefined);

        assertEquals(await Effect.runPromise(actor.updateGitFile(update)), { ok: true });
        const retry = await Effect.runPromise(
          actor.prompt(prompt("Retry")).pipe(Effect.timeout("1 second")),
        );
        assert(retry.ok);
        assertEquals(retry.mode, "started");
        await waitForState(store, "ready");
        assertEquals(piOpenAttempts, 3);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor marks interrupted provisioning for explicit retry", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const payload = createProvisionPayload("openorb/restart-provisioning-test");
    await Effect.runPromise(
      store.session.create(payload.sessionId, sessionDefinition(payload.branchName), CREATED_AT),
    );

    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
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
      provisioning: SESSION_ID,
      initialRun: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c12",
      ),
      promptRun: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c13",
      ),
      ready: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c14",
      ),
      error: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c15",
      ),
    };
    for (const [name, id] of Object.entries(ids)) {
      await Effect.runPromise(
        store.session.create(id, sessionDefinition(`openorb/reconcile-${name}`), CREATED_AT),
      );
    }
    await Effect.runPromise(store.session.startInitialRun(ids.initialRun));
    await Effect.runPromise(store.session.completeInitialRun(ids.promptRun));
    const promptRunId = Schema.decodeUnknownSync(RunId)(
      "01989d78-65ee-7f6a-a97e-0f16ad134c16",
    );
    await Effect.runPromise(store.session.appendAll(ids.promptRun, [
      { type: "run.requested", runId: promptRunId, purpose: "prompt", issues: [] },
      {
        type: "run.started",
        runId: promptRunId,
        acceptedAt: "2026-08-17T12:10:00Z",
      },
    ]));
    await Effect.runPromise(store.session.completeInitialRun(ids.ready));
    await Effect.runPromise(store.session.append(ids.error, {
      type: "provisioning.failed",
      issue: {
        category: "vm-start",
        severity: "failure",
        message: "The VM could not be started.",
        recovery: "retry-provisioning",
      },
    }));

    let piCreations = 0;
    const createPiSession: CreateRawPiSession = (options) => {
      piCreations++;
      return createSettlingPiSession(options);
    };
    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        createPiSession,
      },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor, events) => {
        const interruptedRun = await waitForVisibleIssue(
          events,
          ids.promptRun,
          "operation-uncertain",
          "Agent Run was interrupted",
        );
        assertEquals(interruptedRun.issue.severity, "failure");
        assertEquals(interruptedRun.state.stage, "failed");
        assertEquals(
          (await Effect.runPromise(store.readMetadata(ids.provisioning))).state,
          "error",
        );
        assertEquals((await Effect.runPromise(store.readMetadata(ids.initialRun))).state, "error");
        assertEquals((await Effect.runPromise(store.readMetadata(ids.promptRun))).state, "error");
        assertEquals((await Effect.runPromise(store.readMetadata(ids.ready))).state, "ready");
        assertEquals((await Effect.runPromise(store.readMetadata(ids.error))).state, "error");
        assertEquals(supervisor.activeSessionCount(), 0);
        assertEquals(piCreations, 0);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor restart preserves only a valid published checkpoint", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = await makeStore(directory);
    const sessions = {
      interruptedResume: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c21",
      ),
      interruptedCheckpoint: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c22",
      ),
      missingCheckpoint: Schema.decodeUnknownSync(SessionId)(
        "01989d78-65ee-7f6a-a97e-0f16ad134c23",
      ),
    };
    const checkpointFiles = {
      current: "checkpoint-01989d78-65ee-7f6a-a97e-0f16ad134c31.qcow2",
      obsolete: "checkpoint-01989d78-65ee-7f6a-a97e-0f16ad134c32.qcow2",
      partial: "checkpoint-01989d78-65ee-7f6a-a97e-0f16ad134c33.qcow2",
      missing: "checkpoint-01989d78-65ee-7f6a-a97e-0f16ad134c34.qcow2",
      invalidObsolete: "checkpoint-01989d78-65ee-7f6a-a97e-0f16ad134c35.qcow2",
    };
    const checkpointMetadata = (file: string) => ({
      file,
      guestAssetBuildId: "02e784cb-e063-5138-b1c4-334e8a3307a9",
      createdWithVmm: "qemu" as const,
      compatibleVmm: ["qemu" as const],
    });
    const checkpointPath = (sessionId: SessionId, file: string) =>
      join(directory, "sessions", sessionId, "checkpoints", file);

    for (const [name, sessionId] of Object.entries(sessions)) {
      await Effect.runPromise(
        store.session.create(
          sessionId,
          sessionDefinition(`openorb/restart-checkpoint-${name}`),
          CREATED_AT,
        ),
      );
      await Effect.runPromise(store.session.completeInitialRun(sessionId));
    }

    await Effect.runPromise(store.session.append(sessions.interruptedResume, {
      type: "checkpoint.started",
      file: checkpointFiles.current,
    }));
    await Deno.writeTextFile(
      checkpointPath(sessions.interruptedResume, checkpointFiles.current),
      "published checkpoint",
    );
    await Effect.runPromise(store.session.append(sessions.interruptedResume, {
      type: "checkpoint.published",
      checkpoint: checkpointMetadata(checkpointFiles.current),
    }));
    await Deno.writeTextFile(
      checkpointPath(sessions.interruptedResume, checkpointFiles.obsolete),
      "obsolete checkpoint",
    );
    await Effect.runPromise(store.session.append(sessions.interruptedResume, {
      type: "restoration.started",
      restorationId: "01989d78-65ee-7f6a-a97e-0f16ad134c41",
      intent: { _tag: "ResumeCheckpoint", continuation: { _tag: "Wake" } },
    }));

    await Effect.runPromise(store.session.append(sessions.interruptedCheckpoint, {
      type: "checkpoint.started",
      file: checkpointFiles.partial,
    }));
    await Deno.writeTextFile(
      checkpointPath(sessions.interruptedCheckpoint, checkpointFiles.partial),
      "partial checkpoint",
    );

    await Effect.runPromise(store.session.append(sessions.missingCheckpoint, {
      type: "checkpoint.started",
      file: checkpointFiles.missing,
    }));
    await Effect.runPromise(store.session.append(sessions.missingCheckpoint, {
      type: "checkpoint.published",
      checkpoint: checkpointMetadata(checkpointFiles.missing),
    }));
    await Deno.writeTextFile(
      checkpointPath(sessions.missingCheckpoint, checkpointFiles.invalidObsolete),
      "obsolete checkpoint",
    );

    let piCreations = 0;
    await withSupervisor(
      {
        cpuCount: 4,
        memoryMiB: 8192,
        createPiSession: (options) => {
          piCreations++;
          return createSettlingPiSession(options);
        },
      },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        const resumed = await Effect.runPromise(
          store.readMetadata(sessions.interruptedResume),
        );
        assertEquals(resumed.state, "error");
        assertEquals(resumed.checkpoint?.file, checkpointFiles.current);
        assertEquals(resumed.checkpointCandidate, undefined);
        assertEquals(
          resumed.issues.findLast((issue) => issue.severity === "failure")?.recovery,
          "resume-prior-checkpoint",
        );
        await Deno.stat(checkpointPath(sessions.interruptedResume, checkpointFiles.current));
        await assertPathMissing(
          checkpointPath(sessions.interruptedResume, checkpointFiles.obsolete),
        );

        const interrupted = await Effect.runPromise(
          store.readMetadata(sessions.interruptedCheckpoint),
        );
        assertEquals(interrupted.state, "error");
        assertEquals(interrupted.checkpoint, undefined);
        assertEquals(interrupted.checkpointCandidate, undefined);
        await assertPathMissing(
          checkpointPath(sessions.interruptedCheckpoint, checkpointFiles.partial),
        );

        const invalid = await Effect.runPromise(
          store.readMetadata(sessions.missingCheckpoint),
        );
        assertEquals(invalid.state, "error");
        assertEquals(invalid.checkpoint, undefined);
        await assertPathMissing(
          checkpointPath(sessions.missingCheckpoint, checkpointFiles.invalidObsolete),
        );
        assertEquals(supervisor.activeSessionCount(), 0);
        assertEquals(piCreations, 0);
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
    const actorFactory = SessionActorFactory.of({
      spawn: () => Effect.die("An actor must not be spawned during reconciliation."),
    });
    const error = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeSessionEvents().pipe(
        Effect.provideService(RunnerSessionStore, failingStore),
      );
      return yield* Effect.flip(
        makeSessionSupervisor({
          runnerId: RUNNER_ID,
          cpuCount: 4,
          memoryMiB: 8192,
        }).pipe(
          Effect.provideService(RunnerSessionStore, failingStore),
          Effect.provideService(SessionActorFactory, actorFactory),
          Effect.provideService(SessionEvents, events),
        ),
      );
    })));
    assertEquals(error._tag, "SessionSupervisorInitializationError");
    assertEquals(error.cause, cause);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor does not impose a concurrent session-count limit", async () => {
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
    const configuredOptions: Omit<SessionSupervisorOptions, "runnerId"> = {
      cpuCount: 4,
      memoryMiB: 8192,
    };

    await withSupervisor(
      { ...configuredOptions, createPiSession: neverSettlingPiSession },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        await Effect.runPromise(supervisor.provision(first));
        assertEquals(supervisor.activeSessionCount(), 1);
        await Effect.runPromise(supervisor.provision(second));
        assertEquals(supervisor.activeSessionCount(), 2);
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
      { cpuCount: 4, memoryMiB: 8192, createPiSession },
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
        const actor = requireActor(supervisor);
        const first = Effect.runPromise(actor.prompt(prompt("First continuation")));
        await firstContinuationStarted.promise;
        const second = Effect.runPromise(actor.prompt(prompt("Second continuation")));
        await followUpAccepted.promise;
        releaseContinuations.resolve();
        const [firstAccepted, secondAccepted] = await Promise.all([first, second]);

        assert(firstAccepted.ok);
        assert(secondAccepted.ok);
        assertEquals(firstAccepted.mode, "started");
        assertEquals(secondAccepted.mode, "follow-up");
        assertEquals(secondAccepted.runId, firstAccepted.runId);
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor rejects active deletion, then removes an idle session idempotently", async () => {
  const directory = await Deno.makeTempDir();
  const initialRunStarted = Promise.withResolvers<void>();
  const releaseInitialRun = Promise.withResolvers<void>();
  const createPiSession: CreateRawPiSession = () => {
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
          initialRunStarted.resolve();
          await releaseInitialRun.promise;
          active = false;
        },
        followUp: () => Promise.resolve(),
        clearQueue: () => ({ steering: [], followUp: [] }),
        abort: () => Promise.resolve(),
        dispose() {},
      },
    });
  };

  try {
    const store = await makeStore(directory);
    await withSupervisor(
      { cpuCount: 4, memoryMiB: 8192, createPiSession },
      store,
      fakeEnvironmentProvider(new FakeEnvironment()),
      async (supervisor) => {
        await Effect.runPromise(
          supervisor.provision(createProvisionPayload("openorb/session-deletion-test")),
        );
        await initialRunStarted.promise;
        const active = await Effect.runPromise(supervisor.deleteSession(SESSION_ID));
        assertEquals(active.ok, false);
        assert(supervisor.findActor(SESSION_ID));

        releaseInitialRun.resolve();
        await waitForState(store, "ready");
        assertEquals(await Effect.runPromise(supervisor.deleteSession(SESSION_ID)), { ok: true });
        await assertPathMissing(join(directory, "sessions", SESSION_ID));
        assertEquals(await Effect.runPromise(supervisor.deleteSession(SESSION_ID)), { ok: true });
      },
    );
  } finally {
    releaseInitialRun.resolve();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SessionSupervisor retains deletion admission after a retryable storage failure", async () => {
  const directory = await Deno.makeTempDir();
  try {
    let removeCalls = 0;
    const durableStore = await makeStore(directory);
    const store: RunnerSessionStoreService = {
      ...durableStore,
      removeSessionStorage: () =>
        Effect.suspend(() => {
          removeCalls++;
          return removeCalls === 1
            ? Effect.fail(
              new RunnerSessionStoreFailure({
                operation: "remove-session-storage",
                message: "Injected partial cleanup failure.",
                cause: new Error("injected"),
              }),
            )
            : Effect.void;
        }),
    };
    const { failure, restored, retried } = await Effect.runPromise(Effect.scoped(Effect.gen(
      function* () {
        const events = yield* makeSessionEvents().pipe(
          Effect.provideService(RunnerSessionStore, store),
        );
        const supervisor = yield* makeSessionSupervisor({
          runnerId: RUNNER_ID,
          cpuCount: 4,
          memoryMiB: 8192,
        }).pipe(
          Effect.provideService(RunnerSessionStore, store),
          Effect.provideService(SessionActorFactory, {
            spawn: () => Effect.die("unexpected actor spawn"),
          }),
          Effect.provideService(SessionEvents, events),
        );

        const failure = yield* Effect.flip(supervisor.deleteSession(SESSION_ID));
        const restored = yield* supervisor.findOrRestoreActor(SESSION_ID);
        const retried = yield* supervisor.deleteSession(SESSION_ID);
        return { failure, restored, retried };
      },
    )));
    assertEquals(failure.operation, "remove-session-storage");
    assertEquals(restored, undefined);
    assertEquals(retried, { ok: true });
    assertEquals(removeCalls, 2);
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
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    ref: "main",
    branchName,
    gitAuthor: GIT_AUTHOR,
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
  state: "ready" | "running" | "stopped" | "error",
  timeoutMs = 1_000,
) {
  const deadline = Date.now() + timeoutMs;
  let currentState: string | undefined;
  while (Date.now() < deadline) {
    const metadata = await Effect.runPromise(store.readMetadata(SESSION_ID));
    currentState = metadata.state;
    if (metadata.state === state) return;
    if (metadata.state === "error" && state !== "error") {
      throw new Error("Session provisioning failed.");
    }
    await delay(10);
  }
  throw new Error(`Session did not reach ${state}; current state is ${currentState}.`);
}

async function waitForVisibleIssue(
  events: SessionEvents,
  sessionId: typeof SessionId.Type,
  category: SessionIssueCategory,
  messagePart?: string,
) {
  const entries = await Effect.runPromise(
    events.watch(sessionId, 0).pipe(
      Stream.filter((entry) =>
        entry.event.type === "session.state" &&
        entry.event.issues.some((issue) =>
          issue.category === category &&
          (messagePart === undefined || issue.message.includes(messagePart))
        )
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("1 second"),
    ),
  );
  const state = Array.from(entries)[0]?.event;
  assert(state?.type === "session.state");
  const issue = state.issues.find((candidate) =>
    candidate.category === category &&
    (messagePart === undefined || candidate.message.includes(messagePart))
  );
  assert(issue !== undefined);
  return { issue, state };
}

function promptPayload(prompt: string, githubToken?: string) {
  return Schema.decodeUnknownSync(PromptSessionPayload)({
    sessionId: SESSION_ID,
    clientRequestId: crypto.randomUUID(),
    prompt,
    modelRuntime: MODEL_RUNTIME,
    ...(githubToken === undefined ? {} : { githubToken }),
  });
}

function wakePayload(
  githubToken?: string,
  recovery?: "resume-prior-checkpoint" | "start-clean-vm",
) {
  return Schema.decodeUnknownSync(WakeSessionPayload)({
    sessionId: SESSION_ID,
    modelRuntime: MODEL_RUNTIME,
    ...(githubToken === undefined ? {} : { githubToken }),
    ...(recovery === undefined ? {} : { recovery }),
  });
}

function stopPayload() {
  return Schema.decodeUnknownSync(StopSessionPayload)({ sessionId: SESSION_ID });
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
    throw new Error(`Expected ${path} not to exist.`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function makeStore(workingDirectory: string): Promise<TestStore> {
  const storeLive = runnerSessionStoreLayer({ workingDirectory, runnerId: RUNNER_ID }).pipe(
    Layer.provideMerge(
      sessionJournalLayer(workingDirectory).pipe(Layer.provideMerge(platformLayer)),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const store = yield* RunnerSessionStore;
      const session = makeSessionFixture(store, journal, RUNNER_ID);
      return { ...store, journal, session };
    }).pipe(Effect.provide(storeLive)),
  );
}

function requireActor(supervisor: SessionSupervisor): SessionActor {
  const actor = supervisor.findActor(SESSION_ID);
  assert(actor, "Session supervisor did not contain the expected actor.");
  return actor;
}

function unavailableActor(
  termination: Promise<void>,
  sessionId: typeof SessionId.Type = SESSION_ID,
): SessionActor {
  return passiveActor(
    sessionId,
    Effect.promise(() => termination).pipe(Effect.as(Exit.void)),
  );
}

function passiveActor(
  sessionId: typeof SessionId.Type,
  awaitTermination: SessionActor["awaitTermination"],
): SessionActor {
  return {
    sessionId,
    activeRunId: undefined,
    active: false,
    wake: () => Effect.die("unexpected wake"),
    prompt: () => Effect.die("unexpected prompt"),
    abort: () => Effect.die("unexpected abort"),
    stop: () => Effect.die("unexpected stop"),
    delete: () => Effect.succeed({ ok: true }),
    updateGitFile: () => Effect.die("unexpected Git file update"),
    awaitTermination,
    shutdown: Effect.void,
  };
}

async function waitForValue<Value>(
  read: () => Value,
  expected: Value,
  timeoutMs = 1_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (Object.is(value, expected)) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for the expected value.");
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

async function waitForActorInactive(actor: SessionActor, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!actor.active) return;
    await delay(10);
  }
  throw new Error("Session actor did not become inactive.");
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
  options: Omit<SessionSupervisorOptions, "runnerId"> & {
    readonly createPiSession?: CreateRawPiSession;
  },
  store: TestStore,
  environmentProvider: AgentEnvironmentProvider,
  use: (supervisor: SessionSupervisor, events: SessionEvents) => Promise<void>,
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
        const actorFactory = yield* makeSessionActorFactory().pipe(
          Effect.provideService(Journal, store.journal),
          Effect.provideService(RunnerSessionStore, store),
          Effect.provideService(SessionEvents, events),
          Effect.provideService(AgentEnvironmentProvider, environmentProvider),
          Effect.provideService(AgentHarness, harness),
        );
        const supervisor = yield* makeSessionSupervisor({
          runnerId: RUNNER_ID,
          cpuCount: options.cpuCount,
          memoryMiB: options.memoryMiB,
          ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
        }).pipe(
          Effect.provideService(RunnerSessionStore, store),
          Effect.provideService(SessionActorFactory, actorFactory),
          Effect.provideService(SessionEvents, events),
        );
        yield* Effect.promise(() => use(supervisor, events));
      }),
    ),
  );
}
