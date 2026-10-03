import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import { Effect, Layer, PubSub, type Scope, Stream } from "effect";
import {
  GitAuthor,
  ProjectId,
  RunnerId,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  type AgentEnvironment,
  type AgentEnvironmentOptions,
  AgentEnvironmentProvider,
} from "../../../src/environment/agent-environment.ts";
import {
  AgentHarness,
  type AgentHarnessOpenOptions,
  type ConversationView,
} from "../../../src/harness/agent-harness.ts";
import { makeSessionEvents, SessionEvents } from "../../../src/session/events.ts";
import { sessionArtifactStoreLayer } from "../../../src/session/artifact-store.ts";
import { RunnerSessionDefinition } from "../../../src/session/definition.ts";
import { Journal } from "../../../src/session/persistent-actor/journal.ts";
import { sessionJournalLayer } from "../../../src/session/persistent-actor/session-journal.ts";
import { RunnerSessionStore, runnerSessionStoreLayer } from "../../../src/session/store.ts";
import { makeSessionActorFactory, SessionActorFactory } from "../../../src/session/actor/index.ts";
import type { RunnerSessionMetadata } from "../../../src/session/actor/state.ts";

export const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134c10");
export const RUNNER_ID = RunnerId.make("01989d78-65ee-7f6a-a97e-0f16ad134c09");
export const MODEL = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "test-model-secret" },
};
export const definition = new RunnerSessionDefinition({
  workspaceId: WorkspaceId.make("01989d78-65ee-7f6a-a97e-0f16ad134c12"),
  projectId: ProjectId.make("01989d78-65ee-7f6a-a97e-0f16ad134c11"),
  repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
  ref: "main",
  branchName: "openorb/test",
  gitAuthor: new GitAuthor({ name: "Tester", email: "test@example.com" }),
  initialPrompt: "Inspect the repository",
  model: MODEL.model,
  initialThinkingLevel: "high",
  orbSize: "small",
});
export const metadata: RunnerSessionMetadata = {
  id: SESSION_ID,
  runnerId: RUNNER_ID,
  definition,
  createdAt: "2026-08-17T12:00:00Z",
  checkoutState: "pending",
  issues: [],
  state: "provisioning",
  agentState: "paused",
  environmentState: "starting",
};
export const createInput = {
  mode: "create" as const,
  metadata,
  modelRuntime: MODEL,
  idleTimeoutMs: 60_000,
};

export class FakeEnvironment implements AgentEnvironment {
  commands: readonly string[][] = [];
  stops = 0;
  setup: Effect.Effect<void> = Effect.void;
  setupExitCode = 0;
  run: AgentEnvironment["run"] = (command, options) =>
    Effect.gen({ self: this }, function* () {
      this.commands = [...this.commands, [...command]];
      if (command.some((arg) => arg.includes(".agents/setup"))) {
        yield* this.setup;
        return { exitCode: this.setupExitCode };
      }
      if (command.includes("rev-parse") && options?.onOutput) {
        yield* options.onOutput({
          stream: "stdout",
          text: "0123456789abcdef0123456789abcdef01234567\n",
        }).pipe(Effect.orDie);
      }
      return { exitCode: 0 };
    });
  runShell: AgentEnvironment["runShell"] = () => Effect.succeed({ exitCode: 0 });
  readFile: AgentEnvironment["readFile"] = () => Effect.succeed(new Uint8Array());
  access = () => Effect.void;
  writeFile = () => Effect.void;
  makeDirectory = () => Effect.void;
  stat = () => Effect.die("unexpected stat");
  listDirectory = () => Effect.die("unexpected list");
  renameFile = () => Effect.die("unexpected rename");
  remove = () => Effect.die("unexpected remove");
  detectImageMimeType = () => Effect.succeed(null);
  stop = Effect.sync(() => {
    this.stops++;
  });
}

export const makeFakeHarness = Effect.gen(function* () {
  const views = yield* PubSub.unbounded<ConversationView>();
  let view: ConversationView = {
    // SAFETY: this fixture creates its single Durable conversation identifier.
    conversation: { id: 1 as ConversationId },
    entries: [],
    docs: {},
  };
  const opened: AgentHarnessOpenOptions[] = [];
  const requests: string[] = [];
  const submissions = new Map<string, number>();
  let closes = 0;
  let aborts = 0;
  let resumes = 0;
  let openGate: Effect.Effect<void> = Effect.void;
  const setBusy = (busy: boolean) =>
    Effect.gen(function* () {
      view = { ...view, docs: busy ? { "pi.live": { run: { taskId: 1, inputs: [1] } } } : {} };
      yield* PubSub.publish(views, view);
    });
  const harness = AgentHarness.of({
    open: (options) =>
      Effect.gen(function* () {
        opened.push(options);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closes++;
          })
        );
        yield* openGate;
        return {
          get view() {
            return view;
          },
          views: Stream.fromPubSub(views),
          updateModelRuntime: () => Effect.void,
          setThinkingLevel: (level) => Effect.succeed(level),
          submit: (_input, requestId) =>
            Effect.gen(function* () {
              const existing = submissions.get(requestId);
              if (existing !== undefined) return existing;
              requests.push(requestId);
              const submissionId = submissions.size + 2;
              submissions.set(requestId, submissionId);
              yield* setBusy(true);
              return submissionId;
            }),
          resume: Effect.sync(() => {
            resumes++;
          }),
          abort: Effect.sync(() => {
            aborts++;
          }).pipe(Effect.andThen(setBusy(false)), Effect.asVoid),
        };
      }),
  });
  return {
    harness,
    opened,
    requests,
    setBusy,
    setOpenGate: (gate: Effect.Effect<void>) => {
      openGate = gate;
    },
    get closes() {
      return closes;
    },
    get aborts() {
      return aborts;
    },
    get resumes() {
      return resumes;
    },
  };
});

export async function withFixture<A>(
  test: (fixture: {
    factory: SessionActorFactory;
    store: RunnerSessionStore;
    journal: Journal;
    fake: Effect.Success<typeof makeFakeHarness>;
    environments: FakeEnvironment[];
    attaches: AgentEnvironmentOptions[];
  }) => Effect.Effect<
    A,
    unknown,
    Scope.Scope | SessionActorFactory | SessionEvents | RunnerSessionStore
  >,
  configure: (environment: FakeEnvironment) => void = () => {},
  ensureStorage = true,
): Promise<A> {
  const directory = await Deno.makeTempDir();
  const platform = Layer.merge(DenoFileSystem.layer, DenoPath.layer);
  const storage = runnerSessionStoreLayer({ workingDirectory: directory, runnerId: RUNNER_ID })
    .pipe(
      Layer.provideMerge(sessionJournalLayer(directory).pipe(Layer.provideMerge(platform))),
    );
  try {
    return await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const store = yield* RunnerSessionStore;
        const journal = yield* Journal;
        if (ensureStorage) yield* store.ensureSessionStorage(SESSION_ID);
        const fake = yield* makeFakeHarness;
        const events = yield* makeSessionEvents({
          readView: () =>
            Promise.resolve({ conversation: { id: 1 as ConversationId }, entries: [], docs: {} }),
        });
        const environments: FakeEnvironment[] = [];
        const attaches: AgentEnvironmentOptions[] = [];
        const provider = AgentEnvironmentProvider.of({
          initializeRootDisk: (path) =>
            Effect.promise(() => Deno.writeFile(path, new Uint8Array())),
          make: (options) =>
            Effect.sync(() => {
              const environment = new FakeEnvironment();
              configure(environment);
              environments.push(environment);
              attaches.push(options);
              return environment;
            }),
        });
        return yield* Effect.gen(function* () {
          const factory = yield* makeSessionActorFactory();
          return yield* test({ factory, store, journal, fake, environments, attaches }).pipe(
            Effect.provideService(SessionActorFactory, factory),
          );
        }).pipe(
          Effect.provideService(AgentEnvironmentProvider, provider),
          Effect.provideService(AgentHarness, fake.harness),
          Effect.provideService(SessionEvents, events),
        );
      })).pipe(
        Effect.provide(
          Layer.merge(storage, sessionArtifactStoreLayer({ workingDirectory: directory })),
        ),
      ),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

export const eventually = (condition: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let n = 0; n < 200; n++) {
      if (condition()) return;
      yield* Effect.sleep(5);
    }
    return yield* Effect.die("Condition did not become true.");
  });
