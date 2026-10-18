import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@jsr/std__assert";
import {
  createModels,
  type Message,
  type Models,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ok, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { EnvironmentProviders } from "@openorb/environments";
import { SessionId } from "@openorb/protocol/runner-api";
import type { SessionPeer } from "../app/cells/session/api.ts";
import { Session } from "../app/cells/session/session.ts";
import { startSession } from "../app/cells/session/start.ts";
import { readTranscript } from "../app/cells/session/threads/reader.ts";
import { childBranchName, ThreadHost } from "../app/cells/session/threads/host.ts";
import { migrateDurableObjectDatabase } from "../app/cells/migrations.ts";
import { sessionMigrations } from "../app/cells/session/migrations.ts";
import type { SessionRecord } from "../app/cells/session/record.ts";
import type { SessionView } from "../app/cells/session/view.ts";
import type { Env } from "../app/env.ts";
import { projectConversation } from "../app/actions/sessions/public/session-transcript-state.ts";
import { createWorkspace, MemoryStorage } from "./workspace/storage.ts";

// ADR 0010: Sessions reach each other only through their own access records. These Sessions run
// in-process against a real Workspace catalog, with a scripted model that calls whatever tool a
// prompt names on a line of the form `Call <tool> <JSON arguments>`.

const READER = "You answer a question about another OpenOrb thread";

function text(message: Message | undefined): string {
  if (message === undefined || message.role === "system") return "";
  // Pi permits user content as either a string or content blocks.
  // oxlint-disable-next-line openorb/no-runtime-typeof
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function respond(context: TranscriptContext) {
  const last = context.messages.at(-1);
  if (JSON.stringify(context.messages[0]).includes(READER)) {
    // The reader proves what it was shown: the markers in its transcript.
    const shown = context.messages.map(text).join("\n");
    return fauxAssistantMessage(`Reader saw ${[...new Set(shown.match(/MARKER-\w+/g))].join(",")}`);
  }
  if (last?.role === "toolResult") {
    return fauxAssistantMessage(
      `${last.toolName} ${last.isError ? "failed" : "returned"}: ${text(last)}`,
    );
  }
  const call = /^Call (\w+) (.+)$/m.exec(text(last));
  if (call !== null) {
    return fauxAssistantMessage(fauxToolCall(call[1]!, JSON.parse(call[2]!)), {
      stopReason: "toolUse",
    });
  }
  return fauxAssistantMessage(`Answered: ${text(last)}`);
}

function scriptedModels(): Models {
  const faux = fauxProvider({ models: [{ id: "demo" }], tokensPerSecond: 1_000_000 });
  faux.setResponses(Array.from({ length: 64 }, () => respond));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

const guest: Partial<ExecutionEnv> = {
  id: "fake",
  cwd: "/workspace",
  createDir: () => Promise.resolve(ok(undefined)),
};
const providers: EnvironmentProviders = {
  fake: {
    capabilities: { credentials: "none", git: false },
    guestPrompt: [],
    open: (host) => ({
      // SAFETY: Sessions without a project only create /workspace in their guest.
      env: guest as ExecutionEnv,
      create: () => Promise.resolve(),
      control: (action) => {
        const state = action === "stop" ? "stopped" : "running";
        host.report({ state, reachable: true });
        return Promise.resolve({ state, forced: false });
      },
      delete: () => Promise.resolve(),
      release: () => {},
    }),
  },
};

/** Sessions of one Workspace that address each other by ID, as Durable Objects do. */
async function cluster() {
  const { workspace, workspaceId } = await createWorkspace();
  const pending = new Set<Promise<unknown>>();
  const sessions = new Map<string, Session>();
  // SAFETY: these Sessions use the Workspace catalog and no credentials, media, or bindings.
  // oxlint-disable-next-line openorb/no-chained-type-assertions
  const env = { WORKSPACE: { getByName: () => workspace }, MEDIA: {} } as unknown as Env;
  const session = (id: string): Session => {
    let existing = sessions.get(id);
    if (existing === undefined) {
      existing = new ClusterSession(
        {
          storage: Object.assign(new MemoryStorage(), { deleteAll: () => Promise.resolve() }),
          // SAFETY: the fake environment uses no facets.
          facets: {} as DurableObjectFacets,
          blockConcurrencyWhile: (callback) => callback(),
          acceptWebSocket: () => {},
          getWebSockets: () => [],
          waitUntil: (promise) => {
            pending.add(promise);
            void promise.finally(() => pending.delete(promise));
          },
        },
        env,
      );
      sessions.set(id, existing);
    }
    return existing;
  };
  class ClusterSession extends Session {
    protected override agentModels(): Models {
      return scriptedModels();
    }
    protected override environmentProviders(): EnvironmentProviders {
      return providers;
    }
    protected override sessionPeer(sessionId: string): SessionPeer {
      return peer(sessionId);
    }
  }
  /** A Session as another reaches it over native RPC, where every method is asynchronous. */
  const peer = (id: string): SessionPeer => {
    const target = session(id);
    return {
      create: (input) => target.create(input),
      view: () => Promise.resolve(target.view()),
      threadStatus: (input) => target.threadStatus(input),
      threadTranscript: (input) => target.threadTranscript(input),
      receiveThreadMessage: (input) => target.receiveThreadMessage(input),
    };
  };
  const drain = async () => {
    while (pending.size !== 0) await Promise.all(pending);
  };
  return {
    workspace,
    workspaceId,
    session,
    peer,
    drain,
    /** A top-level Session the user starts from the browser, through the browser's start path. */
    async start(initialPrompt: string) {
      const id = crypto.randomUUID();
      const [, error] = await startSession(workspace, peer(id), {
        workspaceId,
        sessionId: id,
        createdAt: new Date().toISOString(),
        placement: { provider: "fake" },
        orbSize: "tiny",
        model: "faux/demo",
        thinkingLevel: "off",
        initialPrompt,
        origin: { kind: "user" },
      });
      if (error !== undefined) throw error;
      await drain();
      return id;
    },
    /** The user's follow-up prompt, then everything it set off. */
    async prompt(id: string, prompt: string) {
      await session(id).submit({
        prompt,
        requestId: crypto.randomUUID(),
        origin: { kind: "user" },
      });
      await drain();
    },
    /** The Child Session a parent's create_thread call reported. */
    async childOf(parent: string, index = 0) {
      const ids = [
        ...(await this.transcript(parent)).matchAll(/Created child thread ([0-9a-f-]{36})/g),
      ].map((match) => match[1]!);
      const id = [...new Set(ids)][index];
      assert(id, "the parent created no such child");
      return id;
    },
    /** Messages from other threads, as the browser's transcript shows them. */
    async threadMessages(id: string) {
      const response = await session(id).fetch(new Request("https://openorb.test/events"));
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (!buffer.includes("\n\n")) {
        const { value, done } = await reader.read();
        assert(!done, "the event stream ended before its snapshot");
        buffer += value;
      }
      await reader.cancel();
      const data = buffer.split("\n").find((line) => line.startsWith("data: "))!;
      const event = JSON.parse(data.slice("data: ".length));
      assertEquals(event.type, "conversation.snapshot");
      return projectConversation(event.view, "off").entries.filter(
        (entry) => "role" in entry && entry.role === "thread",
      );
    },
    /** The full transcript, as read_thread's reader is given it. */
    transcript: (id: string) => session(id).threadTranscript({ workspaceId, scope: "full" }),
  };
}

const call = (tool: string, input: Record<string, string>) =>
  `Call ${tool} ${JSON.stringify(input)}`;
/** How a tool's thrown error appears in the transcript. */
const failure = (tool: string, message: string) =>
  `[${tool} failed]\n<harness>\n[error] ${message}`;

test("a parent creates a Child Session, messages it, and reads it; the child cannot nest", async () => {
  const sessions = await cluster();
  const parent = await sessions.start(call("create_thread", { prompt: "MARKER-delegated" }));
  let transcript = await sessions.transcript(parent);
  const childId = /Created child thread ([0-9a-f-]{36})/.exec(transcript)?.[1];
  assert(childId, transcript);
  const entry = await sessions.workspace.getSessionCatalogEntry(sessions.workspaceId, childId);
  assertEquals(entry?.parentSessionId, parent);
  // The sidebar names the child by what the parent asked, not by the label its model reads.
  assertEquals(entry?.initialPromptPreview, "MARKER-delegated");
  const child = await sessions.transcript(childId);
  assertStringIncludes(child, `Message from parent thread ${parent}:`);
  assertStringIncludes(child, "Answered: Message from parent");
  const parentTitle = (await sessions.session(parent).view())!.initialPromptPreview;
  assertEquals(
    (await sessions.threadMessages(childId)).map(({ relation, sessionId, title, text }) => ({
      relation,
      sessionId,
      title,
      text,
    })),
    [{ relation: "parent", sessionId: parent, title: parentTitle, text: "MARKER-delegated" }],
  );

  // The child replies to its real parent, which admits the message as a prompt.
  await sessions.prompt(
    childId,
    call("send_thread_message", { thread: parent, message: "MARKER-reply" }),
  );
  transcript = await sessions.transcript(parent);
  assertStringIncludes(transcript, `Message from child thread ${childId}:\n\nMARKER-reply`);
  assertEquals(
    (await sessions.threadMessages(parent)).map(({ relation, sessionId, title, text }) => ({
      relation,
      sessionId,
      title,
      text,
    })),
    [{ relation: "child", sessionId: childId, title: "MARKER-delegated", text: "MARKER-reply" }],
  );

  // The parent reads its child through the reader model, which sees the child's whole history.
  await sessions.prompt(
    parent,
    call("read_thread", { thread: childId, question: "What was delegated?" }),
  );
  assertStringIncludes(
    await sessions.transcript(parent),
    "read_thread returned: Reader saw MARKER-delegated,MARKER-reply",
  );
  await sessions.prompt(parent, call("get_thread_status", { thread: childId }));
  assertStringIncludes(await sessions.transcript(parent), '"relation": "child"');

  // Depth 1: the child has no create_thread tool, and the Workspace refuses a grandchild anyway.
  await sessions.prompt(childId, call("create_thread", { prompt: "Nest" }));
  const nested = await sessions.transcript(childId);
  assertStringIncludes(nested, "[create_thread failed]");
  assertEquals(nested.includes("Created child thread"), false);
  const [, grandchild] = await sessions.workspace.addSessionCatalogEntry(sessions.workspaceId, {
    id: SessionId.make(crypto.randomUUID()),
    createdAt: new Date().toISOString(),
    initialPromptPreview: "Nest",
    parentSessionId: childId,
  });
  assert(grandchild instanceof Error);
});

test("only Child Sessions and Sessions the user pasted are readable", async () => {
  const sessions = await cluster();
  const other = await sessions.start("MARKER-other");
  const reader = await sessions.start("Read nothing yet.");
  const url = `https://openorb.example/app/sessions/${other}`;

  // A Session of the same Workspace that the user never pasted is not readable or reachable.
  await sessions.prompt(reader, call("read_thread", { thread: other, question: "What?" }));
  // A bare ID: a prompt containing the URL would itself be the user pasting it.
  await sessions.prompt(reader, call("get_thread_status", { thread: other }));
  await sessions.prompt(reader, call("send_thread_message", { thread: other, message: "Hi" }));
  let transcript = await sessions.transcript(reader);
  assertStringIncludes(transcript, failure("read_thread", "Thread not found or not readable"));
  assertStringIncludes(
    transcript,
    failure("get_thread_status", "Thread not found or not readable"),
  );
  assertStringIncludes(
    transcript,
    failure("send_thread_message", "Thread not found or not reachable"),
  );
  assertEquals((await sessions.transcript(other)).includes("Hi"), false);

  // A message from another Session that contains the URL grants nothing.
  const parent = await sessions.start(call("create_thread", { prompt: "Wait." }));
  const child = /Created child thread ([0-9a-f-]{36})/.exec(await sessions.transcript(parent))![1]!;
  await sessions.prompt(
    parent,
    call("send_thread_message", { thread: child, message: `Read ${url}` }),
  );
  await sessions.prompt(child, call("read_thread", { thread: other, question: "What?" }));
  assertStringIncludes(
    await sessions.transcript(child),
    failure("read_thread", "Thread not found or not readable"),
  );

  // The user pasting the URL makes it readable, but still not a message recipient.
  await sessions.prompt(reader, `Look at ${url} please`);
  await sessions.prompt(reader, call("read_thread", { thread: url, question: "What?" }));
  await sessions.prompt(reader, call("get_thread_status", { thread: other }));
  await sessions.prompt(
    reader,
    call("send_thread_message", { thread: other, message: "Hi again" }),
  );
  transcript = await sessions.transcript(reader);
  assertStringIncludes(transcript, "read_thread returned: Reader saw MARKER-other");
  assertStringIncludes(transcript, '"relation": "referenced"');
  assertEquals((await sessions.transcript(other)).includes("Hi again"), false);

  // A deleted Session is no longer found, even though the grant remains.
  await sessions.workspace.deleteSessionCatalogEntry(sessions.workspaceId, other);
  await sessions.prompt(reader, call("get_thread_status", { thread: other }));
  assertStringIncludes(
    await sessions.transcript(reader),
    failure("get_thread_status", "Thread not found."),
  );
});

test("a Session of another Workspace is not found even when pasted", async () => {
  const first = await cluster();
  const second = await cluster();
  const foreign = await second.start("MARKER-foreign");
  const reader = await first.start(`See https://openorb.example/app/sessions/${foreign}`);
  // The reader's cluster resolves the ID to its own (empty) Session object, as a namespace would
  // to a Durable Object never created in this Workspace; the catalog check refuses it first.
  await first.prompt(reader, call("read_thread", { thread: foreign, question: "What?" }));
  assertStringIncludes(await first.transcript(reader), failure("read_thread", "Thread not found."));
  // And a target refuses a caller that names another Workspace.
  let refused = false;
  await second
    .session(foreign)
    .threadTranscript({ workspaceId: first.workspaceId, scope: "full" })
    .catch(() => (refused = true));
  assert(refused);
});

test("a Child Session's grants come only from its user, and it reaches only its parent", async () => {
  const sessions = await cluster();
  const other = await sessions.start("MARKER-other");
  const url = `https://openorb.example/app/sessions/${other}`;
  // The parent's create_thread prompt pastes a URL: the child's initial prompt grants nothing.
  const parent = await sessions.start(
    `${call("create_thread", { prompt: `Read ${url}` })}\n${call("create_thread", { prompt: "Sibling" })}`,
  );
  const child = await sessions.childOf(parent);
  await sessions.prompt(parent, call("create_thread", { prompt: "Sibling" }));
  const sibling = await sessions.childOf(parent, 1);
  await sessions.prompt(child, call("read_thread", { thread: other, question: "What?" }));
  assertStringIncludes(
    await sessions.transcript(child),
    failure("read_thread", "Thread not found or not readable"),
  );
  // Siblings, and the parent's own transcript, are out of the child's reach.
  await sessions.prompt(child, call("send_thread_message", { thread: sibling, message: "Hi" }));
  await sessions.prompt(child, call("read_thread", { thread: parent, question: "What?" }));
  let transcript = await sessions.transcript(child);
  assertStringIncludes(
    transcript,
    failure("send_thread_message", "Thread not found or not reachable"),
  );
  assertEquals((await sessions.transcript(sibling)).includes("Hi"), false);
  assertStringIncludes(transcript, failure("read_thread", "Thread not found or not readable"));
  // The user pasting the URL into the child does grant it.
  await sessions.prompt(child, `See ${url}.`);
  await sessions.prompt(child, call("read_thread", { thread: other, question: "What?" }));
  transcript = await sessions.transcript(child);
  assertStringIncludes(transcript, "read_thread returned: Reader saw MARKER-other");
  // So does pasting the parent's URL, and the parent stays a message recipient.
  await sessions.prompt(parent, "MARKER-parent");
  await sessions.prompt(child, `Also https://openorb.example/app/sessions/${parent}`);
  await sessions.prompt(child, call("read_thread", { thread: parent, question: "What?" }));
  await sessions.prompt(child, call("send_thread_message", { thread: parent, message: "Done" }));
  transcript = await sessions.transcript(child);
  assertStringIncludes(transcript, "read_thread returned: Reader saw MARKER-parent");
  assertStringIncludes(
    transcript,
    `send_thread_message returned: Sent to parent thread ${parent}.`,
  );
});

test("a repeated create_thread call starts its child once", async () => {
  const sessions = await cluster();
  const parent = await sessions.start("Parent");
  const storage = new MemoryStorage();
  await migrateDurableObjectDatabase(storage, sessionMigrations);
  const host = new ThreadHost({
    storage,
    workspace: sessions.workspace,
    // SAFETY: the host reads only these fields of a top-level Session's record.
    record: () =>
      ({
        workspaceId: sessions.workspaceId,
        sessionId: parent,
        placement: { provider: "fake" },
        guestCredentialOptIn: false,
        orbSize: "tiny",
        model: "faux/demo",
        initialThinkingLevel: "off",
      }) as SessionRecord,
    peer: sessions.peer,
  });
  const first = await host.create("MARKER-once", { callId: "call-1", thinkingLevel: "off" });
  const again = await host.create("MARKER-once", { callId: "call-1", thinkingLevel: "off" });
  const other = await host.create("MARKER-twice", { callId: "call-2", thinkingLevel: "off" });
  await sessions.drain();
  assertEquals(first, again);
  assert(first !== other);
  const children = (await sessions.workspace.listSessionNavigationEntries(sessions.workspaceId))
    .map((entry) => entry.id)
    .filter((id) => id === first || id === other);
  assertEquals(children.length, 2);
  assertEquals((await sessions.transcript(first)).split("MARKER-once").length - 1, 2);
});

test("a failed start keeps the catalog entry unless the Session recorded nothing", async () => {
  const { workspace, workspaceId } = await createWorkspace();
  const start = async (view: SessionView | null) => {
    const sessionId = crypto.randomUUID();
    const [, error] = await startSession(
      workspace,
      {
        create: () => Promise.reject(new Error("The runner went away.")),
        view: () => Promise.resolve(view),
      },
      {
        workspaceId,
        sessionId,
        createdAt: new Date().toISOString(),
        placement: { provider: "fake" },
        orbSize: "tiny",
        model: "faux/demo",
        thinkingLevel: "off",
        initialPrompt: "Start",
        origin: { kind: "user" },
      },
    );
    return { error, entry: await workspace.getSessionCatalogEntry(workspaceId, sessionId) };
  };
  const nothing = await start(null);
  assertEquals(nothing.error?.kept, false);
  assertEquals(nothing.entry, null);
  // The Session exists after all, perhaps running: it must stay visible and deletable.
  // SAFETY: startSession only distinguishes a view from null.
  const started = await start({} as SessionView);
  assertEquals(started.error?.kept, true);
  assertEquals(started.error?.message, "The runner went away.");
  assert(started.entry !== null);
});

test("a Child Session's branch extends its parent's within Git's limits", () => {
  const child = "0123abcd-0000-5000-8000-000000000000";
  assertEquals(childBranchName("openorb/fix", child), "openorb/fix-child-0123abcd");
  const long = childBranchName(`openorb/${"x".repeat(300)}`, child);
  assertEquals(long.length, 255);
  assert(long.endsWith("-child-0123abcd"));
});

test("a transcript too long for one request is searched and read in pages", async () => {
  const lines = Array.from({ length: 4_000 }, (_, index) => `line ${index} filler text`);
  lines[3_210] = "the decision MARKER-deep was made here";
  const transcript = lines.join("\n");
  const faux = fauxProvider({
    models: [{ id: "small", contextWindow: 10_000 }],
    tokensPerSecond: 1_000_000,
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_transcript", { query: "decision" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      const found = /Page (\d+):/.exec(text(context.messages.at(-1)))?.[1];
      assert(Number(found) > 1, "the marker is not on the first page");
      return fauxAssistantMessage(fauxToolCall("read_transcript_page", { page: Number(found) }), {
        stopReason: "toolUse",
      });
    },
    (context) =>
      fauxAssistantMessage(
        text(context.messages.at(-1)).includes("MARKER-deep") ? "Found it." : "Missed it.",
      ),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const answer = await readTranscript(transcript, "What was decided?", {
    models,
    model: models.getModel("faux", "small")!,
  });
  assertEquals(answer, "Found it.");
});

test("a reader that keeps reading runs out of budget and must answer with its tools declared", async () => {
  const transcript = Array.from({ length: 4_000 }, (_, index) => `line ${index} filler`).join("\n");
  const faux = fauxProvider({
    models: [{ id: "small", contextWindow: 10_000 }],
    tokensPerSecond: 1_000_000,
  });
  const results: string[] = [];
  const keepReading = (context: TranscriptContext) => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") results.push(text(last));
    return fauxAssistantMessage(
      fauxToolCall("read_transcript_page", { page: results.length + 1 }),
      {
        stopReason: "toolUse",
      },
    );
  };
  let final: { tools: number; toolChoice: unknown } | undefined;
  faux.setResponses([
    ...Array.from({ length: 7 }, () => keepReading),
    (context, options) => {
      final = {
        tools: context.messages
          .filter((message) => message.role === "system")
          .flatMap((message) => message.toolsAdded ?? []).length,
        toolChoice: options?.toolChoice,
      };
      return fauxAssistantMessage("Answered from what I read.");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const answer = await readTranscript(transcript, "Everything?", {
    models,
    model: models.getModel("faux", "small")!,
  });
  assertEquals(answer, "Answered from what I read.");
  // A budget of 20,000 characters reads four 5,000-character pages, then refuses.
  assertEquals(results.filter((result) => result.startsWith("Page ")).length, 4);
  assertStringIncludes(results.at(-1)!, "The reading budget is used up");
  assertEquals(final, { tools: 2, toolChoice: "none" });
});
