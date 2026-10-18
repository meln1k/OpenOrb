import { test } from "vite-plus/test";
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@jsr/std__assert";
import { Buffer } from "node:buffer";

import type { WorkspaceId } from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import {
  initialPromptPreview,
  type SessionCatalogEntry,
  type UserId,
} from "../app/cells/workspace/api.ts";
import { SessionGitSnapshot } from "../app/cells/session/git-snapshot-schema.ts";
import { SessionArtifactId } from "../app/cells/session/media.ts";
import type { SessionView } from "../app/cells/session/view.ts";
import type {
  CreateSessionInput,
  MediaReader,
  SessionApi,
  SessionDirectory,
  SessionMedia,
} from "../app/cells/session/api.ts";
import {
  createAppServices,
  disconnectedRunnerRegistry,
  type TestRunnerConnections,
} from "./workspace-test.ts";
import { createAppRouter } from "./workspace-test.ts";
import { routes } from "../app/routes.ts";
import { createTestServer } from "./http-test-server.ts";
import { activate, createWorkspace } from "./workspace-test.ts";

const PASSWORD = "[REDACTED:password] horse battery staple";
const GITHUB_TOKEN = "browser-provisioning-github-token";
const MODEL_PROVIDER_KEY = "browser-provisioning-model-key";
const ENVIRONMENT_SECRET_VALUE = "browser-provisioning-environment-secret";
const ENVIRONMENT_SECRET_HOSTS = ["api.example.com", "*.service.example"] as const;
const PROVIDER_ID = "opencode-go";
const MODEL = `${PROVIDER_ID}/deepseek-v4-flash`;
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_MODEL = `${OPENAI_PROVIDER_ID}/gpt-4.1`;
const OPENAI_PROVIDER_KEY = "browser-provisioning-openai-key";
const GIT_AUTHOR = {
  authorName: "Browser Provisioning User",
  authorEmail: "browser-provisioning@example.com",
};
const INITIAL_PROMPT = "  Inspect\nthis repository and explain the architecture.  ";
const ARTIFACT_ID = Schema.decodeUnknownSync(SessionArtifactId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c20",
);
const INLINE_IMAGE_ID = Schema.decodeUnknownSync(SessionArtifactId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c21",
);
const ARTIFACT_BYTES = new TextEncoder().encode("0123456789");
const INLINE_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIT_SNAPSHOT_ID = "a".repeat(64);
const GIT_PATCH_BYTES = new TextEncoder().encode("diff --git a/README.md b/README.md\n");
const SESSION_UNREACHABLE = "The Session Durable Object is unreachable.";
const CONVERSATION_SNAPSHOT_EVENT = `event: session\ndata: ${JSON.stringify({
  type: "conversation.snapshot",
  view: {
    conversation: { id: 0 },
    entries: [
      {
        id: 1,
        conversationId: 0,
        kind: "pi.user",
        model: [{ role: "user", content: INITIAL_PROMPT }],
      },
    ],
    docs: {},
  },
})}\n\n`;

type SessionMethod = keyof SessionApi;

interface SessionCall {
  readonly sessionId: string;
  readonly method: SessionMethod;
  readonly input: unknown;
}

/**
 * Stands in for the per-Session Durable Objects, the published media bucket, and the one runner
 * capability browser routes still need from the Runners cell: live state for runner selection.
 */
class BrowserTestSessions {
  workspaceId: WorkspaceId | null = null;
  runnerId = "";
  /** Every Session addressed through the directory, whether or not a method followed. */
  readonly addressed: string[] = [];
  /** Every SessionApi invocation, including those rejected while unreachable. */
  readonly calls: SessionCall[] = [];
  readonly views = new Map<string, SessionView>();
  readonly mediaItems = new Map<string, SessionMedia>();
  readonly objects = new Map<string, Uint8Array>();
  readonly mediaReads: { key: string; range: { offset: number; length: number } }[] = [];
  /** Simulates a Session Durable Object whose RPC calls fail. */
  unreachable = false;
  createError: string | undefined = undefined;
  beforeCreate: ((input: CreateSessionInput) => Promise<void>) | undefined = undefined;
  beforeDelete: ((sessionId: string) => Promise<void>) | undefined = undefined;

  readonly runnerConnections: TestRunnerConnections = {
    ...disconnectedRunnerRegistry,
    getRunnerLiveState: (workspaceId, runnerId) => {
      if (workspaceId !== this.workspaceId || runnerId !== this.runnerId) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        lastObservedAt: Date.now(),
        capacity: {
          activeSessions: 0,
          vmCpuCount: 4,
          vmMemoryMiB: 8192,
          diskFreeMiB: 20_480,
        },
      });
    },
  };

  readonly directory: SessionDirectory = (sessionId) => {
    this.addressed.push(sessionId);
    return this.#api(sessionId);
  };

  readonly media: MediaReader = {
    get: (key, options) => {
      this.mediaReads.push({ key, range: { ...options.range } });
      const bytes = this.objects.get(key);
      if (bytes === undefined) return Promise.resolve(null);
      const slice = bytes.slice(options.range.offset, options.range.offset + options.range.length);
      return Promise.resolve({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        }),
      });
    },
  };

  inputsOf(method: SessionMethod, sessionId?: string): unknown[] {
    return this.calls
      .filter(
        (call) =>
          call.method === method && (sessionId === undefined || call.sessionId === sessionId),
      )
      .map((call) => call.input);
  }

  methodsSince(mark: number): SessionMethod[] {
    return this.calls.slice(mark).map((call) => call.method);
  }

  snapshot(sessionId: string): SessionView {
    const view = this.views.get(sessionId);
    assert(view, `expected a Session view for ${sessionId}`);
    return view;
  }

  update(
    sessionId: string,
    patch: Partial<
      Pick<
        SessionView,
        "state" | "agentState" | "environmentState" | "environmentReachable" | "issues"
      >
    >,
  ): void {
    const view = this.views.get(sessionId);
    assert(view, `expected a Session view for ${sessionId}`);
    this.views.set(sessionId, { ...view, ...patch });
  }

  publish(sessionId: string, artifactId: string, bytes: Uint8Array): void {
    const key = `media/${this.workspaceId}/${sessionId}/${artifactId}`;
    this.objects.set(key, bytes);
    this.mediaItems.set(`${sessionId}/${artifactId}`, {
      kind: "published",
      key,
      mediaType: "video/mp4",
      byteLength: bytes.byteLength,
      fileName: "preview.mp4",
    });
  }

  #invoke<T>(
    sessionId: string,
    method: SessionMethod,
    input: unknown,
    run: () => T | Promise<T>,
  ): Promise<T> {
    this.calls.push({ sessionId, method, input });
    if (this.unreachable) return Promise.reject(new Error(SESSION_UNREACHABLE));
    return Promise.resolve().then(run);
  }

  #existing(sessionId: string): SessionView {
    const view = this.views.get(sessionId);
    if (view === undefined) throw new Error("Session not found.");
    return view;
  }

  #api(sessionId: string): SessionApi {
    return {
      create: (input) =>
        this.#invoke(sessionId, "create", input, async () => {
          await this.beforeCreate?.(input);
          if (this.createError !== undefined) throw new Error(this.createError);
          this.views.set(sessionId, {
            id: input.sessionId,
            ...(input.project === undefined ? {} : { projectId: input.project.id }),
            createdAt: input.createdAt,
            initialPromptPreview: initialPromptPreview(input.initialPrompt),
            model: input.model,
            initialThinkingLevel: input.thinkingLevel,
            orbSize: input.orbSize,
            state: "created",
            agentState: "idle",
            environmentState: "starting",
            environmentReachable: true,
            issues: [],
          });
          return { created: true };
        }),
      view: () =>
        this.#invoke(sessionId, "view", undefined, () => this.views.get(sessionId) ?? null),
      submit: (input) =>
        this.#invoke(sessionId, "submit", input, () => {
          this.#existing(sessionId);
        }),
      setThinkingLevel: (level) =>
        this.#invoke(sessionId, "setThinkingLevel", level, () => {
          this.#existing(sessionId);
          return level;
        }),
      abort: () =>
        this.#invoke(sessionId, "abort", undefined, () => {
          this.#existing(sessionId);
        }),
      stop: () =>
        this.#invoke(sessionId, "stop", undefined, () => {
          this.#existing(sessionId);
          return { state: "stopping" as const, forced: false };
        }),
      wake: () =>
        this.#invoke(sessionId, "wake", undefined, () => {
          this.#existing(sessionId);
        }),
      retry: (recovery) =>
        this.#invoke(sessionId, "retry", recovery, () => {
          this.#existing(sessionId);
          this.update(sessionId, { state: "created", issues: [] });
        }),
      delete: () =>
        this.#invoke(sessionId, "delete", undefined, async () => {
          await this.beforeDelete?.(sessionId);
          this.views.delete(sessionId);
        }),
      media: (id) =>
        this.#invoke(
          sessionId,
          "media",
          id,
          () => this.mediaItems.get(`${sessionId}/${id}`) ?? null,
        ),
      gitSnapshot: () =>
        this.#invoke(sessionId, "gitSnapshot", undefined, () => {
          this.#existing(sessionId);
          return SessionGitSnapshot.make({
            generatedAt: "2026-08-23T12:00:00Z",
            branch: "openorb/browser-test",
            head: "0123456789abcdef0123456789abcdef01234567",
            completeness: "complete",
            stale: false,
            truncated: false,
            sections: {
              staged: { files: [], patch: "", truncated: false },
              unstaged: { files: [], patch: "", truncated: false },
            },
          });
        }),
      gitPatchChunk: (input) =>
        this.#invoke(sessionId, "gitPatchChunk", input, () => {
          this.#existing(sessionId);
          const bytes = GIT_PATCH_BYTES.subarray(input.offset, input.offset + 16);
          const nextOffset = input.offset + bytes.byteLength;
          return { bytes, nextOffset, done: nextOffset >= GIT_PATCH_BYTES.byteLength };
        }),
      updateGitFile: (input) =>
        this.#invoke(sessionId, "updateGitFile", input, () => {
          this.#existing(sessionId);
          return { mutationRevision: this.inputsOf("updateGitFile", sessionId).length };
        }),
      events: (request) =>
        this.#invoke(
          sessionId,
          "events",
          { lastEventId: request.headers.get("Last-Event-ID") },
          () => {
            this.#existing(sessionId);
            return new Response(CONVERSATION_SNAPSHOT_EVENT, {
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
            });
          },
        ),
    };
  }
}

function createSessionServer(store: ReturnType<typeof activate>["workspace"]) {
  const sessions = new BrowserTestSessions();
  const router = createAppRouter(
    createAppServices(
      store,
      sessions.runnerConnections,
      undefined,
      sessions.directory,
      sessions.media,
    ),
  );
  return { sessions, router };
}

test("session composer creates a new server-assigned session on each submission without client initialization", async () => {
  const { workspace: store } = activate();
  const { sessions, router } = createSessionServer(store);
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    sessions.workspaceId = client.workspaceId;
    const project = await store.saveProject(client.workspaceId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    });
    assert(project.status === "saved");
    await store.saveGitHubCredential(client.workspaceId, GITHUB_TOKEN);
    await store.saveGitAuthorConfiguration(client.userId, GIT_AUTHOR);
    await store.saveModelProviderCredential(client.workspaceId, PROVIDER_ID, MODEL_PROVIDER_KEY);
    sessions.runnerId = (await enrollRunner(store, client.workspaceId)).runnerId;

    const page = await fetch(new URL(routes.app.index.href(), server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    assertEquals(page.status, 200);
    const html = await page.text();
    const composer = html.match(/<dialog[^>]*id="openorb-new-session"[^>]*>([\s\S]*?)<\/dialog>/);
    assert(composer, "expected the session creation modal");
    const form = composer[1]!.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
    assert(form, "expected the session creation form");
    assertEquals(form[1], routes.app.sessions.create.href());
    assertStringIncludes(composer[1]!, "data-rmx-document");

    // Preserve SSR hidden fields, as a submission without SessionComposerBehavior would.
    const body = new URLSearchParams();
    for (const field of form[2]!.matchAll(
      /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g,
    )) {
      body.set(field[1]!, field[2]!);
    }
    assertNotMatch(form[2]!, /name="sessionId"/);
    assertEquals(body.has("sessionId"), false);
    assert(body.get("_csrf"), "expected the rendered CSRF token");
    body.set("projectId", project.project.id);
    body.set("model", MODEL);
    body.set("environment", "runner");
    body.set("orbSize", "medium");
    body.set("initialPrompt", INITIAL_PROMPT);

    const response = await fetch(new URL(form[1]!, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body,
    });
    await response.text();
    assertEquals(response.status, 303);
    const [firstCreate] = createInputs(sessions);
    assert(firstCreate);
    const firstSessionId = firstCreate.sessionId;
    assertEquals(sessions.addressed, [firstSessionId]);
    assertEquals(
      response.headers.get("location"),
      routes.app.sessions.detail.href({ sessionId: firstSessionId }),
    );

    // A stale client-supplied ID cannot select or reuse an existing session.
    body.set("sessionId", firstSessionId);
    const secondResponse = await fetch(new URL(form[1]!, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body,
    });
    await secondResponse.text();
    assertEquals(secondResponse.status, 303);
    const creates = createInputs(sessions);
    assertEquals(creates.length, 2);
    const sessionId = creates[1]!.sessionId;
    assert(sessionId !== firstSessionId);
    assertEquals(sessions.addressed, [firstSessionId, sessionId]);
    assertEquals(sessions.inputsOf("create", firstSessionId).length, 1);
    assertEquals(
      secondResponse.headers.get("location"),
      routes.app.sessions.detail.href({ sessionId }),
    );
    assert(await store.getSessionCatalogEntry(client.workspaceId, firstSessionId));
    assert(await store.getSessionCatalogEntry(client.workspaceId, sessionId));
  } finally {
    await server.close();
  }
});

test("sessions start in the built-in sandbox without a runner, and by choice with one", async () => {
  const { workspace: store } = activate();
  const { sessions, router } = createSessionServer(store);
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    sessions.workspaceId = client.workspaceId;
    // Only a model provider: no project, no Git author, and no runner are needed to try OpenOrb.
    await store.saveModelProviderCredential(client.workspaceId, PROVIDER_ID, MODEL_PROVIDER_KEY);

    const composerFields = async () => {
      const page = await fetch(new URL(routes.app.index.href(), server.baseUrl), {
        headers: { Cookie: client.cookie },
      });
      const html = await page.text();
      const composer = html.match(/<dialog[^>]*id="openorb-new-session"[^>]*>([\s\S]*?)<\/dialog>/);
      assert(composer, "expected the session creation modal");
      const form = composer[1]!.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
      assert(form, "expected the session creation form");
      const body = new URLSearchParams();
      for (const field of form[2]!.matchAll(
        /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g,
      )) {
        body.set(field[1]!, field[2]!);
      }
      body.set("model", MODEL);
      body.set("initialPrompt", INITIAL_PROMPT);
      return { html: form[2]!, body };
    };
    const submit = async (body: URLSearchParams) => {
      const response = await fetch(new URL(routes.app.sessions.create.href(), server.baseUrl), {
        method: "POST",
        redirect: "manual",
        headers: { Cookie: client.cookie },
        body,
      });
      await response.text();
      assertEquals(response.status, 303);
      return createInputs(sessions).at(-1);
    };

    // Without a runner the environment selector offers only the Sandbox.
    const withoutRunner = await composerFields();
    assertMatch(withoutRunner.html, /aria-label="Environment"/);
    assertMatch(
      withoutRunner.html,
      /<input[^>]*name="environment"[^>]*type="hidden"[^>]*value="sandbox"/,
    );
    assertStringIncludes(withoutRunner.html, "Sandbox · built-in just-bash");
    assertNotMatch(withoutRunner.html, /Runner · full Linux VM/);
    assertMatch(withoutRunner.html, /data-submit-enabled="true"/);
    withoutRunner.body.set("environment", "sandbox");
    withoutRunner.body.set("projectId", "");
    withoutRunner.body.set("orbSize", "medium");
    const sandboxed = await submit(withoutRunner.body);
    assertEquals(sandboxed?.placement, { provider: "sandbox" });
    assertEquals(sandboxed?.project, undefined);
    const catalogued = await store.getSessionCatalogEntry(client.workspaceId, sandboxed!.sessionId);
    assertEquals(catalogued !== null && "projectId" in catalogued, false);

    const project = await store.saveProject(client.workspaceId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    });
    assert(project.status === "saved");
    await store.saveGitAuthorConfiguration(client.userId, GIT_AUTHOR);

    // With a runner the composer offers both and starts on the runner.
    sessions.runnerId = (await enrollRunner(store, client.workspaceId)).runnerId;
    const withRunner = await composerFields();
    assertStringIncludes(withRunner.html, "Runner · full Linux VM");
    assertMatch(
      withRunner.html,
      /<input[^>]*name="environment"[^>]*type="hidden"[^>]*value="runner"/,
    );
    assertStringIncludes(withRunner.html, "No project");
    withRunner.body.set("environment", "runner");
    withRunner.body.set("orbSize", "medium");
    withRunner.body.set("projectId", project.project.id);
    const onRunner = await submit(withRunner.body);
    assertEquals(onRunner?.placement, { provider: "runner", runnerId: sessions.runnerId });
    assertEquals(onRunner?.project?.id, project.project.id);
    // Runners may also go without a project; then no Git integration is loaded.
    withRunner.body.set("projectId", "");
    const bare = await submit(withRunner.body);
    assertEquals(bare?.placement, { provider: "runner", runnerId: sessions.runnerId });
    assertEquals(bare?.project, undefined);
    // The Sandbox never checks out a project, even one still selected in the hidden control.
    withRunner.body.set("environment", "sandbox");
    withRunner.body.set("projectId", project.project.id);
    const chosen = await submit(withRunner.body);
    assertEquals(chosen?.placement, { provider: "sandbox" });
    assertEquals(chosen?.project, undefined);
  } finally {
    await server.close();
  }
});

test("browser form waits for Session creation, catalogs first, rolls back failures, and keeps secrets in the gateway", async () => {
  const { workspace: store, storage } = activate();
  const { sessions, router } = createSessionServer(store);
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    sessions.workspaceId = client.workspaceId;
    const projectResult = await store.saveProject(client.workspaceId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    });
    assert(projectResult.status === "saved");
    await store.saveGitHubCredential(client.workspaceId, GITHUB_TOKEN);
    await store.saveGitAuthorConfiguration(client.userId, GIT_AUTHOR);
    await store.saveModelProviderCredential(client.workspaceId, PROVIDER_ID, MODEL_PROVIDER_KEY);
    await store.saveSecret(
      client.workspaceId,
      "DEPLOY_TOKEN",
      ENVIRONMENT_SECRET_VALUE,
      ENVIRONMENT_SECRET_HOSTS,
    );
    const enrolled = await enrollRunner(store, client.workspaceId);
    sessions.runnerId = enrolled.runnerId;

    const createPage = await fetch(new URL(routes.app.index.href(), server.baseUrl), {
      redirect: "manual",
      headers: { Cookie: client.cookie },
    });
    assertEquals(createPage.status, 200);
    const createHtml = await createPage.text();
    assertEquals(createPage.headers.get("location"), null);
    assertMatch(createHtml, /interactive-widget=resizes-content/);
    assertNotMatch(createHtml, /<h1/);
    assertMatch(
      createHtml,
      /<button[^>]*command="show-modal"[^>]*commandfor="openorb-new-session"[^>]*>[\s\S]*?New session/,
    );
    assertMatch(createHtml, /<dialog[^>]*id="openorb-new-session"/);
    assertNotMatch(createHtml, /<dialog[^>]*id="openorb-new-session"[^>]* open/);
    assertStringIncludes(
      createHtml,
      '"exportName":"SessionComposerClient","moduleUrl":"/assets/app/ui/public/session-composer.tsx","props":{"projects":[',
    );
    assertMatch(createHtml, /Write prompt…/);
    assertMatch(createHtml, /tiny · 1 CPU · 2 GB memory/);
    assertMatch(createHtml, /small · 2 CPUs · 4 GB memory/);
    assertMatch(
      createHtml,
      /<div[^>]*role="option"[^>]*aria-selected="true"[^>]*>[\s\S]*?medium · 4 CPUs · 8 GB memory/,
    );
    assertMatch(createHtml, /large · 8 CPUs · 16 GB memory/);
    assertMatch(createHtml, /xxlarge · 16 CPUs · 32 GB memory/);
    assertMatch(createHtml, /<input[^>]*name="orbSize"[^>]*type="hidden"[^>]*value="medium"/);
    assertNotMatch(createHtml, /aria-label="Runner"/);
    assertNotMatch(createHtml, /name="sessionId"/);
    assertMatch(createHtml, /<input[^>]*type="hidden"[^>]*name="runnerId"[^>]*value=""/);
    assertMatch(createHtml, /<input[^>]*name="ref"[^>]*value="main"/);
    assertMatch(createHtml, /<input[^>]*name="branchName"[^>]*value="main"/);
    assertMatch(createHtml, /aria-label="Orb size"/);
    assertMatch(createHtml, /aria-label="Thinking level"/);
    assertMatch(createHtml, /aria-label="Search models"/);
    assertMatch(
      createHtml,
      /<input[^>]*type="hidden"[^>]*name="model"[^>]*value="[^"]*deepseek-v4-flash"/,
    );
    assertMatch(
      createHtml,
      /<div[^>]*data-thinking-level-option="high"[^>]*aria-selected="true"[^>]*>[\s\S]*?<span>High<\/span>/,
    );
    assertMatch(
      createHtml,
      /<div[^>]*data-thinking-level-option="minimal"[^>]*hidden[^>]*>[\s\S]*?<span>Minimal<\/span>/,
    );
    const maxThinkingOption = createHtml.match(
      /<div[^>]*data-thinking-level-option="max"[^>]*>[\s\S]*?<span>Max<\/span>/,
    )?.[0];
    assert(maxThinkingOption);
    assertNotMatch(maxThinkingOption, /hidden/);
    assertMatch(createHtml, /<input[^>]*name="thinkingLevel"[^>]*value="high"/);
    assertMatch(createHtml, /aria-keyshortcuts="Enter"/);
    assertMatch(createHtml, /deepseek-v4-flash/);
    assertNotMatch(createHtml, /name="apiKey"/);
    const projectControl = createHtml.indexOf('name="projectId"');
    const orbControl = createHtml.indexOf('name="orbSize"');
    const modelControl = createHtml.indexOf('aria-label="Model"');
    assert(projectControl !== -1 && projectControl < orbControl && orbControl < modelControl);
    assert(!createHtml.includes(GITHUB_TOKEN));
    assert(!createHtml.includes(MODEL_PROVIDER_KEY));
    assert(!createHtml.includes(ENVIRONMENT_SECRET_VALUE));

    // The catalog entry exists before the Session is created, and the browser waits for creation.
    const releaseCreate = Promise.withResolvers<void>();
    const catalogAtCreate: unknown[] = [];
    sessions.beforeCreate = async (input) => {
      catalogAtCreate.push(await store.getSessionCatalogEntry(client.workspaceId, input.sessionId));
      await releaseCreate.promise;
    };
    const composerSessionId = crypto.randomUUID();
    let settled = false;
    const pendingResponse = fetch(new URL(routes.app.sessions.create.href(), server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(createHtml),
        sessionId: composerSessionId,
        projectId: projectResult.project.id,
        model: MODEL,
        ref: "main",
        environment: "runner",
        runnerId: "",
        orbSize: "small",
        thinkingLevel: "max",
        branchName: "openorb/browser-test",
        initialPrompt: INITIAL_PROMPT,
      }),
    }).finally(() => {
      settled = true;
    });
    await waitFor(() => catalogAtCreate.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(settled, false, "the browser must wait for Session creation");
    releaseCreate.resolve();
    const response = await pendingResponse;
    sessions.beforeCreate = undefined;
    assertEquals(response.status, 303);
    const location = response.headers.get("location");
    assert(location);
    const [create] = createInputs(sessions);
    assert(create);
    const sessionId = create.sessionId;
    assert(sessionId !== composerSessionId);
    assertEquals(location, routes.app.sessions.detail.href({ sessionId }));
    assertEquals(catalogAtCreate, [
      {
        id: sessionId,
        projectId: projectResult.project.id,
        createdAt: create.createdAt,
        initialPromptPreview: "Inspect this repository and explain the architecture.",
      },
    ]);
    assertEquals(create, {
      workspaceId: client.workspaceId,
      sessionId,
      project: {
        id: projectResult.project.id,
        repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
        ref: "main",
        branchName: "openorb/browser-test",
        gitAuthor: { name: GIT_AUTHOR.authorName, email: GIT_AUTHOR.authorEmail },
      },
      createdAt: create.createdAt,
      placement: { provider: "runner", runnerId: sessions.runnerId },
      orbSize: "small",
      model: MODEL,
      thinkingLevel: "max",
      initialPrompt: INITIAL_PROMPT,
      origin: { kind: "user" },
    });
    assertEquals(new Date(create.createdAt).toISOString(), create.createdAt);
    const catalog = storage.rows(
      `SELECT id, projectId, createdAt, initialPromptPreview
      FROM sessions WHERE workspaceId = ?`,
      client.workspaceId,
    );
    assertEquals(catalog, [
      {
        id: sessionId,
        projectId: projectResult.project.id,
        createdAt: create.createdAt,
        initialPromptPreview: "Inspect this repository and explain the architecture.",
      },
    ]);

    // A Session that cannot be created leaves no catalog entry and reopens the composer.
    sessions.createError = "The runner could not accept the Session.";
    const failedCreate = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(createHtml),
      projectId: projectResult.project.id,
      model: MODEL,
      ref: "main",
      runnerId: "",
      branchName: "openorb/browser-test",
      initialPrompt: "This session fails to start",
    });
    assertEquals(failedCreate.status, 503);
    const failedCreateHtml = await failedCreate.text();
    assertMatch(failedCreateHtml, /<dialog[^>]*id="openorb-new-session"[^>]* open/);
    assertStringIncludes(failedCreateHtml, "The runner could not accept the Session.");
    assertStringIncludes(failedCreateHtml, "This session fails to start");
    sessions.createError = undefined;
    const failedSessionId = createInputs(sessions)[1]?.sessionId;
    assert(failedSessionId);
    assertEquals(await store.getSessionCatalogEntry(client.workspaceId, failedSessionId), null);
    assertEquals(sessions.views.has(failedSessionId), false);
    assertEquals(
      (await store.listSessionNavigationEntries(client.workspaceId)).map((entry) => entry.id),
      [sessionId],
    );

    // Credentials stay encrypted in the Workspace; none are forwarded to the Session.
    assertEquals(storage.rows("SELECT id FROM git_credentials").length, 1);
    assertEquals(storage.rows("SELECT id FROM model_provider_credentials").length, 1);
    assertEquals(
      storage.rows("SELECT key FROM encrypted_secrets WHERE purpose = 'generic-secret'").length,
      1,
    );
    assertNoSecrets(storage.dump());
    assertNoSecrets(JSON.stringify(sessions.calls));

    const pendingDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    assertEquals(pendingDetail.status, 200);
    assertStringIncludes(await pendingDetail.text(), "Connecting to the orb");

    const olderSessionId = crypto.randomUUID();
    const newerSessionId = crypto.randomUUID();
    for (const entry of [
      catalogEntry(
        olderSessionId,
        projectResult.project.id,
        "2020-08-17T11:00:00Z",
        "Older sidebar session",
      ),
      catalogEntry(
        newerSessionId,
        projectResult.project.id,
        "2099-08-17T13:00:00Z",
        "Newer sidebar session",
      ),
    ]) {
      assertEquals(await store.addSessionCatalogEntry(client.workspaceId, entry), [
        undefined,
        undefined,
      ]);
    }
    assertEquals(
      (await store.listSessionNavigationEntries(client.workspaceId)).map((session) => session.id),
      [newerSessionId, sessionId, olderSessionId],
    );

    sessions.update(sessionId, {
      state: "ready",
      agentState: "idle",
      environmentState: "running",
    });
    const detail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    assertEquals(detail.status, 200);
    const detailHtml = await detail.text();
    assertMatch(detailHtml, /title="Context window use"/);
    assertMatch(detailHtml, /\?\/1\.0M/);
    assertMatch(
      detailHtml,
      /<h1[^>]*data-top-bar-title[^>]*>Inspect this repository and explain the architecture\.<\/h1>/,
    );
    assertNotMatch(detailHtml, /aria-label="Breadcrumb"/);
    assertNotMatch(detailHtml, /Session <code>/);
    assertNotMatch(detailHtml, /<span>Repository<\/span>/);
    assertMatch(detailHtml, /\/assets\/app\/actions\/sessions\/public\/session-detail-client\.tsx/);
    assertMatch(detailHtml, /"exportName":"SessionDetailClient"/);
    assertStringIncludes(detailHtml, 'data-rmx-target="session-workspace"');
    assertStringIncludes(
      detailHtml,
      `data-rmx-src="${routes.app.sessions.frame.href({ sessionId: sessionId })}"`,
    );
    assertMatch(
      detailHtml,
      /<link data-rmx(?:-module-preload)? rel="modulepreload" href="\/assets\/app\/actions\/sessions\/public\/session-detail-client\.tsx" \/>/,
    );
    assertMatch(
      detailHtml,
      /<link data-rmx(?:-module-preload)?[^>]+href="\/assets\/app\/actions\/sessions\/public\/session-changes-panel\.tsx"/,
    );
    assertMatch(detailHtml, /<link data-rmx(?:-module-preload)?[^>]+href="\/assets\/npm\//);
    assertNotMatch(detailHtml, /"exportName":"SessionVmControl"/);
    assertNotMatch(detailHtml, /"exportName":"SessionChangesPanel"/);
    assertMatch(detailHtml, /aria-label="Session changes"/);
    assertMatch(detailHtml, />Changes<\/strong>/);
    assertMatch(detailHtml, new RegExp(`action="/app/sessions/${sessionId}/messages"`));
    assertMatch(detailHtml, /<textarea[^>]*name="prompt"[^>]*aria-label="Continue session"/);
    assertMatch(detailHtml, /aria-label="Send prompt"/);
    assertMatch(detailHtml, new RegExp(`action="/app/sessions/${sessionId}/stop"`));
    assertMatch(detailHtml, /aria-label="Agent: idle · Environment: running"/);
    assertMatch(detailHtml, /aria-label="Stop Session"/);
    assertNotMatch(detailHtml, /data-session-toolbar/);
    assertNotMatch(detailHtml, />Abort<\/button>/);
    assertNotMatch(detailHtml, /data-session-events/);
    assert(!detailHtml.includes(GITHUB_TOKEN));
    assert(!detailHtml.includes(MODEL_PROVIDER_KEY));
    assert(!detailHtml.includes(ENVIRONMENT_SECRET_VALUE));

    const frame = await fetch(
      new URL(routes.app.sessions.frame.href({ sessionId: sessionId }), server.baseUrl),
      { headers: { Cookie: client.cookie } },
    );
    assertEquals(frame.status, 200);
    const frameHtml = await frame.text();
    assertMatch(frameHtml, /aria-label="Session changes"/);
    assertStringIncludes(frameHtml, 'data-thinking-level="max"');
    assertNotMatch(frameHtml, /aria-label="Primary navigation"/);

    const anonymousFrame = await fetch(
      new URL(routes.app.sessions.frame.href({ sessionId: sessionId }), server.baseUrl),
      { redirect: "manual" },
    );
    assertEquals(anonymousFrame.status, 302);
    assertEquals(anonymousFrame.headers.get("location"), "/");

    const missingFrame = await fetch(
      new URL(
        routes.app.sessions.frame.href({ sessionId: "00000000-0000-4000-8000-000000000000" }),
        server.baseUrl,
      ),
      { headers: { Cookie: client.cookie } },
    );
    assertEquals(missingFrame.status, 404);
    const missingFrameHtml = await missingFrame.text();
    assertStringIncludes(missingFrameHtml, 'role="alert"');
    assertStringIncludes(missingFrameHtml, "This session no longer exists.");
    assertNotMatch(detailHtml, /<a href="\/app\/"[^>]*>[\s\S]*?Overview[\s\S]*?<\/a>/);
    assertNotMatch(
      detailHtml,
      /<a href="\/app\/sessions"[^>]*>[\s\S]*?<span[^>]*>Sessions<\/span>[\s\S]*?<\/a>/,
    );
    const newerSidebarLink = detailHtml.indexOf(
      routes.app.sessions.detail.href({ sessionId: newerSessionId }),
    );
    const currentSidebarLink = detailHtml.indexOf(
      routes.app.sessions.detail.href({ sessionId: sessionId }),
    );
    const olderSidebarLink = detailHtml.indexOf(
      routes.app.sessions.detail.href({ sessionId: olderSessionId }),
    );
    const projectsLink = detailHtml.indexOf(routes.app.projects.index.href(), olderSidebarLink);
    assert(
      newerSidebarLink !== -1 &&
        newerSidebarLink < currentSidebarLink &&
        currentSidebarLink < olderSidebarLink,
    );
    assert(projectsLink > olderSidebarLink);

    const gitSnapshotHref = routes.api.sessions.gitSnapshot.href({ sessionId });
    const gitSnapshotResponse = await fetch(new URL(gitSnapshotHref, server.baseUrl), {
      headers: { Accept: "application/json", Cookie: client.cookie },
    });
    assertEquals(gitSnapshotResponse.status, 200);
    assertEquals(gitSnapshotResponse.headers.get("cache-control"), "no-store");
    const gitSnapshot = await gitSnapshotResponse.json();
    assertEquals(gitSnapshot.branch, "openorb/browser-test");
    assertEquals(gitSnapshot.head, "0123456789abcdef0123456789abcdef01234567");
    assertEquals(gitSnapshot.sections.staged.files, []);
    assertEquals(gitSnapshot.sections.unstaged.files, []);
    assertEquals("summary" in gitSnapshot, false);

    const gitPatchHref = routes.api.sessions.gitPatchChunk.href({
      sessionId,
      snapshotId: GIT_SNAPSHOT_ID,
      section: "staged",
      offset: "16",
    });
    const gitPatchResponse = await fetch(new URL(gitPatchHref, server.baseUrl), {
      headers: { Accept: "application/json", Cookie: client.cookie },
    });
    assertEquals(gitPatchResponse.status, 200);
    assertEquals(gitPatchResponse.headers.get("cache-control"), "no-store");
    const gitPatch = await gitPatchResponse.json();
    assertEquals(
      new TextDecoder().decode(Buffer.from(gitPatch.bytes, "base64")),
      "DME.md b/README.",
    );
    assertEquals(
      { ...gitPatch, bytes: undefined },
      {
        snapshotId: GIT_SNAPSHOT_ID,
        section: "staged",
        offset: 16,
        bytes: undefined,
        nextOffset: 32,
        done: false,
      },
    );
    assertEquals(sessions.inputsOf("gitPatchChunk"), [
      { snapshotId: GIT_SNAPSHOT_ID, section: "staged", offset: 16 },
    ]);

    // Published media streams from the media bucket; inline images come from the Session itself.
    sessions.publish(sessionId, ARTIFACT_ID, ARTIFACT_BYTES);
    sessions.mediaItems.set(`${sessionId}/${INLINE_IMAGE_ID}`, {
      kind: "inline",
      mediaType: "image/png",
      bytes: INLINE_IMAGE_BYTES,
    });
    const mediaKey = `media/${client.workspaceId}/${sessionId}/${ARTIFACT_ID}`;
    const artifactHref = routes.api.sessions.artifact.href({
      sessionId,
      artifactId: ARTIFACT_ID,
    });
    const artifactResponse = await fetch(new URL(artifactHref, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    assertEquals(artifactResponse.status, 200);
    assertEquals(artifactResponse.headers.get("content-type"), "video/mp4");
    assertEquals(artifactResponse.headers.get("accept-ranges"), "bytes");
    assertEquals(artifactResponse.headers.get("x-content-type-options"), "nosniff");
    assertStringIncludes(
      artifactResponse.headers.get("content-disposition") ?? "",
      'filename="preview.mp4"',
    );
    assertEquals(new Uint8Array(await artifactResponse.arrayBuffer()), ARTIFACT_BYTES);

    const rangeResponse = await fetch(new URL(artifactHref, server.baseUrl), {
      headers: { Cookie: client.cookie, Range: "bytes=3-7" },
    });
    assertEquals(rangeResponse.status, 206);
    assertEquals(rangeResponse.headers.get("content-range"), "bytes 3-7/10");
    assertEquals(rangeResponse.headers.get("content-length"), "5");
    assertEquals(new TextDecoder().decode(await rangeResponse.arrayBuffer()), "34567");
    assertEquals(sessions.mediaReads, [
      { key: mediaKey, range: { offset: 0, length: 10 } },
      { key: mediaKey, range: { offset: 3, length: 5 } },
    ]);

    const invalidRange = await fetch(new URL(artifactHref, server.baseUrl), {
      headers: { Cookie: client.cookie, Range: "bytes=20-30" },
    });
    assertEquals(invalidRange.status, 416);
    assertEquals(invalidRange.headers.get("content-range"), "bytes */10");
    await invalidRange.body?.cancel();
    assertEquals(sessions.mediaReads.length, 2);
    const anonymousArtifact = await fetch(new URL(artifactHref, server.baseUrl));
    assertEquals(anonymousArtifact.status, 401);
    await anonymousArtifact.body?.cancel();

    const inlineImage = await fetch(
      new URL(
        routes.api.sessions.artifact.href({ sessionId, artifactId: INLINE_IMAGE_ID }),
        server.baseUrl,
      ),
      { headers: { Cookie: client.cookie } },
    );
    assertEquals(inlineImage.status, 200);
    assertEquals(inlineImage.headers.get("content-type"), "image/png");
    assertStringIncludes(
      inlineImage.headers.get("content-disposition") ?? "",
      'filename="image.png"',
    );
    assertEquals(new Uint8Array(await inlineImage.arrayBuffer()), INLINE_IMAGE_BYTES);
    assertEquals(sessions.mediaReads.length, 2);

    const missingArtifact = await fetch(
      new URL(
        routes.api.sessions.artifact.href({ sessionId, artifactId: crypto.randomUUID() }),
        server.baseUrl,
      ),
      { headers: { Cookie: client.cookie } },
    );
    assertEquals(missingArtifact.status, 404);
    await missingArtifact.body?.cancel();

    const wakeHref = routes.api.sessions.wake.href({ sessionId });
    const anonymousWake = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
    });
    assertEquals(anonymousWake.status, 401);
    await anonymousWake.body?.cancel();
    const missingWakeCsrf = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
    });
    assertEquals(missingWakeCsrf.status, 403);
    await missingWakeCsrf.body?.cancel();
    assertEquals(sessions.inputsOf("wake"), []);
    const woken = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(detailHtml) }),
    });
    assertEquals(woken.status, 202);
    assertEquals(await woken.json(), { status: "accepted" });
    assertEquals(sessions.inputsOf("wake", sessionId), [undefined]);

    const changesHref = routes.api.sessions.changes.href({ sessionId });
    const anonymousChange = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ action: "stage", path: "README.md" }),
    });
    assertEquals(anonymousChange.status, 401);
    await anonymousChange.body?.cancel();
    const missingChangeCsrf = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ action: "stage", path: "README.md" }),
    });
    assertEquals(missingChangeCsrf.status, 403);
    await missingChangeCsrf.body?.cancel();
    const uncatalogedSessionId = crypto.randomUUID();
    const missingSessionChange = await fetch(
      new URL(
        routes.api.sessions.changes.href({ sessionId: uncatalogedSessionId }),
        server.baseUrl,
      ),
      {
        method: "POST",
        redirect: "manual",
        headers: { Accept: "application/json", Cookie: client.cookie },
        body: new URLSearchParams({
          _csrf: csrfFrom(detailHtml),
          action: "stage",
          path: "README.md",
        }),
      },
    );
    assertEquals(missingSessionChange.status, 404);
    await missingSessionChange.body?.cancel();
    assertEquals(sessions.addressed.includes(uncatalogedSessionId), false);
    assertEquals(sessions.inputsOf("updateGitFile"), []);

    const exactPath = "README*\n.md";
    const exactPreviousPath = "README?\nold.md";
    const stagedChange = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        action: "stage",
        path: exactPath,
        previousPath: exactPreviousPath,
      }),
    });
    assertEquals(stagedChange.status, 200);
    assertEquals(stagedChange.headers.get("cache-control"), "no-store");
    assertEquals(await stagedChange.json(), { mutationRevision: 1 });
    const unstagedChange = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        action: "unstage",
        path: exactPath,
      }),
    });
    assertEquals(unstagedChange.status, 200);
    assertEquals(await unstagedChange.json(), { mutationRevision: 2 });
    assertEquals(sessions.inputsOf("updateGitFile", sessionId), [
      { action: "stage", path: exactPath, previousPath: exactPreviousPath },
      { action: "unstage", path: exactPath },
    ]);

    const messageHref = routes.app.sessions.message.href({ sessionId });
    const missingMessageCsrf = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ prompt: "Continue without CSRF" }),
    });
    assertEquals(missingMessageCsrf.status, 403);
    await missingMessageCsrf.body?.cancel();
    assertEquals(sessions.inputsOf("submit"), []);

    const continued = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        prompt: "Commit the reviewed changes and push the session branch.",
      }),
    });
    assertEquals(continued.status, 303);
    assertEquals(continued.headers.get("location"), location);
    const [firstSubmission] = submitInputs(sessions, sessionId);
    assert(firstSubmission);
    assertMatch(firstSubmission.requestId, /^[0-9a-f-]{36}$/);
    assertEquals(firstSubmission, {
      origin: { kind: "user" },
      prompt: "Commit the reviewed changes and push the session branch.",
      requestId: firstSubmission.requestId,
    });

    const thinkingContinuation = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        prompt: "Think less about this one.",
        thinkingLevel: "low",
      }),
    });
    assertEquals(thinkingContinuation.status, 202);
    assertEquals(await thinkingContinuation.json(), { status: "accepted" });
    const secondSubmission = submitInputs(sessions, sessionId)[1];
    assert(secondSubmission);
    assert(secondSubmission.requestId !== firstSubmission.requestId);
    assertEquals(secondSubmission, {
      origin: { kind: "user" },
      prompt: "Think less about this one.",
      requestId: secondSubmission.requestId,
      thinkingLevel: "low",
    });

    const thinkingLevelHref = routes.app.sessions.thinkingLevel.href({ sessionId });
    const changedThinkingLevel = await fetch(new URL(thinkingLevelHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        thinkingLevel: "xhigh",
      }),
    });
    assertEquals(changedThinkingLevel.status, 202);
    assertEquals(await changedThinkingLevel.json(), { status: "accepted", level: "xhigh" });
    assertEquals(sessions.inputsOf("setThinkingLevel", sessionId), ["xhigh"]);

    const stopHref = routes.app.sessions.stop.href({ sessionId });
    const missingStopCsrf = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
    });
    assertEquals(missingStopCsrf.status, 403);
    await missingStopCsrf.body?.cancel();
    assertEquals(sessions.inputsOf("stop"), []);
    const stopped = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(detailHtml) }),
    });
    assertEquals(stopped.status, 202);
    assertEquals(await stopped.json(), { status: "accepted" });
    assertEquals(sessions.inputsOf("stop", sessionId).length, 1);

    sessions.update(sessionId, {
      state: "stopped",
      agentState: "idle",
      environmentState: "stopped",
    });
    const stoppedDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const stoppedHtml = await stoppedDetail.text();
    assertNotMatch(stoppedHtml, /data-session-stopped/);
    assertMatch(stoppedHtml, /aria-label="Continue session"/);
    assertMatch(stoppedHtml, /aria-label="Agent: idle · Environment: stopped"/);
    assertMatch(stoppedHtml, /aria-label="Wake"/);
    assertNotMatch(stoppedHtml, /aria-label="Stop Session"/);
    const alreadyStopped = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(stoppedHtml) }),
    });
    assertEquals(alreadyStopped.status, 409);
    assertEquals(await alreadyStopped.json(), {
      error: "The session cannot be stopped right now.",
    });
    assertEquals(sessions.inputsOf("stop", sessionId).length, 1);
    const coldWake = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(stoppedHtml) }),
    });
    assertEquals(coldWake.status, 202);
    assertEquals(await coldWake.json(), { status: "accepted" });
    assertEquals(sessions.inputsOf("wake", sessionId).length, 2);
    const coldContinuation = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(stoppedHtml),
        prompt: "Resume this stopped session",
      }),
    });
    assertEquals(coldContinuation.status, 303);
    assertEquals(submitInputs(sessions, sessionId)[2]?.prompt, "Resume this stopped session");

    sessions.update(sessionId, {
      state: "running",
      agentState: "running",
      environmentState: "running",
    });
    const runningDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const runningHtml = await runningDetail.text();
    assertMatch(runningHtml, new RegExp(`action="/app/sessions/${sessionId}/abort"`));
    assertMatch(runningHtml, new RegExp(`form="session-${sessionId}-abort"`));
    assertMatch(runningHtml, /aria-label="Stop active turn"/);
    assertMatch(runningHtml, /title="Stop active turn"/);
    assertMatch(runningHtml, /data-slot="stop-icon"/);
    assertMatch(
      runningHtml,
      /<textarea(?=[^>]*aria-label="Continue session")(?![^>]*disabled)[^>]*>/,
    );
    assertMatch(
      runningHtml,
      /<button(?=[^>]*aria-label="Stop active turn")(?![^>]*disabled)[^>]*>/,
    );
    assertMatch(runningHtml, /<button(?=[^>]*aria-label="Stop Session")(?![^>]*disabled)[^>]*>/);
    assertNotMatch(runningHtml, /aria-label="Send prompt"/);
    assertNotMatch(runningHtml, />Abort<\/button>/);
    const busyStop = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(runningHtml) }),
    });
    assertEquals(busyStop.status, 303);
    assertEquals(sessions.inputsOf("stop", sessionId).length, 2);
    const busyContinuation = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        prompt: "Queue this follow-up",
      }),
    });
    assertEquals(busyContinuation.status, 202);
    assertMatch(busyContinuation.headers.get("content-type") ?? "", /^application\/json\b/);
    assertEquals(await busyContinuation.json(), { status: "accepted" });
    assertEquals(submitInputs(sessions, sessionId).length, 4);
    assertEquals(submitInputs(sessions, sessionId)[3]?.prompt, "Queue this follow-up");

    const abortHref = routes.app.sessions.abort.href({ sessionId });
    const missingAbortCsrf = await fetch(new URL(abortHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
    });
    assertEquals(missingAbortCsrf.status, 403);
    await missingAbortCsrf.body?.cancel();
    assertEquals(sessions.inputsOf("abort"), []);

    const aborted = await fetch(new URL(abortHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(runningHtml) }),
    });
    assertEquals(aborted.status, 202);
    assertEquals(await aborted.json(), { status: "accepted" });
    assertEquals(sessions.inputsOf("abort", sessionId).length, 1);

    sessions.update(sessionId, {
      state: "ready",
      agentState: "idle",
      environmentState: "running",
    });
    const staleAbort = await fetch(new URL(abortHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(runningHtml) }),
    });
    assertEquals(staleAbort.status, 409);
    assertMatch(await staleAbort.text(), /no active Pi run to abort/);
    assertEquals(sessions.inputsOf("abort", sessionId).length, 1);

    // An unreachable Session fails closed: only its view is read and no command is issued.
    sessions.unreachable = true;
    const offlineDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    assertEquals(offlineDetail.status, 200);
    const offlineHtml = await offlineDetail.text();
    assertStringIncludes(
      offlineHtml,
      "Conversation history is unavailable while the connection is interrupted.",
    );
    assertMatch(offlineHtml, /data-connection-interrupted/);
    assertMatch(offlineHtml, /aria-label="Agent: unknown · Environment: unknown"/);
    assertMatch(
      offlineHtml,
      /<textarea(?=[^>]*aria-label="Continue session")(?![^>]*disabled)[^>]*>/,
    );
    assertMatch(offlineHtml, /<button(?=[^>]*aria-label="Send prompt")(?=[^>]*disabled)[^>]*>/);
    assertNotMatch(offlineHtml, /openorb\/browser-test/);
    assertNotMatch(offlineHtml, /0123456789abcdef0123456789abcdef01234567/);

    const offlineMark = sessions.calls.length;
    const offlineContinuation = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        prompt: "Do not queue this offline prompt",
      }),
    });
    assertEquals(offlineContinuation.status, 503);
    assertEquals(await offlineContinuation.json(), { error: "The session is unavailable." });
    const offlineAbort = await fetch(new URL(abortHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(runningHtml) }),
    });
    assertEquals(offlineAbort.status, 409);
    assertMatch(await offlineAbort.text(), /no active Pi run to abort/);
    const offlineStop = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(offlineHtml) }),
    });
    assertEquals(offlineStop.status, 409);
    assertEquals(await offlineStop.json(), { error: "The session cannot be stopped right now." });
    const offlineWake = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(offlineHtml) }),
    });
    assertEquals(offlineWake.status, 503);
    assertEquals(await offlineWake.json(), { error: "The session is unavailable." });
    // The HTML abort rejection also renders the detail frame, which reads the view again.
    assertEquals(new Set(sessions.methodsSince(offlineMark)), new Set(["view"]));
    const offlineGitSnapshot = await fetch(new URL(gitSnapshotHref, server.baseUrl), {
      headers: { Accept: "application/json", Cookie: client.cookie },
    });
    assertEquals(offlineGitSnapshot.status, 503);
    assertEquals(offlineGitSnapshot.headers.get("cache-control"), "no-store");
    assertEquals(await offlineGitSnapshot.json(), { error: SESSION_UNREACHABLE });
    const offlineGitFileUpdate = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(offlineHtml),
        action: "stage",
        path: "README.md",
      }),
    });
    assertEquals(offlineGitFileUpdate.status, 409);
    assertEquals(await offlineGitFileUpdate.json(), { error: SESSION_UNREACHABLE });
    assertEquals(submitInputs(sessions, sessionId).length, 4);
    assertEquals(sessions.inputsOf("abort", sessionId).length, 1);
    assertEquals(sessions.inputsOf("stop", sessionId).length, 2);
    assertEquals(sessions.inputsOf("wake", sessionId).length, 2);
    sessions.unreachable = false;

    sessions.update(sessionId, {
      state: "error",
      agentState: "idle",
      environmentState: "error",
      issues: [
        {
          category: "vm-start",
          severity: "failure",
          message: "The Gondolin VM could not be started.",
          diagnostics: "qemu exited safely",
          recovery: "retry-provisioning",
        },
      ],
    });
    const failedDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const failedHtml = await failedDetail.text();
    assertMatch(failedHtml, /data-session-issue="vm-start"/);
    assertMatch(failedHtml, /data-session-issue-diagnostics/);
    assertStringIncludes(failedHtml, "qemu exited safely");
    assertMatch(failedHtml, /name="recovery" value="retry-provisioning"/);
    const retryHref = routes.app.sessions.retry.href({ sessionId });
    const staleRetryResponse = await fetch(new URL(retryHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(failedHtml),
        recovery: "restart-environment",
      }),
    });
    assertEquals(staleRetryResponse.status, 409);
    assertMatch(await staleRetryResponse.text(), /offered recovery action changed/i);
    assertEquals(sessions.inputsOf("retry"), []);
    const retryResponse = await fetch(new URL(retryHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(failedHtml),
        recovery: "retry-provisioning",
      }),
    });
    assertEquals(retryResponse.status, 303);
    assertEquals(retryResponse.headers.get("location"), location);
    assertEquals(sessions.inputsOf("retry", sessionId), ["retry-provisioning"]);
    const settledRetry = await fetch(new URL(retryHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(failedHtml),
        recovery: "retry-provisioning",
      }),
    });
    assertEquals(settledRetry.status, 409);
    assertMatch(await settledRetry.text(), /Only a failed session/);
    assertEquals(sessions.inputsOf("retry", sessionId).length, 1);

    // The Session owns its event stream; the route forwards the request and the response.
    const eventsHref = routes.api.sessions.events.href({ sessionId });
    const anonymousEvents = await fetch(new URL(eventsHref, server.baseUrl));
    assertEquals(anonymousEvents.status, 401);
    await anonymousEvents.body?.cancel();
    assertEquals(sessions.inputsOf("events"), []);
    const eventResponse = await fetch(new URL(eventsHref, server.baseUrl), {
      headers: { Cookie: client.cookie, "Last-Event-ID": "7" },
    });
    assertEquals(eventResponse.status, 200);
    assertEquals(eventResponse.headers.get("content-type"), "text/event-stream");
    assertString(
      await eventResponse.text(),
      'event: session\ndata: {"type":"conversation.snapshot"',
    );
    assertEquals(sessions.inputsOf("events", sessionId), [{ lastEventId: "7" }]);

    assertNoSecrets(JSON.stringify(sessions.calls));
  } finally {
    await server.close();
  }
});

test("session routes enforce auth, CSRF, project ownership, and runner ownership", async () => {
  const { workspace: store } = activate();
  const { sessions, router } = createSessionServer(store);
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    sessions.workspaceId = client.workspaceId;
    const project = await store.saveProject(client.workspaceId, {
      name: "Owner project",
      repositoryUrl: "https://github.com/openorb/owner.git",
    });
    assert(project.status === "saved");
    await store.saveModelProviderCredential(client.workspaceId, PROVIDER_ID, MODEL_PROVIDER_KEY);
    await store.saveModelProviderCredential(
      client.workspaceId,
      OPENAI_PROVIDER_ID,
      OPENAI_PROVIDER_KEY,
    );
    const { workspace: otherWorkspace, workspaceId: otherWorkspaceId } = await createWorkspace();
    const foreignProject = await otherWorkspace.saveProject(otherWorkspaceId, {
      name: "Foreign project",
      repositoryUrl: "https://github.com/openorb/foreign.git",
    });
    assert(foreignProject.status === "saved");
    sessions.runnerId = (await enrollRunner(store, client.workspaceId)).runnerId;

    const anonymous = await fetch(new URL(routes.app.index.href(), server.baseUrl), {
      redirect: "manual",
    });
    assertEquals(anonymous.status, 302);
    assertEquals(anonymous.headers.get("location"), "/");
    const page = await fetch(new URL(routes.app.index.href(), server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const html = await page.text();
    assertMatch(html, /DeepSeek V4 Flash/);
    assertMatch(html, /GPT-4\.1/);
    const sessionsIndex = await fetch(new URL(routes.app.sessions.index.href(), server.baseUrl), {
      redirect: "manual",
      headers: { Cookie: client.cookie },
    });
    assertEquals(sessionsIndex.status, 302);
    assertEquals(sessionsIndex.headers.get("location"), routes.app.index.href());
    const composerSessionId = crypto.randomUUID();
    const unCsrf = await submitSession(server.baseUrl, client.cookie, {
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: sessions.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unCsrf.status, 403);
    await unCsrf.body?.cancel();

    const foreign = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      sessionId: composerSessionId,
      projectId: foreignProject.project.id,
      model: MODEL,
      ref: "main",
      runnerId: sessions.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(foreign.status, 404);
    const foreignHtml = await foreign.text();
    assertMatch(foreignHtml, /<dialog[^>]*id="openorb-new-session"[^>]* open/);
    assertMatch(foreignHtml, /Project is unavailable or does not exist/);
    assertNotMatch(foreignHtml, /name="sessionId"/);
    assertEquals(createInputs(sessions).length, 0);

    const unsupportedProvider = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: "openai/not-a-pi-model",
      ref: "main",
      runnerId: sessions.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unsupportedProvider.status, 400);
    assertMatch(await unsupportedProvider.text(), /selected Pi model is unavailable/);
    assertEquals(createInputs(sessions).length, 0);

    const unavailableRunner = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: crypto.randomUUID(),
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unavailableRunner.status, 409);
    assertEquals(createInputs(sessions).length, 0);

    const foreignRunner = await enrollRunner(otherWorkspace, otherWorkspaceId);
    const foreignRunnerSubmission = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: foreignRunner.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(foreignRunnerSubmission.status, 409);
    await foreignRunnerSubmission.body?.cancel();
    assertEquals(createInputs(sessions).length, 0);

    const unsupportedOrbSize = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: sessions.runnerId,
      orbSize: "large",
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unsupportedOrbSize.status, 409);
    assertMatch(await unsupportedOrbSize.text(), /cannot provision the large orb size/);
    assertEquals(createInputs(sessions).length, 0);

    const invalidOrbSize = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: sessions.runnerId,
      orbSize: "enormous",
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(invalidOrbSize.status, 400);
    assertEquals(createInputs(sessions).length, 0);

    const invalidThinkingLevel = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: sessions.runnerId,
      thinkingLevel: "unbounded",
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(invalidThinkingLevel.status, 400);
    assertEquals(createInputs(sessions).length, 0);

    const missingAuthor = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: sessions.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(missingAuthor.status, 409);
    assertMatch(await missingAuthor.text(), /Configure your Git author name and email/);
    assertEquals(createInputs(sessions).length, 0);
    await store.saveGitAuthorConfiguration(client.userId, GIT_AUTHOR);

    const alternateProvider = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      sessionId: composerSessionId,
      projectId: project.project.id,
      model: OPENAI_MODEL,
      ref: "main",
      runnerId: sessions.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(alternateProvider.status, 303);
    const [alternateCreate] = createInputs(sessions);
    assert(alternateCreate);
    assert(alternateCreate.sessionId !== composerSessionId);
    assertEquals(
      alternateProvider.headers.get("location"),
      routes.app.sessions.detail.href({ sessionId: alternateCreate.sessionId }),
    );
    assertEquals(alternateCreate.model, OPENAI_MODEL);
    assertEquals(alternateCreate.thinkingLevel, "high");
    assertEquals(alternateCreate.placement, { provider: "runner", runnerId: sessions.runnerId });
    assertEquals(alternateCreate.workspaceId, client.workspaceId);
    assertEquals(alternateCreate.project?.id, project.project.id);
    assertEquals(JSON.stringify(alternateCreate).includes(OPENAI_PROVIDER_KEY), false);

    assertEquals(await store.deleteModelProviderCredential(client.workspaceId, PROVIDER_ID), {
      status: "deleted",
    });
    const unconfiguredProvider = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: sessions.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unconfiguredProvider.status, 409);
    assertMatch(await unconfiguredProvider.text(), /Configure the selected model provider/);
    assertEquals(createInputs(sessions).length, 1);
    assertEquals(sessions.addressed, [alternateCreate.sessionId]);
  } finally {
    await server.close();
  }
});

test("browser deletion confirms, dispatches cleanup, tombstones, and isolates tenants", async () => {
  const { workspace: store } = activate();
  const { sessions, router } = createSessionServer(store);
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    sessions.workspaceId = client.workspaceId;
    const projectResult = await store.saveProject(client.workspaceId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    });
    assert(projectResult.status === "saved");
    await store.saveGitAuthorConfiguration(client.userId, GIT_AUTHOR);
    await store.saveModelProviderCredential(client.workspaceId, PROVIDER_ID, MODEL_PROVIDER_KEY);
    const enrolled = await enrollRunner(store, client.workspaceId);
    sessions.runnerId = enrolled.runnerId;

    const onlineSession = deletionSnapshot(
      crypto.randomUUID(),
      projectResult.project.id,
      "Delete this online session",
    );
    assertEquals(await store.addSessionCatalogEntry(client.workspaceId, onlineSession), [
      undefined,
      undefined,
    ]);
    sessions.views.set(onlineSession.id, onlineSession);

    const detailUrl = new URL(
      routes.app.sessions.detail.href({ sessionId: onlineSession.id }),
      server.baseUrl,
    );
    const detail = await fetch(detailUrl, { headers: { Cookie: client.cookie } });
    assertEquals(detail.status, 200);
    const detailHtml = await detail.text();
    const csrfToken = csrfFrom(detailHtml);
    const deleteHref = routes.app.sessions.delete.href({ sessionId: onlineSession.id });
    assertStringIncludes(detailHtml, "Delete session?");
    assertStringIncludes(
      detailHtml,
      "This permanently deletes the Pi conversation, VM disk, snapshots, and logs for this session.",
    );
    assertStringIncludes(detailHtml, "This cannot be undone.");
    assertStringIncludes(detailHtml, `action="${deleteHref}"`);
    assertMatch(detailHtml, /<button[^>]*type="submit"[^>]*>Delete session<\/button>/);

    const missingCsrf = await fetch(new URL(deleteHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
    });
    assertEquals(missingCsrf.status, 403);
    assert(await store.getSessionCatalogEntry(client.workspaceId, onlineSession.id));
    await missingCsrf.body?.cancel();
    assertEquals(sessions.inputsOf("delete"), []);

    // The catalog entry is tombstoned before the Session is told to clean up.
    const catalogAtDelete: unknown[] = [];
    sessions.beforeDelete = async (sessionId) => {
      catalogAtDelete.push(await store.getSessionCatalogEntry(client.workspaceId, sessionId));
    };

    const deleted = await submitDeletion(
      server.baseUrl,
      client.cookie,
      onlineSession.id,
      csrfToken,
    );
    assertEquals(deleted.status, 303);
    assertEquals(deleted.headers.get("location"), routes.app.index.href());
    assertEquals(await store.getSessionCatalogEntry(client.workspaceId, onlineSession.id), null);
    assertEquals(
      sessions.calls.filter((call) => call.method === "delete"),
      [{ sessionId: onlineSession.id, method: "delete", input: undefined }],
    );
    assertEquals(catalogAtDelete, [null]);
    assertEquals(sessions.views.has(onlineSession.id), false);

    const offlineSession = deletionSnapshot(
      crypto.randomUUID(),
      projectResult.project.id,
      "Delete this lost runner session",
    );
    assertEquals(await store.addSessionCatalogEntry(client.workspaceId, offlineSession), [
      undefined,
      undefined,
    ]);
    assertEquals(await store.revokeRunner(client.workspaceId, enrolled.runnerId), "revoked");
    // Deletion does not depend on a reachable Session or a connected runner.
    sessions.unreachable = true;
    const offlineDeleted = await submitDeletion(
      server.baseUrl,
      client.cookie,
      offlineSession.id,
      csrfToken,
    );
    assertEquals(offlineDeleted.status, 303);
    assertEquals(await store.getSessionCatalogEntry(client.workspaceId, offlineSession.id), null);
    assertEquals(sessions.inputsOf("delete", offlineSession.id), [undefined]);
    sessions.unreachable = false;

    const { workspace: otherWorkspace, workspaceId: otherWorkspaceId } = await createWorkspace();
    const otherProject = await otherWorkspace.saveProject(otherWorkspaceId, {
      name: "Other Workspace project",
      repositoryUrl: "https://github.com/meln1k/other-project.git",
    });
    assert(otherProject.status === "saved");
    const foreignSession = deletionSnapshot(
      crypto.randomUUID(),
      otherProject.project.id,
      "Foreign session",
    );
    assertEquals(await otherWorkspace.addSessionCatalogEntry(otherWorkspaceId, foreignSession), [
      undefined,
      undefined,
    ]);
    // A Session of another Workspace is never addressed, even when it exists and is healthy.
    sessions.views.set(foreignSession.id, foreignSession);
    const foreignDelete = await submitDeletion(
      server.baseUrl,
      client.cookie,
      foreignSession.id,
      csrfToken,
    );
    assertEquals(foreignDelete.status, 404);
    assert(await otherWorkspace.getSessionCatalogEntry(otherWorkspaceId, foreignSession.id));
    await foreignDelete.body?.cancel();
    await assertForeignSessionHidden(server.baseUrl, client.cookie, csrfToken, foreignSession.id);
    assertEquals(sessions.addressed.includes(foreignSession.id), false);
    assertEquals(sessions.views.has(foreignSession.id), true);

    const sameIdForOtherWorkspace = deletionSnapshot(
      onlineSession.id,
      otherProject.project.id,
      "Same ID in another Workspace",
    );
    assertEquals(
      await otherWorkspace.addSessionCatalogEntry(otherWorkspaceId, sameIdForOtherWorkspace),
      [undefined, undefined],
    );
    assert(await otherWorkspace.getSessionCatalogEntry(otherWorkspaceId, onlineSession.id));
    assertEquals(await store.getSessionCatalogEntry(client.workspaceId, onlineSession.id), null);
  } finally {
    await server.close();
  }
});

interface BrowserClient {
  cookie: string;
  userId: UserId;
  workspaceId: WorkspaceId;
}

async function authenticate(
  baseUrl: URL,
  store: ReturnType<typeof activate>["workspace"],
): Promise<BrowserClient> {
  const setupUrl = new URL(routes.auth.setup.index.href(), baseUrl);
  const setupPage = await fetch(setupUrl);
  const setupResponse = await fetch(setupUrl, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookieFrom(setupPage) },
    body: new URLSearchParams({
      _csrf: csrfFrom(await setupPage.text()),
      password: PASSWORD,
      confirmPassword: PASSWORD,
    }),
  });
  assertEquals(setupResponse.status, 303);

  const loginUrl = new URL(routes.auth.login.index.href(), baseUrl);
  const loginPage = await fetch(loginUrl);
  const loginResponse = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookieFrom(loginPage) },
    body: new URLSearchParams({
      _csrf: csrfFrom(await loginPage.text()),
      password: PASSWORD,
    }),
  });
  assertEquals(loginResponse.status, 303);
  const user = await store.verifyAdministratorPassword(PASSWORD);
  assert(user);
  assert(String(user.userId) !== String(user.workspaceId));
  return { cookie: cookieFrom(loginResponse), userId: user.userId, workspaceId: user.workspaceId };
}

async function enrollRunner(
  store: ReturnType<typeof activate>["workspace"],
  workspaceId: WorkspaceId,
) {
  const enrollment = await store.getRunnerEnrollmentToken(workspaceId);
  const runner = await store.enrollRunner({
    enrollmentPsk: enrollment.token,
    name: "Browser runner",
    architecture: "x64",
  });
  assert(runner);
  return runner;
}

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert(value, "expected a Set-Cookie header");
  return value.split(";", 1)[0]!;
}

function csrfFrom(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert(match, "expected a CSRF form field");
  return match[1]!;
}

function deletionSnapshot(
  sessionId: string,
  projectId: string,
  initialPromptPreview: string,
): SessionView {
  return {
    id: sessionId,
    projectId,
    createdAt: "2026-08-28T12:00:00Z",
    initialPromptPreview,
    model: MODEL,
    initialThinkingLevel: "high",
    orbSize: "medium",
    state: "ready",
    agentState: "idle",
    environmentState: "running",
    environmentReachable: true,
    issues: [],
  };
}

function submitDeletion(
  baseUrl: URL,
  cookie: string,
  sessionId: string,
  csrfToken: string,
): Promise<Response> {
  return fetch(new URL(routes.app.sessions.delete.href({ sessionId }), baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrfToken }),
  });
}

function submitSession(
  baseUrl: URL,
  cookie: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetch(new URL(routes.app.sessions.create.href(), baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ environment: "runner", orbSize: "medium", ...body }),
  });
}

function assertString(source: string, expected: string): void {
  assert(source.includes(expected), `Expected ${JSON.stringify(source)} to include ${expected}.`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the expected test state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Every Session route answers 404 for another Workspace's Session before addressing it. */
async function assertForeignSessionHidden(
  baseUrl: URL,
  cookie: string,
  csrfToken: string,
  sessionId: string,
): Promise<void> {
  const post = (href: string, fields: Record<string, string> = {}) =>
    fetch(new URL(href, baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: cookie },
      body: new URLSearchParams({ _csrf: csrfToken, ...fields }),
    });
  const get = (href: string) =>
    fetch(new URL(href, baseUrl), { redirect: "manual", headers: { Cookie: cookie } });
  const requests: [string, Promise<Response>][] = [
    ["detail", get(routes.app.sessions.detail.href({ sessionId }))],
    ["frame", get(routes.app.sessions.frame.href({ sessionId }))],
    [
      "message",
      post(routes.app.sessions.message.href({ sessionId }), { prompt: "Cross-tenant prompt" }),
    ],
    [
      "thinkingLevel",
      post(routes.app.sessions.thinkingLevel.href({ sessionId }), { thinkingLevel: "low" }),
    ],
    ["abort", post(routes.app.sessions.abort.href({ sessionId }))],
    ["stop", post(routes.app.sessions.stop.href({ sessionId }))],
    [
      "retry",
      post(routes.app.sessions.retry.href({ sessionId }), { recovery: "retry-provisioning" }),
    ],
    ["wake", post(routes.api.sessions.wake.href({ sessionId }))],
    [
      "changes",
      post(routes.api.sessions.changes.href({ sessionId }), { action: "stage", path: "README.md" }),
    ],
    ["gitSnapshot", get(routes.api.sessions.gitSnapshot.href({ sessionId }))],
    [
      "gitPatchChunk",
      get(
        routes.api.sessions.gitPatchChunk.href({
          sessionId,
          snapshotId: GIT_SNAPSHOT_ID,
          section: "staged",
          offset: "0",
        }),
      ),
    ],
    ["artifact", get(routes.api.sessions.artifact.href({ sessionId, artifactId: ARTIFACT_ID }))],
    ["events", get(routes.api.sessions.events.href({ sessionId }))],
  ];
  for (const [name, request] of requests) {
    const response = await request;
    await response.body?.cancel();
    assertEquals(response.status, 404, `${name} must not reveal another Workspace's Session`);
  }
}

function createInputs(sessions: BrowserTestSessions): CreateSessionInput[] {
  // SAFETY: the fake records each create call's CreateSessionInput argument.
  return sessions.inputsOf("create") as CreateSessionInput[];
}

function submitInputs(
  sessions: BrowserTestSessions,
  sessionId: string,
): Parameters<SessionApi["submit"]>[0][] {
  // SAFETY: the fake records each submit call's input argument.
  return sessions.inputsOf("submit", sessionId) as Parameters<SessionApi["submit"]>[0][];
}

function assertNoSecrets(source: string): void {
  for (const plaintext of [
    GITHUB_TOKEN,
    MODEL_PROVIDER_KEY,
    OPENAI_PROVIDER_KEY,
    ENVIRONMENT_SECRET_VALUE,
  ]) {
    assertEquals(source.includes(plaintext), false, `${plaintext} must stay in the gateway`);
  }
}

function catalogEntry(
  id: string,
  projectId: string,
  createdAt: string,
  initialPromptPreview: string,
): SessionCatalogEntry {
  return { id, projectId, createdAt, initialPromptPreview };
}
