import { assert, assertStringIncludes } from "@std/assert";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { RUNNER_PROTOCOL_VERSION, RunnerCapacity, RunnerId } from "@openorb/protocol/runner-api";
import { Effect, Exit, Schema, Scope } from "effect";
import { runRunnerRpc } from "../../runner/src/connection/rpc.ts";
import { runnerServicesLayer } from "../../runner/src/runtime/services.ts";
import {
  gondolinTestEnvironmentOptions,
  installLocalGuestImage,
} from "../../runner/test/environment/gondolin/local-guest-image.ts";
import { createRpcClient } from "./workspace/rpc-client.ts";

// Phase 1 of ADR 0005/0006 end to end: a Session Durable Object in celld runs Pi Durable, whose
// bash tool reaches a real Gondolin guest through the runner's Environment Link. Only point this at
// a disposable test/celld.jsonc fixture.
const gatewayUrl = Deno.env.get("OPENORB_TEST_GATEWAY_URL");
const enabled = gatewayUrl !== undefined && Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") === "1";

interface ConversationView {
  readonly entries: readonly { readonly model?: readonly Message[] }[];
}
interface Message {
  readonly role: string;
  readonly content?: unknown;
}

async function json(path: string, body: unknown, timeoutMs = 60_000) {
  const response = await fetch(new URL(path, gatewayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  assert(response.ok, `${path} failed with ${response.status}: ${text}`);
  return JSON.parse(text);
}

/** Follows the Session's event stream until `done` holds for the current Conversation View. */
async function waitForConversation(
  sessionId: string,
  done: (messages: readonly Message[]) => boolean,
  timeoutMs: number,
): Promise<readonly Message[]> {
  const url = new URL("/__session/events", gatewayUrl);
  url.searchParams.set("sessionId", sessionId);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  assert(response.ok && response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let view: ConversationView | undefined;
  try {
    while (true) {
      const { value, done: ended } = await reader.read();
      if (ended) throw new Error("The session event stream ended early.");
      buffer += value;
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data === undefined) continue;
        const event = JSON.parse(data.slice("data: ".length));
        if (event.type === "conversation.snapshot") view = event.view;
        else if (event.type === "conversation.ops" && view !== undefined) {
          // SAFETY: the Session emits Chord operations for exactly this view's previous revision.
          view = applyImmutable(view, event.ops as Op[]);
        }
        const messages = view?.entries.flatMap((entry) => entry.model ?? []) ?? [];
        if (done(messages)) return messages;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

Deno.test({
  name: "a Session Durable Object runs guest tools through a real runner's Environment Link",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const workspace = createRpcClient(new URL("/__workspace", gatewayUrl).href);
    await workspace.createAdministrator("e2e-fixture-password");
    const identity = await workspace.verifyAdministratorPassword("e2e-fixture-password");
    assert(identity, "use a fresh disposable celld fixture");
    const workspaceId = identity.workspaceId;
    const enrollment = await workspace.getRunnerEnrollmentToken(workspaceId);
    const runner = await workspace.enrollRunner({
      enrollmentPsk: enrollment.token,
      name: `E2E ${crypto.randomUUID()}`,
      architecture: "x64",
    });
    assert(runner);

    const directory = await Deno.makeTempDir({ prefix: "openorb-session-e2e-" });
    const scope = await Effect.runPromise(Scope.make());
    try {
      const capacity = new RunnerCapacity({
        activeSessions: 0,
        vmCpuCount: 2,
        vmMemoryMiB: 2048,
        diskFreeMiB: 50_000,
      });
      const runnerId = Schema.decodeUnknownSync(RunnerId)(runner.runnerId);
      const services = runnerServicesLayer({
        workingDirectory: directory,
        runnerId,
        gatewayUrl: gatewayUrl!,
        runnerToken: runner.runnerToken,
        guestImage: await installLocalGuestImage(directory),
        softwareEmulation: gondolinTestEnvironmentOptions().softwareEmulation ?? false,
        vmCpuCount: capacity.vmCpuCount,
        vmMemoryMiB: capacity.vmMemoryMiB,
      });
      Effect.runFork(
        runRunnerRpc({
          gatewayUrl: gatewayUrl!,
          runnerId,
          runnerToken: runner.runnerToken,
          runnerVersion: "e2e",
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          getCapacity: () => Promise.resolve(capacity),
        }).pipe(Effect.provide(services), Effect.provideService(Scope.Scope, scope)),
      );
      for (let attempt = 0;; attempt++) {
        const live = await fetch(
          new URL(
            `/__registry/live?workspaceId=${workspaceId}&runnerId=${runner.runnerId}`,
            gatewayUrl,
          ),
        ).then((response) => response.json());
        if (live !== null) break;
        assert(attempt < 100, "the runner did not connect");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const sessionId = crypto.randomUUID();
      // Creation boots the VM (minutes under software emulation) and submits the first prompt.
      const created = await json("/__session/create", {
        workspaceId,
        sessionId,
        runnerId: runner.runnerId,
        // The orb's 2 CPUs and 4 GiB host fit the smallest size under software emulation.
        orbSize: "tiny",
        repositoryUrl: "https://github.com/example/session-e2e.git",
        branchName: "openorb/session-e2e",
        gitAuthor: { name: "OpenOrb E2E", email: "e2e@example.com" },
        model: "faux/demo",
        thinkingLevel: "high",
        initialPrompt: "Run the guest command.",
      }, 15 * 60_000);
      assert(created.created);

      const messages = await waitForConversation(
        sessionId,
        (current) =>
          current.some((message) =>
            message.role === "assistant" && JSON.stringify(message).includes("The guest answered.")
          ),
        10 * 60_000,
      );
      const toolResult = messages.find((message) => message.role === "toolResult");
      assert(toolResult, "the bash tool result is missing");
      const output = JSON.stringify(toolResult.content);
      // Output only the guest can produce: its kernel, user, OpenOrb marker, and checkout write.
      assertStringIncludes(output, "Linux");
      assertStringIncludes(output, "guest=1");
      assertStringIncludes(output, "e2e");
      console.log(`[e2e] guest tool output: ${output}`);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await workspace.revokeRunner(workspaceId, runner.runnerId).catch(() => {});
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    }
  },
});
