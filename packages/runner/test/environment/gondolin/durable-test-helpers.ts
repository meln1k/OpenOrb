import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ToolDiagnostic,
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { SessionId } from "@openorb/protocol/runner-api";
import { assert, assertEquals } from "@std/assert";
import { Effect, Exit, Schema, Scope, Stream } from "effect";
import {
  type AgentEnvironment,
  AgentEnvironmentError,
} from "../../../src/environment/agent-environment.ts";
import type {
  AgentHarnessOpenOptions,
  AgentHarnessSession,
} from "../../../src/harness/agent-harness.ts";
import { createGuestExecutionEnv } from "../../../src/harness/durable/environment.ts";
import { makeDurableAgentHarness } from "../../../src/harness/durable/layer.ts";
import { createDurableTools } from "../../../src/harness/durable/tools.ts";
import type { SessionArtifactStore } from "../../../src/session/artifact-store.ts";

const artifacts: SessionArtifactStore = {
  publish: () => Effect.die("Media publication is not exercised by these integration tests"),
  readChunk: () => Effect.die("Media retrieval is not exercised by these integration tests"),
};

export function durableTestOptions(
  environment: AgentEnvironment,
  directory: string,
  git: AgentHarnessOpenOptions["git"] = {
    repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    branchName: "openorb/gondolin-integration-test",
  },
  modelApiKey = "test-model-provider-key",
): AgentHarnessOpenOptions {
  return {
    sessionId: Schema.decodeUnknownSync(SessionId)("01989d78-65ee-7f6a-a97e-0f16ad134c10"),
    environment,
    environmentState: "running",
    environmentStates: Stream.make("running"),
    state: { directory },
    git,
    modelRuntime: {
      model: "opencode-go/deepseek-v4-flash",
      thinkingLevel: "high",
      credential: { type: "api_key", value: modelApiKey },
    },
    controlEnvironment: () =>
      Effect.fail(new AgentEnvironmentError("This test owns the guest lifecycle", undefined)),
  };
}

/** Invoke the production Durable executors; keep streamed output distinct from returned content. */
export function guestTools(options: AgentHarnessOpenOptions) {
  const tools = createDurableTools(options, artifacts);
  const env = createGuestExecutionEnv(options.environment, `integration:${options.sessionId}`);
  return {
    tools,
    async execute(
      name: "bash" | "read" | "readImage" | "write" | "edit",
      args: Record<string, JsonValue>,
      options: {
        signal?: AbortSignal;
        onOutput?: (text: string) => void;
        expectError?: boolean;
      } = {},
    ) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert(tool, `Missing Durable tool: ${name}`);
      let output = "";
      const decoder = new TextDecoder();
      const diagnostics: ToolDiagnostic[] = [];
      // SAFETY: These executors only use env, output, and diagnostic. No harness task/storage
      // operations are emulated here; real model tests below use the actual scoped harness.
      const api = Object.assign({} as ToolExecutionApi, {
        env,
        output: (chunk: string | Uint8Array) => {
          const text = chunk instanceof Uint8Array
            ? decoder.decode(chunk, { stream: true })
            : chunk;
          output += text;
          options.onOutput?.(text);
        },
        diagnostic: (diagnostic: ToolDiagnostic) => diagnostics.push(diagnostic),
      });
      const context = options.signal === undefined
        ? BACKGROUND_CONTEXT
        : withAbortSignal(options.signal, BACKGROUND_CONTEXT);
      const result: ToolExecutionResult = await tool.execute(args, api, context).catch(
        (error: unknown) => {
          if (!options.expectError) throw error;
          return {
            isError: true,
            diagnostics: [{
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
            }],
          };
        },
      );
      output += decoder.decode();
      diagnostics.push(...result.diagnostics ?? []);
      assertEquals(
        result.isError ?? false,
        options.expectError ?? false,
        JSON.stringify(diagnostics),
      );
      const text =
        result.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ??
          "";
      return { result, output, text, diagnostics };
    },
  };
}

export async function openDurableSession(options: AgentHarnessOpenOptions) {
  const scope = Scope.makeUnsafe();
  try {
    const session = await Effect.runPromise(
      makeDurableAgentHarness(artifacts).open(options).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    return { session, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw cause;
  }
}

/** Admission is not completion: await an idle committed view containing this turn's answer. */
export async function submitAndWait(session: AgentHarnessSession, input: string) {
  const previousEntries = new Set(session.view.entries.map((entry) => entry.id));
  const submissionId = await Effect.runPromise(session.submit(input, crypto.randomUUID()));
  assert(Number.isSafeInteger(submissionId));
  const deadline = Date.now() + 10 * 60_000;
  while (session.view.docs["pi.live"]?.run) {
    assert(Date.now() < deadline, `Timed out waiting for Durable submission ${submissionId}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const entries = session.view.entries.filter((entry) => !previousEntries.has(entry.id));
  assert(entries.some((entry) => entry.kind === "pi.user"), "Input was not committed");
  const answer = entries.findLast((entry) => entry.kind === "pi.assistant")?.model?.[0];
  assert(answer?.role === "assistant", "No committed model answer");
  assertEquals(answer.stopReason, "stop", "The model did not finish successfully");
  return submissionId;
}
