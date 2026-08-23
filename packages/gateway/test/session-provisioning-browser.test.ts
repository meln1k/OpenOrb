import { assert, assertEquals, assertMatch, assertNotMatch } from "@std/assert";

import {
  initialPromptPreview,
  type RunnerSessionSnapshot,
  type SessionEventPayload,
} from "@openorb/protocol";
import type {
  PromptSessionInput,
  PromptSessionResult,
  ProvisionSessionInput,
  ProvisionSessionResult,
  RunnerConnectionRegistry,
  RunnerLiveState,
  SessionEventSubscription,
} from "@/app/runner-connection-gateway.ts";
import { createAppServices } from "@/app/middleware/services.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import { createTestServer } from "@/test/http-test-server.ts";
import { createTestStore, createTestUser } from "@/test/postgres-test.ts";

const PASSWORD = "[REDACTED:password] horse battery staple";
const GITHUB_TOKEN = "browser-provisioning-github-token";
const MODEL_PROVIDER_KEY = "browser-provisioning-model-key";
const CONTINUATION_MODEL_PROVIDER_KEY = "browser-continuation-model-key";
const RETRY_MODEL_PROVIDER_KEY = "browser-provisioning-retry-model-key";
const PROVIDER_ID = "opencode-go";
const MODEL = `${PROVIDER_ID}/deepseek-v4-flash`;
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_MODEL = `${OPENAI_PROVIDER_ID}/gpt-4.1`;
const OPENAI_PROVIDER_KEY = "browser-provisioning-openai-key";
const INITIAL_PROMPT = "  Inspect\nthis repository and explain the architecture.  ";

class BrowserTestRunnerConnections implements RunnerConnectionRegistry {
  runnerId = "";
  userId = "";
  sessionId: string | null = null;
  snapshot: RunnerSessionSnapshot | null = null;
  provisions: ProvisionSessionInput[] = [];
  prompts: PromptSessionInput[] = [];
  events: SessionEventPayload[] = [];
  afterCursors: number[] = [];
  subscriptionUnsubscribes = 0;
  beforeAcceptance?: (input: ProvisionSessionInput) => Promise<void>;
  reconcileAcceptance?: (snapshot: RunnerSessionSnapshot) => Promise<void>;
  promptResult: PromptSessionResult = { status: "accepted" };

  getRunnerLiveState(userId: string, runnerId: string): RunnerLiveState | null {
    if (userId !== this.userId || runnerId !== this.runnerId) return null;
    return {
      lastHeartbeatAt: Date.now(),
      capacity: {
        maxConcurrentSessions: 2,
        activeSessions: 0,
        vmCpuCount: 4,
        vmMemoryMiB: 8192,
        diskFreeMiB: 20_480,
      },
    };
  }

  getSessionRunner(userId: string, sessionId: string): string | null {
    return userId === this.userId && sessionId === this.sessionId ? this.runnerId : null;
  }

  getSessionSnapshot(userId: string, sessionId: string): RunnerSessionSnapshot | null {
    return userId === this.userId && sessionId === this.sessionId ? this.snapshot : null;
  }

  async provisionSession(input: ProvisionSessionInput): Promise<ProvisionSessionResult> {
    this.provisions.push(input);
    await this.beforeAcceptance?.(input);
    if (input.payload.mode === "retry") {
      assert(this.snapshot);
      this.snapshot = { ...this.snapshot, state: "created" };
      return {
        status: "accepted",
        acknowledgement: {
          session: this.snapshot,
          ref: "main",
          branchName: "openorb/browser-test",
          checkoutState: "available",
        },
      };
    }

    const snapshot: RunnerSessionSnapshot = {
      id: input.sessionId,
      projectId: input.payload.projectId,
      createdAt: "2026-08-17T12:00:00Z",
      initialPromptPreview: initialPromptPreview(input.payload.initialPrompt),
      model: input.payload.modelRuntime.model,
      orbSize: input.payload.orbSize,
      state: "created",
      lastEventCursor: 0,
    };
    await this.reconcileAcceptance?.(snapshot);
    this.sessionId = input.sessionId;
    this.snapshot = snapshot;
    return {
      status: "accepted",
      acknowledgement: {
        session: snapshot,
        ref: input.payload.ref,
        branchName: input.payload.branchName,
        checkoutState: "pending",
      },
    };
  }

  promptSession(input: PromptSessionInput): Promise<PromptSessionResult> {
    this.prompts.push(input);
    return Promise.resolve(this.promptResult);
  }

  subscribeToSessionEvents(
    userId: string,
    sessionId: string,
    afterCursor: number,
    listener: (event: SessionEventPayload) => void,
  ): SessionEventSubscription {
    const abort = new AbortController();
    this.afterCursors.push(afterCursor);
    return {
      replay: Promise.resolve().then(() => {
        if (userId !== this.userId || sessionId !== this.sessionId) return;
        const lastCursor = this.events.reduce(
          (cursor, event) => "cursor" in event ? Math.max(cursor, event.cursor) : cursor,
          0,
        );
        const reset = afterCursor === 0 || afterCursor > lastCursor;
        if (reset) listener({ event: { type: "conversation.reset" } });
        for (const event of this.events) {
          if (reset || !("cursor" in event) || event.cursor > afterCursor) listener(event);
        }
      }),
      signal: abort.signal,
      unsubscribe: () => {
        this.subscriptionUnsubscribes += 1;
        abort.abort();
      },
    };
  }

  disconnectRunner(): boolean {
    return false;
  }
}

Deno.test("browser form waits for runner acceptance before cataloging and keeps token memory-only", async () => {
  const store = await createTestStore();
  const connections = new BrowserTestRunnerConnections();
  const router = createAppRouter(createAppServices(store, connections));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    connections.userId = client.userId;
    const projectResult = await store.saveProject(client.userId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/meln1k/openorb.git",
    });
    assert(projectResult.status === "saved");
    await store.saveGitHubCredential(client.userId, GITHUB_TOKEN);
    await store.saveModelProviderCredential(client.userId, PROVIDER_ID, MODEL_PROVIDER_KEY);
    const enrolled = await enrollRunner(store, client.userId);
    connections.runnerId = enrolled.runnerId;
    connections.beforeAcceptance = async (input) => {
      const count = await store.pool.query<{ count: number }>(
        "select count(*)::integer as count from sessions where user_id = $1 and id = $2",
        [client.userId, input.sessionId],
      );
      assertEquals(count.rows[0]?.count, 0);
    };
    connections.reconcileAcceptance = async (snapshot) => {
      const [reconciled] = await store.reconcileSessionManifestEntries(client.userId, [snapshot]);
      assert(reconciled);
      assertEquals(reconciled.acceptedSessionIds, [snapshot.id]);
    };

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
    assertMatch(createHtml, /Write prompt…/);
    assertMatch(createHtml, /tiny · 1 CPU · 2 GB memory/);
    assertMatch(createHtml, /small · 2 CPUs · 4 GB memory/);
    assertMatch(
      createHtml,
      /<option[^>]*value="medium"[^>]*selected[^>]*>medium · 4 CPUs · 8 GB memory<\/option>/,
    );
    assertMatch(createHtml, /large · 8 CPUs · 16 GB memory/);
    assertMatch(createHtml, /xxlarge · 16 CPUs · 32 GB memory/);
    assertNotMatch(createHtml, /aria-label="Runner"/);
    assertMatch(createHtml, /<input[^>]*type="hidden"[^>]*name="runnerId"[^>]*value=""/);
    assertMatch(createHtml, /aria-label="Orb size"/);
    assertMatch(createHtml, /deepseek-v4-flash/);
    assertNotMatch(createHtml, /name="apiKey"/);
    const projectControl = createHtml.indexOf('name="projectId"');
    const orbControl = createHtml.indexOf('name="orbSize"');
    const modelControl = createHtml.indexOf('aria-label="Model"');
    assert(projectControl !== -1 && projectControl < orbControl && orbControl < modelControl);
    assert(!createHtml.includes(GITHUB_TOKEN));
    assert(!createHtml.includes(MODEL_PROVIDER_KEY));

    const response = await fetch(new URL(routes.app.sessions.create.href(), server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(createHtml),
        projectId: projectResult.project.id,
        model: MODEL,
        ref: "main",
        runnerId: "",
        orbSize: "small",
        branchName: "openorb/browser-test",
        initialPrompt: INITIAL_PROMPT,
      }),
    });
    assertEquals(response.status, 303);
    const location = response.headers.get("location");
    assert(location);
    assertMatch(location, /^\/app\/sessions\/[0-9a-f-]+$/);

    const provision = connections.provisions[0];
    assert(provision?.payload.mode === "create");
    assertEquals(provision.runnerId, connections.runnerId);
    assertEquals(provision.payload.githubToken, GITHUB_TOKEN);
    assertEquals(provision.payload.initialPrompt, INITIAL_PROMPT);
    assertEquals(provision.payload.orbSize, "small");
    assertEquals(provision.payload.modelRuntime, {
      model: MODEL,
      thinkingLevel: "high",
      credential: { type: "api_key", value: MODEL_PROVIDER_KEY },
    });
    const catalog = await store.pool.query<{
      user_id: string;
      id: string;
      project_id: string;
      created_at: string;
      initial_prompt_preview: string;
    }>("select * from sessions where user_id = $1", [client.userId]);
    assertEquals(catalog.rows, [{
      user_id: client.userId,
      id: provision.sessionId,
      project_id: projectResult.project.id,
      created_at: "2026-08-17T12:00:00Z",
      initial_prompt_preview: "Inspect this repository and explain the architecture.",
    }]);
    const storedSecrets = await store.pool.query<{ ciphertext: string }>(
      "select ciphertext from encrypted_secrets",
    );
    assertEquals(storedSecrets.rows.length, 2);
    assert(
      storedSecrets.rows.every((row: { ciphertext: string }) =>
        !row.ciphertext.includes(GITHUB_TOKEN)
      ),
    );
    assert(
      storedSecrets.rows.every((row: { ciphertext: string }) =>
        !row.ciphertext.includes(MODEL_PROVIDER_KEY)
      ),
    );

    const olderSessionId = crypto.randomUUID();
    const newerSessionId = crypto.randomUUID();
    const [additionalCatalog] = await store.reconcileSessionManifestEntries(client.userId, [
      {
        id: olderSessionId,
        projectId: projectResult.project.id,
        createdAt: "2026-08-17T11:00:00Z",
        initialPromptPreview: "Older sidebar session",
        model: MODEL,
        orbSize: "medium",
        state: "ready",
        lastEventCursor: 1,
      },
      {
        id: newerSessionId,
        projectId: projectResult.project.id,
        createdAt: "2026-08-17T13:00:00Z",
        initialPromptPreview: "Newer sidebar session",
        model: MODEL,
        orbSize: "medium",
        state: "ready",
        lastEventCursor: 1,
      },
    ]);
    assert(additionalCatalog);
    assertEquals(additionalCatalog.acceptedSessionIds, [olderSessionId, newerSessionId]);
    assertEquals(
      (await store.listSessionCatalogEntries(client.userId)).map((session) => session.id),
      [newerSessionId, provision.sessionId, olderSessionId],
    );

    connections.events = [{
      cursor: 1,
      event: { type: "user.message", messageId: "pi:user:1", text: INITIAL_PROMPT },
    }];
    assert(connections.snapshot);
    connections.snapshot = { ...connections.snapshot, state: "ready" };
    const detail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    assertEquals(detail.status, 200);
    const detailHtml = await detail.text();
    assertMatch(detailHtml, /title="Context window use"/);
    assertMatch(detailHtml, /\?\/1\.0M/);
    assertNotMatch(detailHtml, /Session <code>/);
    assertNotMatch(detailHtml, /<span>Repository<\/span>/);
    assertMatch(detailHtml, new RegExp(`/api/sessions/${provision.sessionId}/events`));
    assertMatch(detailHtml, /\/assets\/app\/ui\/session\/session-event-view\.tsx/);
    assertMatch(
      detailHtml,
      new RegExp(`action="/app/sessions/${provision.sessionId}/messages"`),
    );
    assertMatch(detailHtml, /<textarea[^>]*name="prompt"[^>]*aria-label="Continue session"/);
    assertMatch(detailHtml, /aria-label="Send prompt"/);
    assertNotMatch(detailHtml, /data-session-events/);
    assert(!detailHtml.includes(GITHUB_TOKEN));
    assert(!detailHtml.includes(MODEL_PROVIDER_KEY));
    assertNotMatch(detailHtml, /<a href="\/app\/"[^>]*>[\s\S]*?Overview[\s\S]*?<\/a>/);
    assertNotMatch(
      detailHtml,
      /<a href="\/app\/sessions"[^>]*>[\s\S]*?<span[^>]*>Sessions<\/span>[\s\S]*?<\/a>/,
    );
    const newerSidebarLink = detailHtml.indexOf(
      routes.app.sessions.detail.href({ sessionId: newerSessionId }),
    );
    const currentSidebarLink = detailHtml.indexOf(
      routes.app.sessions.detail.href({ sessionId: provision.sessionId }),
    );
    const olderSidebarLink = detailHtml.indexOf(
      routes.app.sessions.detail.href({ sessionId: olderSessionId }),
    );
    const projectsLink = detailHtml.indexOf(routes.app.projects.index.href(), olderSidebarLink);
    assert(
      newerSidebarLink !== -1 && newerSidebarLink < currentSidebarLink &&
        currentSidebarLink < olderSidebarLink,
    );
    assert(projectsLink > olderSidebarLink);

    const messageHref = routes.app.sessions.message.href({ sessionId: provision.sessionId });
    const missingMessageCsrf = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ prompt: "Continue without CSRF" }),
    });
    assertEquals(missingMessageCsrf.status, 403);
    assertEquals(connections.prompts, []);

    await store.saveModelProviderCredential(
      client.userId,
      PROVIDER_ID,
      CONTINUATION_MODEL_PROVIDER_KEY,
    );
    const continued = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        prompt: "Implement the next step",
      }),
    });
    assertEquals(continued.status, 303);
    assertEquals(continued.headers.get("location"), location);
    assertEquals(connections.prompts, [{
      userId: client.userId,
      sessionId: provision.sessionId,
      payload: {
        prompt: "Implement the next step",
        modelRuntime: {
          model: MODEL,
          thinkingLevel: "high",
          credential: { type: "api_key", value: CONTINUATION_MODEL_PROVIDER_KEY },
        },
      },
    }]);

    connections.snapshot = { ...connections.snapshot, state: "running" };
    const busyContinuation = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        prompt: "Do not queue this prompt",
      }),
    });
    assertEquals(busyContinuation.status, 409);
    assertMatch(await busyContinuation.text(), /session is not ready and idle/);
    assertEquals(connections.prompts.length, 1);

    connections.sessionId = null;
    const offlineContinuation = await fetch(new URL(messageHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        prompt: "Do not queue this offline prompt",
      }),
    });
    assertEquals(offlineContinuation.status, 503);
    assertMatch(await offlineContinuation.text(), /pinned runner is offline/);
    assertEquals(connections.prompts.length, 1);
    connections.sessionId = provision.sessionId;

    connections.beforeAcceptance = undefined;
    assert(connections.snapshot);
    connections.snapshot = { ...connections.snapshot, state: "error" };
    const failedDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const failedHtml = await failedDetail.text();
    await store.saveModelProviderCredential(
      client.userId,
      PROVIDER_ID,
      RETRY_MODEL_PROVIDER_KEY,
    );
    const retryResponse = await fetch(
      new URL(routes.app.sessions.retry.href({ sessionId: provision.sessionId }), server.baseUrl),
      {
        method: "POST",
        redirect: "manual",
        headers: { Cookie: client.cookie },
        body: new URLSearchParams({ _csrf: csrfFrom(failedHtml) }),
      },
    );
    assertEquals(retryResponse.status, 303);
    const retryProvision = connections.provisions[1];
    assertEquals(retryProvision?.sessionId, provision.sessionId);
    assertEquals(retryProvision?.payload.mode, "retry");
    assertEquals(
      retryProvision?.payload.mode === "retry" ? retryProvision.payload.modelRuntime : undefined,
      {
        ...provision.payload.modelRuntime,
        credential: { type: "api_key", value: RETRY_MODEL_PROVIDER_KEY },
      },
    );

    const abort = new AbortController();
    const eventResponse = await fetch(
      new URL(routes.api.sessions.events.href({ sessionId: provision.sessionId }), server.baseUrl),
      { headers: { Cookie: client.cookie }, signal: abort.signal },
    );
    assertEquals(eventResponse.status, 200);
    const reader = eventResponse.body?.getReader();
    assert(reader);
    let replayText = "";
    while (!replayText.includes("id: 1\nevent: session")) {
      const replayChunk = await reader.read();
      assertEquals(replayChunk.done, false);
      replayText += new TextDecoder().decode(replayChunk.value);
    }
    abort.abort();
    assertString(
      replayText,
      'id:\nevent: session\ndata: {"type":"conversation.reset"}',
    );
    assertString(replayText, "id: 1\nevent: session");
    assertEquals(connections.afterCursors, [0]);
    await waitFor(() => connections.subscriptionUnsubscribes === 1);

    const keepaliveAbort = new AbortController();
    const keepaliveUrl = new URL(
      routes.api.sessions.events.href({ sessionId: provision.sessionId }),
      server.baseUrl,
    );
    const keepaliveResponse = await fetch(keepaliveUrl, {
      headers: { Cookie: client.cookie, "Last-Event-ID": "1" },
      signal: keepaliveAbort.signal,
    });
    const keepaliveReader = keepaliveResponse.body?.getReader();
    assert(keepaliveReader);
    try {
      const keepalive = await Promise.race([
        keepaliveReader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Session SSE keepalive timed out.")), 17_000)
        ),
      ]);
      assertEquals(new TextDecoder().decode(keepalive.value), ": keepalive\n\n");
    } finally {
      keepaliveAbort.abort();
    }
    assertEquals(connections.afterCursors, [0, 1]);
    await waitFor(() => connections.subscriptionUnsubscribes === 2);

    connections.sessionId = null;
    const offlineEvents = await fetch(
      new URL(routes.api.sessions.events.href({ sessionId: provision.sessionId }), server.baseUrl),
      { headers: { Cookie: client.cookie } },
    );
    assertEquals(offlineEvents.status, 503);
  } finally {
    await server.close();
    await store.close();
  }
});

Deno.test("session routes enforce auth, CSRF, project ownership, and runner ownership", async () => {
  const store = await createTestStore();
  const connections = new BrowserTestRunnerConnections();
  const router = createAppRouter(createAppServices(store, connections));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    connections.userId = client.userId;
    const project = await store.saveProject(client.userId, {
      name: "Owner project",
      repositoryUrl: "https://github.com/openorb/owner.git",
    });
    assert(project.status === "saved");
    await store.saveModelProviderCredential(client.userId, PROVIDER_ID, MODEL_PROVIDER_KEY);
    await store.saveModelProviderCredential(
      client.userId,
      OPENAI_PROVIDER_ID,
      OPENAI_PROVIDER_KEY,
    );
    const otherUserId = await createTestUser(store);
    const foreignProject = await store.saveProject(otherUserId, {
      name: "Foreign project",
      repositoryUrl: "https://github.com/openorb/foreign.git",
    });
    assert(foreignProject.status === "saved");
    connections.runnerId = (await enrollRunner(store, client.userId)).runnerId;

    const anonymous = await fetch(new URL(routes.app.index.href(), server.baseUrl));
    assertEquals(anonymous.status, 401);
    const page = await fetch(new URL(routes.app.index.href(), server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const html = await page.text();
    assertMatch(html, /DeepSeek V4 Flash/);
    assertMatch(html, /GPT-4\.1/);
    const unCsrf = await submitSession(server.baseUrl, client.cookie, {
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: connections.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unCsrf.status, 403);

    const foreign = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: foreignProject.project.id,
      model: MODEL,
      ref: "main",
      runnerId: connections.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(foreign.status, 404);
    const foreignHtml = await foreign.text();
    assertMatch(foreignHtml, /<dialog[^>]*id="openorb-new-session"[^>]* open/);
    assertMatch(foreignHtml, /Project is unavailable or does not exist/);
    assertEquals(connections.provisions.length, 0);

    const unsupportedProvider = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: "openai/not-a-pi-model",
      ref: "main",
      runnerId: connections.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unsupportedProvider.status, 400);
    assertMatch(await unsupportedProvider.text(), /selected Pi model is unavailable/);
    assertEquals(connections.provisions.length, 0);

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
    assertEquals(connections.provisions.length, 0);

    const unsupportedOrbSize = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: connections.runnerId,
      orbSize: "large",
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unsupportedOrbSize.status, 409);
    assertMatch(await unsupportedOrbSize.text(), /cannot provision the large orb size/);
    assertEquals(connections.provisions.length, 0);

    const invalidOrbSize = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: connections.runnerId,
      orbSize: "enormous",
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(invalidOrbSize.status, 400);
    assertEquals(connections.provisions.length, 0);

    const alternateProvider = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: OPENAI_MODEL,
      ref: "main",
      runnerId: connections.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(alternateProvider.status, 303);
    const alternateProvision = connections.provisions[0];
    assert(alternateProvision?.payload.mode === "create");
    assertEquals(alternateProvision.payload.modelRuntime, {
      model: OPENAI_MODEL,
      thinkingLevel: "high",
      credential: { type: "api_key", value: OPENAI_PROVIDER_KEY },
    });
    connections.provisions = [];

    assertEquals(await store.deleteModelProviderCredential(client.userId, PROVIDER_ID), {
      status: "deleted",
    });
    const unconfiguredProvider = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: connections.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(unconfiguredProvider.status, 409);
    assertMatch(await unconfiguredProvider.text(), /Configure the selected model provider/);
    assertEquals(connections.provisions.length, 0);
  } finally {
    await server.close();
    await store.close();
  }
});

interface BrowserClient {
  cookie: string;
  userId: string;
}

async function authenticate(
  baseUrl: URL,
  store: Awaited<ReturnType<typeof createTestStore>>,
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
  return { cookie: cookieFrom(loginResponse), userId: user.id };
}

async function enrollRunner(
  store: Awaited<ReturnType<typeof createTestStore>>,
  userId: string,
) {
  const enrollment = await store.getRunnerEnrollmentToken(userId);
  const runner = await store.enrollRunner({
    enrollmentPsk: enrollment.token,
    name: "Browser runner",
    architecture: "x64",
    capabilities: ["heartbeat", "session-provisioning"],
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

function submitSession(
  baseUrl: URL,
  cookie: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetch(new URL(routes.app.sessions.create.href(), baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ orbSize: "medium", ...body }),
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
