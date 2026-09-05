import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";

import {
  GitAuthor,
  GitFileUpdateAccepted,
  initialPromptPreview,
  RunnerSessionSnapshot,
  SessionGitSnapshot,
  SessionModelRuntime,
  StopSessionAccepted,
  type UserId,
  WakeSessionAccepted,
  type WatchSessionEvent,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Effect, Schema, Stream } from "effect";
import type {
  AbortSessionInput,
  DeleteSessionInput,
  OperationResult,
  PromptSessionInput,
  ProvisionSessionInput,
  RunnerLiveState,
  RunnerRegistryService,
  StopSessionInput,
  UpdateSessionGitFileInput,
  WakeSessionInput,
} from "@/app/runner-registry.ts";
import { createAppServices } from "@/app/middleware/services.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import { createTestServer } from "@/test/http-test-server.ts";
import { createTestStore, createTestWorkspace } from "@/test/postgres-test.ts";

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
const GIT_AUTHOR = {
  authorName: "Browser Provisioning User",
  authorEmail: "browser-provisioning@example.com",
};
const INITIAL_PROMPT = "  Inspect\nthis repository and explain the architecture.  ";

class BrowserTestRunnerConnections implements RunnerRegistryService {
  runnerId = "";
  workspaceId: WorkspaceId | null = null;
  sessionId: string | null = null;
  snapshot: RunnerSessionSnapshot | null = null;
  provisions: ProvisionSessionInput[] = [];
  wakes: WakeSessionInput[] = [];
  prompts: PromptSessionInput[] = [];
  aborts: AbortSessionInput[] = [];
  stops: StopSessionInput[] = [];
  deletions: DeleteSessionInput[] = [];
  gitFileUpdates: UpdateSessionGitFileInput[] = [];
  events: (typeof WatchSessionEvent.Type)[] = [];
  afterCursors: number[] = [];
  subscriptionUnsubscribes = 0;
  beforeAcceptance: ((input: ProvisionSessionInput) => Promise<void>) | undefined = undefined;
  reconcileAcceptance?: (snapshot: RunnerSessionSnapshot) => Promise<void>;
  promptResult: OperationResult<unknown> = { status: "accepted", acknowledgement: {} };
  abortResult: OperationResult<unknown> = { status: "accepted", acknowledgement: {} };
  stopResult: OperationResult<StopSessionAccepted> = {
    status: "accepted",
    acknowledgement: new StopSessionAccepted({}),
  };

  getRunnerLiveState(
    workspaceId: WorkspaceId,
    runnerId: string,
  ): Effect.Effect<RunnerLiveState | null> {
    if (workspaceId !== this.workspaceId || runnerId !== this.runnerId) return Effect.succeed(null);
    return Effect.succeed({
      lastObservedAt: Date.now(),
      capacity: {
        activeSessions: 0,
        vmCpuCount: 4,
        vmMemoryMiB: 8192,
        diskFreeMiB: 20_480,
      },
    });
  }

  getSessionRunner(workspaceId: WorkspaceId, sessionId: string): Effect.Effect<string | null> {
    return Effect.succeed(
      workspaceId === this.workspaceId && sessionId === this.sessionId ? this.runnerId : null,
    );
  }

  getSessionSnapshot(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Effect.Effect<RunnerSessionSnapshot | null> {
    return Effect.succeed(
      workspaceId === this.workspaceId && sessionId === this.sessionId ? this.snapshot : null,
    );
  }

  getSessionGitSnapshot(workspaceId: WorkspaceId, sessionId: string) {
    if (workspaceId !== this.workspaceId || sessionId !== this.sessionId) {
      return Effect.succeed({
        status: "unavailable" as const,
        message: "The pinned runner is offline.",
      });
    }
    return Effect.succeed({
      status: "accepted" as const,
      acknowledgement: new SessionGitSnapshot({
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
      }),
    });
  }

  updateSessionGitFile(input: UpdateSessionGitFileInput) {
    if (input.workspaceId !== this.workspaceId || input.sessionId !== this.sessionId) {
      return Effect.succeed({
        status: "unavailable" as const,
        message: "The pinned runner is offline.",
      });
    }
    this.gitFileUpdates.push(input);
    return Effect.succeed({
      status: "accepted" as const,
      acknowledgement: new GitFileUpdateAccepted({}),
    });
  }

  provisionSession(input: ProvisionSessionInput): Effect.Effect<OperationResult<unknown>> {
    return Effect.promise(async () => {
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

      const snapshot = Schema.decodeUnknownSync(RunnerSessionSnapshot)({
        id: input.sessionId,
        projectId: input.payload.projectId,
        createdAt: "2026-08-17T12:00:00Z",
        initialPromptPreview: initialPromptPreview(input.payload.initialPrompt),
        model: input.payload.modelRuntime.model,
        orbSize: input.payload.orbSize,
        state: "created",
        issues: [],
        lastEventCursor: 0,
      });
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
    });
  }

  wakeSession(input: WakeSessionInput) {
    return Effect.sync(() => {
      this.wakes.push(input);
      return {
        status: "accepted" as const,
        acknowledgement: new WakeSessionAccepted({}),
      };
    });
  }

  promptSession(input: PromptSessionInput): Effect.Effect<OperationResult<unknown>> {
    return Effect.sync(() => {
      this.prompts.push(input);
      return this.promptResult;
    });
  }

  abortSession(input: AbortSessionInput): Effect.Effect<OperationResult<unknown>> {
    return Effect.sync(() => {
      this.aborts.push(input);
      return this.abortResult;
    });
  }

  stopSession(input: StopSessionInput): Effect.Effect<OperationResult<StopSessionAccepted>> {
    return Effect.sync(() => {
      this.stops.push(input);
      return this.stopResult;
    });
  }

  deleteSession(input: DeleteSessionInput): Effect.Effect<void> {
    return Effect.sync(() => {
      if (input.workspaceId === this.workspaceId && input.sessionId === this.sessionId) {
        this.deletions.push(input);
      }
    });
  }

  watchSession(
    workspaceId: WorkspaceId,
    sessionId: string,
    afterCursor: number,
  ): Stream.Stream<typeof WatchSessionEvent.Type, unknown> {
    this.afterCursors.push(afterCursor);
    if (workspaceId !== this.workspaceId || sessionId !== this.sessionId) {
      return Stream.fail(new Error("The pinned runner is offline."));
    }
    const durableCursors = this.events.flatMap((event) => "cursor" in event ? [event.cursor] : []);
    const lastCursor = Math.max(0, ...durableCursors);
    const reset = afterCursor === 0 || afterCursor > lastCursor;
    const resetEvents: (typeof WatchSessionEvent.Type)[] = reset
      ? [{ runId: null, event: { type: "conversation.reset" } }]
      : [];
    return Stream.fromIterable(
      [
        ...resetEvents,
        ...this.events.filter((event) =>
          !("cursor" in event) || reset || event.cursor > afterCursor
        ),
      ],
    )
      .pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(Effect.sync(() => {
          this.subscriptionUnsubscribes += 1;
        })),
      );
  }

  disconnectRunner(): Effect.Effect<boolean> {
    return Effect.succeed(false);
  }
}

Deno.test("browser form waits for runner acceptance before cataloging and keeps token memory-only", async () => {
  const store = await createTestStore();
  const connections = new BrowserTestRunnerConnections();
  const router = createAppRouter(createAppServices(store, connections));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    connections.workspaceId = client.workspaceId;
    const projectResult = await store.saveProject(client.workspaceId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    });
    assert(projectResult.status === "saved");
    await store.saveGitHubCredential(client.workspaceId, GITHUB_TOKEN);
    await store.saveGitAuthorConfiguration(client.userId, GIT_AUTHOR);
    await store.saveModelProviderCredential(client.workspaceId, PROVIDER_ID, MODEL_PROVIDER_KEY);
    const enrolled = await enrollRunner(store, client.workspaceId);
    connections.runnerId = enrolled.runnerId;
    connections.beforeAcceptance = async (input) => {
      const count = await store.pool.query<{ count: number }>(
        "select count(*)::integer as count from sessions where workspace_id = $1 and id = $2",
        [client.workspaceId, input.sessionId],
      );
      assertEquals(count.rows[0]?.count, 0);
    };
    connections.reconcileAcceptance = async (snapshot) => {
      const [reconciled] = await store.reconcileSessionManifestEntries(client.workspaceId, [
        snapshot,
      ]);
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
    assertMatch(createHtml, /<input[^>]*type="hidden"[^>]*name="sessionId"[^>]*value=""/);
    assertMatch(createHtml, /<input[^>]*type="hidden"[^>]*name="runnerId"[^>]*value=""/);
    assertMatch(createHtml, /aria-label="Orb size"/);
    assertMatch(createHtml, /aria-keyshortcuts="Enter"/);
    assertMatch(createHtml, /deepseek-v4-flash/);
    assertNotMatch(createHtml, /name="apiKey"/);
    const projectControl = createHtml.indexOf('name="projectId"');
    const orbControl = createHtml.indexOf('name="orbSize"');
    const modelControl = createHtml.indexOf('aria-label="Model"');
    assert(projectControl !== -1 && projectControl < orbControl && orbControl < modelControl);
    assert(!createHtml.includes(GITHUB_TOKEN));
    assert(!createHtml.includes(MODEL_PROVIDER_KEY));

    const composerSessionId = crypto.randomUUID();
    const response = await fetch(new URL(routes.app.sessions.create.href(), server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(createHtml),
        sessionId: composerSessionId,
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
    assertEquals(location, routes.app.sessions.detail.href({ sessionId: composerSessionId }));

    const provision = connections.provisions[0];
    assert(provision?.payload.mode === "create");
    assertEquals(provision.sessionId, composerSessionId);
    assertEquals(provision.runnerId, connections.runnerId);
    assertEquals(provision.payload.githubToken, GITHUB_TOKEN);
    assertEquals(
      provision.payload.gitAuthor,
      new GitAuthor({
        name: GIT_AUTHOR.authorName,
        email: GIT_AUTHOR.authorEmail,
      }),
    );
    assertEquals(provision.payload.initialPrompt, INITIAL_PROMPT);
    assertEquals(provision.payload.orbSize, "small");
    assertEquals(
      provision.payload.modelRuntime,
      new SessionModelRuntime({
        model: MODEL,
        thinkingLevel: "high",
        credential: { type: "api_key", value: MODEL_PROVIDER_KEY },
      }),
    );
    const catalog = await store.pool.query<{
      workspace_id: string;
      id: string;
      project_id: string;
      created_at: string;
      initial_prompt_preview: string;
    }>("select * from sessions where workspace_id = $1", [client.workspaceId]);
    assertEquals(catalog.rows, [{
      workspace_id: client.workspaceId,
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
    const [additionalCatalog] = await store.reconcileSessionManifestEntries(client.workspaceId, [
      Schema.decodeUnknownSync(RunnerSessionSnapshot)({
        id: olderSessionId,
        projectId: projectResult.project.id,
        createdAt: "2026-08-17T11:00:00Z",
        initialPromptPreview: "Older sidebar session",
        model: MODEL,
        orbSize: "medium",
        state: "ready",
        issues: [],
        lastEventCursor: 1,
      }),
      Schema.decodeUnknownSync(RunnerSessionSnapshot)({
        id: newerSessionId,
        projectId: projectResult.project.id,
        createdAt: "2026-08-17T13:00:00Z",
        initialPromptPreview: "Newer sidebar session",
        model: MODEL,
        orbSize: "medium",
        state: "ready",
        issues: [],
        lastEventCursor: 1,
      }),
    ]);
    assert(additionalCatalog);
    assertEquals(additionalCatalog.acceptedSessionIds, [olderSessionId, newerSessionId]);
    assertEquals(
      (await store.listSessionCatalogEntries(client.workspaceId)).map((session) => session.id),
      [newerSessionId, provision.sessionId, olderSessionId],
    );

    connections.events = [{
      runId: null,
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
    assertMatch(
      detailHtml,
      /<h1[^>]*data-top-bar-title[^>]*>Inspect this repository and explain the architecture\.<\/h1>/,
    );
    assertNotMatch(detailHtml, /aria-label="Breadcrumb"/);
    assertNotMatch(detailHtml, /Session <code>/);
    assertNotMatch(detailHtml, /<span>Repository<\/span>/);
    assertMatch(detailHtml, /\/assets\/app\/ui\/session\/session-detail-client\.tsx/);
    assertMatch(detailHtml, /"exportName":"SessionDetailClient"/);
    assertMatch(
      detailHtml,
      /<link data-rmx(?:-module-preload)? rel="modulepreload" href="\/assets\/app\/ui\/session\/session-detail-client\.tsx" \/>/,
    );
    assertNotMatch(
      detailHtml,
      /<link data-rmx(?:-module-preload)?[^>]+href="\/assets\/app\/ui\/session\/session-changes-panel\.tsx"/,
    );
    assertNotMatch(
      detailHtml,
      /<link data-rmx(?:-module-preload)?[^>]+href="\/assets\/npm\//,
    );
    assertNotMatch(detailHtml, /"exportName":"SessionVmControl"/);
    assertNotMatch(detailHtml, /"exportName":"SessionChangesPanel"/);
    assertMatch(detailHtml, /aria-label="Session changes"/);
    assertMatch(detailHtml, />Changes<\/strong>/);
    assertMatch(
      detailHtml,
      new RegExp(`action="/app/sessions/${provision.sessionId}/messages"`),
    );
    assertMatch(detailHtml, /<textarea[^>]*name="prompt"[^>]*aria-label="Continue session"/);
    assertMatch(detailHtml, /aria-label="Send prompt"/);
    assertMatch(
      detailHtml,
      new RegExp(`action="/app/sessions/${provision.sessionId}/stop"`),
    );
    assertMatch(detailHtml, /aria-label="Gondolin VM: Active"/);
    assertMatch(detailHtml, /aria-label="Stop Gondolin VM"/);
    assertNotMatch(detailHtml, /data-session-toolbar/);
    assertNotMatch(detailHtml, />Abort<\/button>/);
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

    const gitSnapshotHref = routes.api.sessions.gitSnapshot.href({
      sessionId: provision.sessionId,
    });
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

    const wakeHref = routes.api.sessions.wake.href({ sessionId: provision.sessionId });
    const anonymousWake = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
    });
    assertEquals(anonymousWake.status, 401);
    const missingWakeCsrf = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
    });
    assertEquals(missingWakeCsrf.status, 403);
    const woken = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(detailHtml) }),
    });
    assertEquals(woken.status, 202);
    assertEquals(await woken.json(), { status: "accepted" });
    assertEquals(connections.wakes, [{
      workspaceId: client.workspaceId,
      sessionId: provision.sessionId,
      payload: {
        modelRuntime: new SessionModelRuntime({
          model: MODEL,
          thinkingLevel: "high",
          credential: { type: "api_key", value: MODEL_PROVIDER_KEY },
        }),
        githubToken: GITHUB_TOKEN,
      },
    }]);

    const changesHref = routes.api.sessions.changes.href({ sessionId: provision.sessionId });
    const anonymousChange = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ action: "stage", path: "README.md" }),
    });
    assertEquals(anonymousChange.status, 401);
    const missingChangeCsrf = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ action: "stage", path: "README.md" }),
    });
    assertEquals(missingChangeCsrf.status, 403);
    const missingSessionChange = await fetch(
      new URL(routes.api.sessions.changes.href({ sessionId: crypto.randomUUID() }), server.baseUrl),
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
    assertEquals(connections.gitFileUpdates, []);

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
    assertEquals(stagedChange.status, 204);
    assertEquals(stagedChange.headers.get("cache-control"), "no-store");
    assertEquals(await stagedChange.text(), "");
    const unstagedChange = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml),
        action: "unstage",
        path: exactPath,
      }),
    });
    assertEquals(unstagedChange.status, 204);
    assertEquals(await unstagedChange.text(), "");
    assertEquals(connections.gitFileUpdates, [
      {
        workspaceId: client.workspaceId,
        sessionId: provision.sessionId,
        action: "stage",
        path: exactPath,
        previousPath: exactPreviousPath,
      },
      {
        workspaceId: client.workspaceId,
        sessionId: provision.sessionId,
        action: "unstage",
        path: exactPath,
      },
    ]);

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
      client.workspaceId,
      PROVIDER_ID,
      CONTINUATION_MODEL_PROVIDER_KEY,
    );
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
    assertEquals(connections.prompts, [{
      workspaceId: client.workspaceId,
      sessionId: provision.sessionId,
      payload: {
        prompt: "Commit the reviewed changes and push the session branch.",
        modelRuntime: new SessionModelRuntime({
          model: MODEL,
          thinkingLevel: "high",
          credential: { type: "api_key", value: CONTINUATION_MODEL_PROVIDER_KEY },
        }),
        githubToken: GITHUB_TOKEN,
      },
    }]);

    const stopHref = routes.app.sessions.stop.href({ sessionId: provision.sessionId });
    const missingStopCsrf = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
    });
    assertEquals(missingStopCsrf.status, 403);
    assertEquals(connections.stops, []);
    const stopped = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(detailHtml) }),
    });
    assertEquals(stopped.status, 202);
    assertEquals(await stopped.json(), { status: "accepted" });
    assertEquals(connections.stops, [{
      workspaceId: client.workspaceId,
      sessionId: provision.sessionId,
    }]);

    connections.snapshot = { ...connections.snapshot, state: "stopped" };
    const stoppedDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const stoppedHtml = await stoppedDetail.text();
    assertNotMatch(stoppedHtml, /data-session-stopped/);
    assertMatch(stoppedHtml, /aria-label="Continue session"/);
    assertMatch(stoppedHtml, /aria-label="Gondolin VM: Sleeping"/);
    assertMatch(stoppedHtml, /aria-label="Start Gondolin VM"/);
    assertNotMatch(stoppedHtml, /aria-label="Stop Gondolin VM"/);
    const coldWake = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(stoppedHtml) }),
    });
    assertEquals(coldWake.status, 202);
    assertEquals(await coldWake.json(), { status: "accepted" });
    assertEquals(connections.wakes[1], {
      workspaceId: client.workspaceId,
      sessionId: provision.sessionId,
      payload: {
        modelRuntime: new SessionModelRuntime({
          model: MODEL,
          thinkingLevel: "high",
          credential: { type: "api_key", value: CONTINUATION_MODEL_PROVIDER_KEY },
        }),
        githubToken: GITHUB_TOKEN,
      },
    });
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
    assertEquals(connections.prompts[1], {
      workspaceId: client.workspaceId,
      sessionId: provision.sessionId,
      payload: {
        prompt: "Resume this stopped session",
        modelRuntime: new SessionModelRuntime({
          model: MODEL,
          thinkingLevel: "high",
          credential: { type: "api_key", value: CONTINUATION_MODEL_PROVIDER_KEY },
        }),
        githubToken: GITHUB_TOKEN,
      },
    });

    connections.snapshot = { ...connections.snapshot, state: "running" };
    const runningDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const runningHtml = await runningDetail.text();
    assertMatch(
      runningHtml,
      new RegExp(`action="/app/sessions/${provision.sessionId}/abort"`),
    );
    assertMatch(
      runningHtml,
      new RegExp(`form="session-${provision.sessionId}-abort"`),
    );
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
    assertNotMatch(runningHtml, /aria-label="Send prompt"/);
    assertNotMatch(runningHtml, />Abort<\/button>/);
    const busyStop = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(runningHtml) }),
    });
    assertEquals(busyStop.status, 409);
    assertMatch(await busyStop.text(), /Abort the active Pi run before stopping/);
    assertEquals(connections.stops.length, 1);
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
    assertEquals(connections.prompts.length, 3);
    assertEquals(connections.prompts[2]?.payload.prompt, "Queue this follow-up");
    assertEquals(connections.prompts[2]?.payload.githubToken, GITHUB_TOKEN);

    const abortHref = routes.app.sessions.abort.href({ sessionId: provision.sessionId });
    const missingAbortCsrf = await fetch(new URL(abortHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
    });
    assertEquals(missingAbortCsrf.status, 403);
    assertEquals(connections.aborts, []);

    const aborted = await fetch(new URL(abortHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(runningHtml) }),
    });
    assertEquals(aborted.status, 202);
    assertEquals(await aborted.json(), { status: "accepted" });
    assertEquals(connections.aborts, [{
      workspaceId: client.workspaceId,
      sessionId: provision.sessionId,
    }]);

    connections.snapshot = { ...connections.snapshot, state: "ready" };
    const staleAbort = await fetch(new URL(abortHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(runningHtml) }),
    });
    assertEquals(staleAbort.status, 409);
    assertMatch(await staleAbort.text(), /no active Pi run to abort/);
    assertEquals(connections.aborts.length, 1);

    connections.sessionId = null;
    const offlineDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    assertEquals(offlineDetail.status, 200);
    const offlineHtml = await offlineDetail.text();
    assertStringIncludes(
      offlineHtml,
      "Conversation history is unavailable while the pinned runner is offline.",
    );
    assertMatch(offlineHtml, /data-runner-disconnected/);
    assertMatch(offlineHtml, /aria-label="Gondolin VM: Offline"/);
    assertMatch(
      offlineHtml,
      /<textarea(?=[^>]*aria-label="Continue session")(?![^>]*disabled)[^>]*>/,
    );
    assertMatch(
      offlineHtml,
      /<button(?=[^>]*aria-label="Send prompt")(?=[^>]*disabled)[^>]*>/,
    );
    assertNotMatch(offlineHtml, /openorb\/browser-test/);
    assertNotMatch(offlineHtml, /0123456789abcdef0123456789abcdef01234567/);

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
    assertEquals(await offlineContinuation.json(), { error: "The pinned runner is offline." });
    assertEquals(connections.prompts.length, 3);
    const offlineAbort = await fetch(new URL(abortHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(runningHtml) }),
    });
    assertEquals(offlineAbort.status, 503);
    assertMatch(await offlineAbort.text(), /pinned runner is offline/);
    assertEquals(connections.aborts.length, 1);
    const offlineStop = await fetch(new URL(stopHref, server.baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(offlineHtml) }),
    });
    assertEquals(offlineStop.status, 503);
    assertEquals(await offlineStop.json(), { error: "The pinned runner is offline." });
    assertEquals(connections.stops.length, 1);
    const offlineWake = await fetch(new URL(wakeHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({ _csrf: csrfFrom(offlineHtml) }),
    });
    assertEquals(offlineWake.status, 503);
    assertEquals(await offlineWake.json(), { error: "The pinned runner is offline." });
    assertEquals(connections.wakes.length, 2);
    const offlineGitSnapshot = await fetch(new URL(gitSnapshotHref, server.baseUrl), {
      headers: { Accept: "application/json", Cookie: client.cookie },
    });
    assertEquals(offlineGitSnapshot.status, 503);
    assertEquals(offlineGitSnapshot.headers.get("cache-control"), "no-store");
    const offlineGitFileUpdate = await fetch(new URL(changesHref, server.baseUrl), {
      method: "POST",
      headers: { Accept: "application/json", Cookie: client.cookie },
      body: new URLSearchParams({
        _csrf: csrfFrom(offlineHtml),
        action: "stage",
        path: "README.md",
      }),
    });
    assertEquals(offlineGitFileUpdate.status, 503);
    assertEquals(await offlineGitFileUpdate.json(), {
      error: "The pinned runner is offline.",
    });
    assertEquals(connections.gitFileUpdates.length, 2);
    connections.sessionId = provision.sessionId;

    connections.beforeAcceptance = undefined;
    assert(connections.snapshot);
    connections.snapshot = {
      ...connections.snapshot,
      state: "error",
      issues: [{
        category: "vm-start",
        severity: "failure",
        message: "The Gondolin VM could not be started.",
        diagnostics: "qemu exited safely",
        recovery: "retry-provisioning",
      }],
    };
    const failedDetail = await fetch(new URL(location, server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const failedHtml = await failedDetail.text();
    assertMatch(failedHtml, /data-session-issue="vm-start"/);
    assertMatch(failedHtml, /data-session-issue-diagnostics/);
    assertStringIncludes(failedHtml, "qemu exited safely");
    assertMatch(failedHtml, /name="recovery" value="retry-provisioning"/);
    await store.saveModelProviderCredential(
      client.workspaceId,
      PROVIDER_ID,
      RETRY_MODEL_PROVIDER_KEY,
    );
    const staleRetryResponse = await fetch(
      new URL(routes.app.sessions.retry.href({ sessionId: provision.sessionId }), server.baseUrl),
      {
        method: "POST",
        redirect: "manual",
        headers: { Cookie: client.cookie },
        body: new URLSearchParams({
          _csrf: csrfFrom(failedHtml),
          recovery: "start-clean-vm",
        }),
      },
    );
    assertEquals(staleRetryResponse.status, 409);
    assertMatch(await staleRetryResponse.text(), /offered recovery action changed/i);
    assertEquals(connections.provisions.length, 1);
    const retryResponse = await fetch(
      new URL(routes.app.sessions.retry.href({ sessionId: provision.sessionId }), server.baseUrl),
      {
        method: "POST",
        redirect: "manual",
        headers: { Cookie: client.cookie },
        body: new URLSearchParams({
          _csrf: csrfFrom(failedHtml),
          recovery: "retry-provisioning",
        }),
      },
    );
    assertEquals(retryResponse.status, 303);
    const retryProvision = connections.provisions[1];
    assertEquals(retryProvision?.sessionId, provision.sessionId);
    assertEquals(retryProvision?.payload.mode, "retry");
    assertEquals(
      retryProvision?.payload.mode === "retry" ? retryProvision.payload.modelRuntime : undefined,
      new SessionModelRuntime({
        ...provision.payload.modelRuntime,
        credential: { type: "api_key", value: RETRY_MODEL_PROVIDER_KEY },
      }),
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
    assertEquals(offlineEvents.status, 200);
    assertEquals(await offlineEvents.body?.getReader().read(), { value: undefined, done: true });
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
    connections.workspaceId = client.workspaceId;
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
    const otherWorkspaceId = await createTestWorkspace(store);
    const foreignProject = await store.saveProject(otherWorkspaceId, {
      name: "Foreign project",
      repositoryUrl: "https://github.com/openorb/foreign.git",
    });
    assert(foreignProject.status === "saved");
    connections.runnerId = (await enrollRunner(store, client.workspaceId)).runnerId;

    const anonymous = await fetch(new URL(routes.app.index.href(), server.baseUrl));
    assertEquals(anonymous.status, 401);
    const page = await fetch(new URL(routes.app.index.href(), server.baseUrl), {
      headers: { Cookie: client.cookie },
    });
    const html = await page.text();
    assertMatch(html, /DeepSeek V4 Flash/);
    assertMatch(html, /GPT-4\.1/);
    const sessionsIndex = await fetch(
      new URL(routes.app.sessions.index.href(), server.baseUrl),
      { redirect: "manual", headers: { Cookie: client.cookie } },
    );
    assertEquals(sessionsIndex.status, 302);
    assertEquals(sessionsIndex.headers.get("location"), routes.app.index.href());
    const composerSessionId = crypto.randomUUID();
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
      sessionId: composerSessionId,
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
    assertEquals(sessionIdFrom(foreignHtml), composerSessionId);
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

    const missingAuthor = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      projectId: project.project.id,
      model: MODEL,
      ref: "main",
      runnerId: connections.runnerId,
      branchName: "openorb/browser-test",
      initialPrompt: INITIAL_PROMPT,
    });
    assertEquals(missingAuthor.status, 409);
    assertMatch(await missingAuthor.text(), /Configure your Git author name and email/);
    assertEquals(connections.provisions.length, 0);
    await store.saveGitAuthorConfiguration(client.userId, GIT_AUTHOR);

    const alternateProvider = await submitSession(server.baseUrl, client.cookie, {
      _csrf: csrfFrom(html),
      sessionId: composerSessionId,
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
    assertEquals(alternateProvision.sessionId, composerSessionId);
    assertEquals(
      alternateProvision.payload.modelRuntime,
      new SessionModelRuntime({
        model: OPENAI_MODEL,
        thinkingLevel: "high",
        credential: { type: "api_key", value: OPENAI_PROVIDER_KEY },
      }),
    );
    connections.provisions = [];

    assertEquals(await store.deleteModelProviderCredential(client.workspaceId, PROVIDER_ID), {
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

Deno.test("browser deletion confirms, dispatches cleanup, tombstones, and isolates tenants", async () => {
  const store = await createTestStore();
  const connections = new BrowserTestRunnerConnections();
  const router = createAppRouter(createAppServices(store, connections));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const client = await authenticate(server.baseUrl, store);
    connections.workspaceId = client.workspaceId;
    const projectResult = await store.saveProject(client.workspaceId, {
      name: "OpenOrb",
      repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    });
    assert(projectResult.status === "saved");
    await store.saveGitAuthorConfiguration(client.userId, GIT_AUTHOR);
    await store.saveModelProviderCredential(client.workspaceId, PROVIDER_ID, MODEL_PROVIDER_KEY);
    const enrolled = await enrollRunner(store, client.workspaceId);
    connections.runnerId = enrolled.runnerId;

    const onlineSession = deletionSnapshot(
      crypto.randomUUID(),
      projectResult.project.id,
      "Delete this online session",
    );
    const [onlineReconciled] = await store.reconcileSessionManifestEntries(client.workspaceId, [
      onlineSession,
    ]);
    assert(onlineReconciled);
    assertEquals(onlineReconciled.acceptedSessionIds, [onlineSession.id]);
    connections.sessionId = onlineSession.id;
    connections.snapshot = onlineSession;

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
    assertEquals(connections.deletions, []);

    const deleted = await submitDeletion(
      server.baseUrl,
      client.cookie,
      onlineSession.id,
      csrfToken,
    );
    assertEquals(deleted.status, 303);
    assertEquals(deleted.headers.get("location"), routes.app.index.href());
    assertEquals(await store.getSessionCatalogEntry(client.workspaceId, onlineSession.id), null);
    assertEquals(connections.deletions, [
      { workspaceId: client.workspaceId, sessionId: onlineSession.id },
    ]);

    const offlineSession = deletionSnapshot(
      crypto.randomUUID(),
      projectResult.project.id,
      "Delete this lost runner session",
    );
    const [offlineReconciled] = await store.reconcileSessionManifestEntries(client.workspaceId, [
      offlineSession,
    ]);
    assert(offlineReconciled);
    assertEquals(await store.revokeRunner(client.workspaceId, enrolled.runnerId), "revoked");
    connections.sessionId = null;
    connections.snapshot = null;
    const offlineDeleted = await submitDeletion(
      server.baseUrl,
      client.cookie,
      offlineSession.id,
      csrfToken,
    );
    assertEquals(offlineDeleted.status, 303);
    assertEquals(await store.getSessionCatalogEntry(client.workspaceId, offlineSession.id), null);
    assertEquals(connections.deletions.length, 1);

    const otherWorkspaceId = await createTestWorkspace(store);
    const otherProject = await store.saveProject(otherWorkspaceId, {
      name: "Other Workspace project",
      repositoryUrl: "https://github.com/meln1k/other-project.git",
    });
    assert(otherProject.status === "saved");
    const foreignSession = deletionSnapshot(
      crypto.randomUUID(),
      otherProject.project.id,
      "Foreign session",
    );
    const [foreignReconciled] = await store.reconcileSessionManifestEntries(otherWorkspaceId, [
      foreignSession,
    ]);
    assert(foreignReconciled);
    const deletionCount = connections.deletions.length;
    const foreignDelete = await submitDeletion(
      server.baseUrl,
      client.cookie,
      foreignSession.id,
      csrfToken,
    );
    assertEquals(foreignDelete.status, 404);
    assert(await store.getSessionCatalogEntry(otherWorkspaceId, foreignSession.id));
    assertEquals(connections.deletions.length, deletionCount);

    const sameIdForOtherWorkspace = deletionSnapshot(
      onlineSession.id,
      otherProject.project.id,
      "Same ID in another Workspace",
    );
    const [sameIdReconciled] = await store.reconcileSessionManifestEntries(otherWorkspaceId, [
      sameIdForOtherWorkspace,
    ]);
    assert(sameIdReconciled);
    assertEquals(sameIdReconciled.acceptedSessionIds, [onlineSession.id]);
    assert(await store.getSessionCatalogEntry(otherWorkspaceId, onlineSession.id));
    const [staleOwnerSnapshot] = await store.reconcileSessionManifestEntries(client.workspaceId, [
      onlineSession,
    ]);
    assert(staleOwnerSnapshot);
    assertEquals(staleOwnerSnapshot.acceptedSessionIds, []);
    assertEquals(staleOwnerSnapshot.tombstonedSessionIds, [onlineSession.id]);
    assertEquals(await store.getSessionCatalogEntry(client.workspaceId, onlineSession.id), null);

    const markerColumns = await store.pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'deleted_sessions'
        order by ordinal_position`,
    );
    assertEquals(markerColumns.rows.map((row: { column_name: string }) => row.column_name), [
      "workspace_id",
      "session_id",
      "deleted_at",
    ]);
  } finally {
    await server.close();
    await store.close();
  }
});

interface BrowserClient {
  cookie: string;
  userId: UserId;
  workspaceId: WorkspaceId;
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
  assert(String(user.userId) !== String(user.workspaceId));
  return { cookie: cookieFrom(loginResponse), userId: user.userId, workspaceId: user.workspaceId };
}

async function enrollRunner(
  store: Awaited<ReturnType<typeof createTestStore>>,
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

function sessionIdFrom(html: string): string {
  const match = html.match(/name="sessionId" value="([^"]+)"/);
  assert(match, "expected a session ID form field");
  return match[1]!;
}

function deletionSnapshot(
  sessionId: string,
  projectId: string,
  initialPromptPreview: string,
): RunnerSessionSnapshot {
  return Schema.decodeUnknownSync(RunnerSessionSnapshot)({
    id: sessionId,
    projectId,
    createdAt: "2026-08-28T12:00:00Z",
    initialPromptPreview,
    model: MODEL,
    orbSize: "medium",
    state: "ready",
    issues: [],
    lastEventCursor: 1,
  });
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
    body: new URLSearchParams({ sessionId: crypto.randomUUID(), orbSize: "medium", ...body }),
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
