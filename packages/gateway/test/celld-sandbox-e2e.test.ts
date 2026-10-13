import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { createRpcClient } from "./workspace/rpc-client.ts";
import { SCRIPTED_PNG_BASE64 } from "./session-fixture.ts";

// ADR 0007 end to end without a runner: a Session Durable Object in celld loads the just-bash
// sandbox through the Worker Loader as a facet, runs Pi's guest tools in its empty workspace, and
// publishes media to R2. Only point this at a disposable test/celld.jsonc fixture.
const gatewayUrl = Deno.env.get("OPENORB_TEST_GATEWAY_URL");

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

async function get(path: string, params: Record<string, string>) {
  const url = new URL(path, gatewayUrl);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert(response.ok, `${path} failed with ${response.status}`);
  return response;
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
  let view: { readonly entries: readonly { readonly model?: readonly Message[] }[] } | undefined;
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
  name: "a Session without a runner runs guest tools in the built-in sandbox",
  ignore: gatewayUrl === undefined,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const workspace = createRpcClient(new URL("/__workspace", gatewayUrl).href);
    await workspace.createAdministrator("sandbox-e2e-fixture-password");
    const identity = await workspace.verifyAdministratorPassword("sandbox-e2e-fixture-password");
    assert(identity, "use a fresh disposable celld fixture");
    const workspaceId = identity.workspaceId;
    const credentialReads = async () =>
      await (await get("/__workspace-credential-reads", {})).json() as number;
    const readsBefore = await credentialReads();
    const sessionId = crypto.randomUUID();
    // The Sandbox has no project: /workspace starts empty and no Git integration loads.
    const created = await json("/__session/create", {
      workspaceId,
      sessionId,
      createdAt: new Date().toISOString(),
      placement: { provider: "sandbox" },
      orbSize: "tiny",
      model: "faux/demo",
      thinkingLevel: "high",
      initialPrompt: "Run the guest command.",
    });
    assert(created.created);

    const messages = await waitForConversation(
      sessionId,
      (current) =>
        current.some((message) =>
          message.role === "assistant" && JSON.stringify(message).includes("The guest answered.")
        ),
      5 * 60_000,
    );
    const [bashResult, publishResult] = messages.filter((message) => message.role === "toolResult");
    assert(bashResult && publishResult, "a tool result is missing");
    const output = JSON.stringify(bashResult.content);
    // An empty workspace in a guest with neither Git nor uname, nor OpenOrb's VM marker.
    assertStringIncludes(output, "no-git");
    assertStringIncludes(output, "no-uname");
    assertStringIncludes(output, "e2e-done");
    console.log(`[e2e] sandbox tool output: ${output}`);

    const reference = /openorb-artifact:image:([0-9a-f-]{36})/.exec(
      JSON.stringify(publishResult.content),
    );
    assert(reference, `no media reference in ${JSON.stringify(publishResult.content)}`);
    const media = await get("/__session/media", { sessionId, id: reference[1]! });
    assertEquals(media.headers.get("content-type"), "image/png");
    assertEquals(
      new Uint8Array(await media.arrayBuffer()),
      Uint8Array.fromBase64(SCRIPTED_PNG_BASE64),
    );

    // No explicit Stop: completion releases RAM, and the next turn restores SQLite files.
    await json("/__session/submit", {
      sessionId,
      prompt: "Check idle sandbox",
      requestId: "check-idle-sandbox",
    });
    const resumed = await waitForConversation(
      sessionId,
      (current) =>
        current.some((message) =>
          message.role === "assistant" && JSON.stringify(message).includes("Idle sandbox checked.")
        ),
      60_000,
    );
    const restored = JSON.stringify(resumed.findLast((message) => message.role === "toolResult"));
    assertStringIncludes(restored, "e2e\\nreleased");
    assert(!restored.includes("still-live"), restored);
    assertEquals(
      (await (await get("/__session/view", { sessionId })).json()).environmentState,
      "running",
    );

    // Stop and start again; without a project no skills catalog is ever loaded.
    assertEquals(
      (await json("/__session/control", { sessionId, action: "stop" })).state,
      "stopped",
    );
    assertEquals(
      (await json("/__session/control", { sessionId, action: "start" })).state,
      "running",
    );
    await json("/__session/submit", {
      sessionId,
      prompt: "Which skills do you have?",
      requestId: "skills-after-restart",
    });
    const answered = await waitForConversation(
      sessionId,
      (current) =>
        current.some((message) =>
          message.role === "assistant" && JSON.stringify(message).includes("Skills: ")
        ),
      60_000,
    );
    const skills = JSON.stringify(answered.findLast((message) => message.role === "assistant"));
    assert(!skills.includes("e2e-skill"), `the catalog changed after checkout: ${skills}`);

    const view = await (await get("/__session/view", { sessionId })).json();
    assertEquals(view.environmentState, "running");
    assertEquals(view.projectId, undefined);
    // The Sandbox receives no credentials, so provisioning, Stop, and start never read them.
    assertEquals(await credentialReads(), readsBefore);
    // No project means no clone and no project hooks, so nothing can fail.
    assertEquals(view.issues, []);
  },
});

Deno.test({
  name: "idle sandboxes reload beyond loader capacity while original WorkerStubs stay reachable",
  ignore: gatewayUrl === undefined,
  async fn() {
    assertEquals(await json("/__sandbox-reload-probe", {}, 5 * 60_000), {
      cycles: 260,
      retained: 260,
    });
  },
});
