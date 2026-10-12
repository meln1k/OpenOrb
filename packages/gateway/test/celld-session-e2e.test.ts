import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
import { SCRIPTED_PNG_BASE64 } from "./session-fixture.ts";

// ADRs 0005 and 0006 end to end: a Session Durable Object in celld provisions the project, runs Pi
// Durable, whose tools reach a real Gondolin guest through the runner's Environment Link, publishes
// media to R2, and keeps a Git Snapshot. Only point this at a disposable test/celld.jsonc fixture.
const gatewayUrl = Deno.env.get("OPENORB_TEST_GATEWAY_URL");
const enabled = gatewayUrl !== undefined && Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") === "1";

const REPOSITORY_URL = "https://github.com/meln1k/openorb-test-repo.git";

interface GitSnapshot {
  readonly branch?: string;
  readonly sections: { readonly unstaged: { readonly files: readonly { path: string }[] } };
}

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

      const project = await workspace.saveProject(workspaceId, {
        name: `Session E2E ${crypto.randomUUID()}`,
        repositoryUrl: REPOSITORY_URL,
      });
      assert(project.status === "saved");
      const sessionId = crypto.randomUUID();
      // The prompt is admitted at once; provisioning boots the VM (minutes under software
      // emulation) and clones the repository while the agent's guest tools wait for it.
      const created = await json("/__session/create", {
        workspaceId,
        sessionId,
        project: {
          id: project.project.id,
          repositoryUrl: REPOSITORY_URL,
          ref: "main",
          branchName: "openorb/session-e2e",
          gitAuthor: { name: "OpenOrb E2E", email: "e2e@example.com" },
        },
        createdAt: new Date().toISOString(),
        placement: { provider: "runner", runnerId: runner.runnerId },
        // The orb's 2 CPUs and 4 GiB host fit the smallest size under software emulation.
        orbSize: "tiny",
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
      const [bashResult, publishResult] = messages.filter((message) =>
        message.role === "toolResult"
      );
      assert(bashResult && publishResult, "a tool result is missing");
      const output = JSON.stringify(bashResult.content);
      // Only the provisioned guest can produce this: the cloned session branch, its kernel, and
      // OpenOrb's guest marker; the readiness gate held the command until setup finished.
      assertStringIncludes(output, "openorb/session-e2e");
      assertStringIncludes(output, "Linux");
      assertStringIncludes(output, "guest=1");
      assertStringIncludes(output, "e2e-done");
      console.log(`[e2e] guest tool output: ${output}`);

      // publish_media copied the guest file into R2 and returned a transcript reference.
      const reference = /openorb-artifact:image:([0-9a-f-]{36})/.exec(
        JSON.stringify(publishResult.content),
      );
      assert(reference, `no media reference in ${JSON.stringify(publishResult.content)}`);
      const media = await fetch(
        new URL(`/__session/media?sessionId=${sessionId}&id=${reference[1]}`, gatewayUrl),
      );
      assert(media.ok, `media fetch failed: ${media.status}`);
      assertEquals(media.headers.get("content-type"), "image/png");
      assertEquals(
        new Uint8Array(await media.arrayBuffer()),
        Uint8Array.fromBase64(SCRIPTED_PNG_BASE64),
      );
      console.log(`[e2e] published media ${reference[1]} round-tripped through R2`);

      // The Session refreshed its Git Snapshot after the tool boundary.
      let snapshot: GitSnapshot | undefined;
      for (let attempt = 0; attempt < 120; attempt++) {
        snapshot = await (await fetch(
          new URL(`/__session/git?sessionId=${sessionId}`, gatewayUrl),
        )).json();
        if (snapshot?.sections.unstaged.files.some((file) => file.path === "e2e.txt")) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assertEquals(snapshot?.branch, "openorb/session-e2e");
      assert(
        snapshot?.sections.unstaged.files.some((file) => file.path === "e2e.txt"),
        `e2e.txt missing from ${JSON.stringify(snapshot)}`,
      );
      console.log(`[e2e] git snapshot: ${JSON.stringify(snapshot?.sections.unstaged.files)}`);

      // Skills load once from the first checkout and stay fixed so the prompt prefix stays
      // cacheable: the skill the guest command wrote later is not picked up by a restart.
      const restarted = await json(
        "/__session/control",
        { sessionId, action: "restart" },
        15 * 60_000,
      );
      assertEquals(restarted.state, "running");
      await json("/__session/submit", {
        sessionId,
        prompt: "Which skills do you have?",
        requestId: "skills-after-restart",
      }, 60_000);
      const answered = await waitForConversation(
        sessionId,
        (current) =>
          current.some((message) =>
            message.role === "assistant" && JSON.stringify(message).includes("Skills: ")
          ),
        5 * 60_000,
      );
      const skills = JSON.stringify(answered.findLast((message) => message.role === "assistant"));
      // The test repository has no skills: the catalog is empty, not pending and not refreshed.
      assertStringIncludes(skills, "Skills: <repository-skills>\\n\\n</repository-skills>");
      assert(!skills.includes("e2e-skill"), `the catalog changed after checkout: ${skills}`);
      console.log("[e2e] repository skills stayed fixed across an environment restart");

      const view = await (await fetch(
        new URL(`/__session/view?sessionId=${sessionId}`, gatewayUrl),
      )).json();
      assertEquals(view.issues, []);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await workspace.revokeRunner(workspaceId, runner.runnerId).catch(() => {});
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    }
  },
});
