import { assertEquals } from "@std/assert";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SessionId } from "@openorb/protocol/runner-api";
import { Effect, Schema, Stream } from "effect";

import type { AgentEnvironment } from "../../../src/environment/agent-environment.ts";
import { makePiAgentHarness } from "../../../src/harness/pi/layer.ts";
import type { OpenOrbPiSessionOptions } from "../../../src/harness/pi/session.ts";

const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const CONVERSATION_PROJECTION = {
  activate: () => Effect.succeed({ update() {}, dispose() {} }),
};

const MODEL_RUNTIME = {
  model: "opencode-go/deepseek-v4-flash",
  thinkingLevel: "high" as const,
  credential: { type: "api_key" as const, value: "model-secret" },
};

Deno.test("Pi harness exposes a finite, ordered, lossless run stream", async () => {
  let disposed = false;
  let suppliedTools: string[] = [];
  const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const harness = makePiAgentHarness({
      conversationProjection: CONVERSATION_PROJECTION,
      create: (options: OpenOrbPiSessionOptions) => {
        suppliedTools = options.tools.map((tool) => tool.name);
        let listener: (event: AgentSessionEvent) => void = () => {};
        let active = false;
        return Effect.succeed({
          session: {
            get isIdle() {
              return !active;
            },
            subscribe(next: (event: AgentSessionEvent) => void) {
              listener = next;
              return () => listener = () => {};
            },
            prompt(_input: string, options?: { preflightResult?: (success: boolean) => void }) {
              active = true;
              options?.preflightResult?.(true);
              for (let index = 0; index < 300; index++) listener({ type: "agent_start" });
              active = false;
              return Promise.resolve();
            },
            followUp: () => Promise.resolve(),
            clearQueue: () => ({ steering: [], followUp: [] }),
            abort: () => Promise.resolve(),
            dispose: () => disposed = true,
          },
        });
      },
    });
    const session = yield* harness.open({
      sessionId: SESSION_ID,
      environment: EMPTY_ENVIRONMENT,
      git: {
        repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
        branchName: "openorb/pi-layer-test",
      },
      modelRuntime: MODEL_RUNTIME,
      state: { sessionFile: "/state/session", agentDirectory: "/state/agent" },
    });
    const run = yield* session.start("Inspect");
    return yield* Stream.runCollect(run.events);
  })));

  assertEquals(Array.from(events).length, 300);
  assertEquals(Array.from(events).every((event) => event.type === "agent.started"), true);
  assertEquals(suppliedTools.sort(), ["bash", "edit", "read", "write"]);
  assertEquals(disposed, true);
});

Deno.test("Pi harness atomically clears queued follow-ups before aborting", async () => {
  const operations: string[] = [];
  const completed = Promise.withResolvers<void>();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let active = false;
    const harness = makePiAgentHarness({
      conversationProjection: CONVERSATION_PROJECTION,
      create: () =>
        Effect.succeed({
          session: {
            get isIdle() {
              return !active;
            },
            subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
            prompt: async (
              _input: string,
              options?: { preflightResult?: (success: boolean) => void },
            ) => {
              active = true;
              options?.preflightResult?.(true);
              await completed.promise;
              active = false;
            },
            followUp: () => Promise.resolve(),
            clearQueue: () => {
              operations.push("clear");
              return { steering: [], followUp: [] };
            },
            abort: () => {
              operations.push("abort");
              completed.resolve();
              return Promise.resolve();
            },
            dispose() {},
          },
        }),
    });
    const session = yield* harness.open({
      sessionId: SESSION_ID,
      environment: EMPTY_ENVIRONMENT,
      git: {
        repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
        branchName: "openorb/pi-layer-test",
      },
      modelRuntime: MODEL_RUNTIME,
      state: { sessionFile: "/state/session", agentDirectory: "/state/agent" },
    });
    const run = yield* session.start("Inspect");
    yield* run.abort;
    yield* Stream.runDrain(run.events);
  })));
  assertEquals(operations, ["clear", "abort"]);
});

const EMPTY_ENVIRONMENT: AgentEnvironment = {
  run: () => Effect.succeed({ exitCode: 0 }),
  runShell: () => Effect.succeed({ exitCode: 0 }),
  readFile: () => Effect.succeed(new Uint8Array()),
  access: () => Effect.void,
  writeFile: () => Effect.void,
  makeDirectory: () => Effect.void,
  detectImageMimeType: () => Effect.succeed(null),
};
