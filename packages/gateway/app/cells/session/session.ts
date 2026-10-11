import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { diffRevisions } from "@earendil-works/chord/delta";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { type EntryId, LiveDoc, watchEvents } from "@earendil-works/pi-durable";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  type EnvironmentAction,
  type EnvironmentState,
  GitAuthor,
  initialPromptPreview,
  type OrbSize,
  type RunnerSessionSnapshot,
  type SessionEnvironmentRecoveryMode,
  type SessionEvent,
  type SessionGitFileAction,
  SessionGitSnapshot,
  SessionId,
  type SessionProvisioningStage,
  type ThinkingLevel,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { tryAsync } from "@openorb/result";
import { Schema } from "effect";
import type {
  SessionArtifactMediaType,
  SessionGitPatchSection,
} from "@openorb/protocol/runner-bulk-api";
import type { Env } from "../../env.ts";
import type { EnvironmentNotice } from "../runners/runner-registry.ts";
import type { WorkspaceApi } from "../workspace/api.ts";
import {
  type Agent,
  createAgentModels,
  effectiveThinkingLevel,
  openAgent,
  SessionError,
} from "./agent.ts";
import { type EncodedSessionView, encodeGitSnapshot, encodeSessionView } from "./api.ts";
import { WorkspaceCredentialStore } from "./credentials.ts";
import {
  type AgentEnvironmentProvider,
  type EnvironmentControlResult,
  type EnvironmentProviderKind,
  permittedCredentials,
  resolveEnvironmentProvider,
  type SessionEnvironment,
} from "./environment/provider.ts";
import { type RunnerEnvironmentApi, runnerProvider } from "./environment/runner-provider.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SessionArtifactMediaType as SessionArtifactMediaTypeSchema } from "@openorb/protocol/runner-bulk-api";
import { gatedExecutionEnv } from "./gate.ts";
import { migrateDurableObjectDatabase } from "../migrations.ts";
import { sessionMigrations } from "./migrations.ts";
import {
  discoverRepositorySkills,
  repositorySkillsPrompt,
  shownRepositorySkills,
  SKILLS_PENDING_PROMPT,
} from "./skills.ts";
import {
  asJson,
  ConversationProjection,
  deleteSessionMedia,
  findInlineImage,
  type MediaBucket,
  mediaPrefix,
  publishGuestMedia,
} from "./media.ts";
import { EnvironmentLinks, type SessionWebSocket } from "./link.ts";
import {
  appendIssues,
  clearFailures,
  provisionCheckout,
  ProvisioningFailure,
  type ProvisioningReporter,
  resumeCheckout,
  sessionIssue,
} from "./provisioning.ts";
import {
  gitMutationRevision,
  readGitSnapshot,
  readRecord,
  type SessionRecord,
  sessionSnapshot,
  sessionStage,
  writeGitSnapshot,
  writeRecord,
} from "./record.ts";
import {
  generateGitSnapshot,
  type GitPatchChunk,
  readGitPatchChunk,
  staleGitSnapshot,
  updateGitFile,
} from "./git-snapshot.ts";

export type { SessionWebSocket } from "./link.ts";

const context = BACKGROUND_CONTEXT;
/** Deadman alarm: a crash during startup or an alarm leaves another wake behind. */
const RECOVERY_MS = 30_000;
const IDLE_STOP_MS = 15 * 60_000;
/** Git Snapshot refreshes: debounce tool boundaries, and refresh periodically during a run. */
const GIT_REFRESH_DEBOUNCE_MS = 1_000;
const GIT_REFRESH_INTERVAL_MS = 15_000;
const SKILL_DISCOVERY_TIMEOUT_MS = 10_000;

export interface SessionStorage extends DurableObjectSqliteStorage {
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
  sync(): Promise<void>;
}

export interface SessionContext {
  readonly storage: SessionStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: SessionWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): SessionWebSocket[];
  waitUntil(promise: Promise<unknown>): void;
  setWebSocketAutoResponse?(pair: InstanceType<typeof WebSocketRequestResponsePair>): void;
}

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly projectId: string;
  /** The catalog entry's creation time, so both records agree. */
  readonly createdAt: string;
  /** Provider choices by level; the most specific wins. Absent: the default provider. */
  readonly environmentProvider?: {
    readonly session?: EnvironmentProviderKind;
    readonly project?: EnvironmentProviderKind;
    readonly workspace?: EnvironmentProviderKind;
  };
  /** The Project's Guest Credential Opt-in (ADR 0006). Absent: not opted in. */
  readonly guestCredentialOptIn?: boolean;
  readonly runnerId: string;
  readonly orbSize: OrbSize;
  readonly repositoryUrl: string;
  readonly ref: string;
  readonly branchName: string;
  readonly gitAuthor: { readonly name: string; readonly email: string };
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly initialPrompt: string;
}

export interface SessionView {
  readonly runnerId: string;
  readonly snapshot: RunnerSessionSnapshot;
}

/** Where one transcript media item's bytes are: R2 for published media, Harness State inline. */
export type SessionMedia =
  | {
    readonly kind: "published";
    readonly key: string;
    readonly mediaType: SessionArtifactMediaType;
    readonly byteLength: number;
    readonly fileName: string;
  }
  | {
    readonly kind: "inline";
    readonly mediaType: SessionArtifactMediaType;
    readonly bytes: Uint8Array;
  };

interface GitRefreshState {
  /** The refresh loop, kept alive by waitUntil while it runs. */
  loop: Promise<void> | undefined;
  /** When the next refresh is due, in epoch milliseconds; absent when none is requested. */
  dueAt: number | undefined;
  /** Ends the loop's wait early when a sooner refresh is requested. */
  wake: (() => void) | undefined;
}

interface Runtime {
  readonly environment: SessionEnvironment;
  readonly agent: Agent;
}

/**
 * One Session's agent and project: Pi Durable on this object's SQLite storage, reaching its Agent
 * Environment only through the provider's ExecutionEnv (ADRs 0005 and 0006). Agent work keeps
 * running while the runner is offline; guest tools then fail immediately.
 */
export class Session extends DurableObject<Env> {
  readonly #ctx: SessionContext;
  readonly #workspace: WorkspaceApi;
  readonly #runners: RunnerEnvironmentApi;
  readonly #media: MediaBucket;
  readonly #links: EnvironmentLinks;
  readonly #subscribers = new Set<(event: SessionEvent) => void>();
  #record: SessionRecord | undefined;
  #runtime: Promise<Runtime | undefined>;
  #busy = false;
  #readiness: Promise<void> | undefined;
  #operations: Promise<unknown> = Promise.resolve();
  #wakeTail: Promise<void> = Promise.resolve();
  #idle: Promise<void> | undefined;
  #admitting = 0;
  readonly #gitRefresh: GitRefreshState = { loop: undefined, dueAt: undefined, wake: undefined };
  /** Discovered after setup or resume; the agent sees it only while the environment runs. */
  /** Loaded once from the first checkout, then fixed for the Session; see `#loadSkills`. */
  #skills: string | undefined;
  #skillsScan: Promise<void> | undefined;

  constructor(ctx: SessionContext, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
    // SAFETY: native RPC stubs implement these interfaces; platform thenables differ only in types.
    // deno-lint-ignore openorb/no-chained-type-assertions
    this.#workspace = env.WORKSPACE.getByName("workspace") as unknown as WorkspaceApi;
    // SAFETY: as above, for the Runners Durable Object's environment procedures.
    // deno-lint-ignore openorb/no-chained-type-assertions
    this.#runners = env.RUNNERS.getByName("runners") as unknown as RunnerEnvironmentApi;
    // SAFETY: the R2 binding implements this subset; its thenables differ only in checker types.
    // deno-lint-ignore openorb/no-chained-type-assertions
    this.#media = env.MEDIA as unknown as MediaBucket;
    this.#links = new EnvironmentLinks(ctx);
    // Link liveness answered by the platform, so an idle link never wakes this object.
    ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
    // Requests wait until the schema is current and the record and runtime are loaded.
    this.#runtime = ctx.blockConcurrencyWhile(async () => {
      await migrateDurableObjectDatabase(ctx.storage, sessionMigrations);
      this.#record = readRecord(ctx.storage);
      return await this.#open();
    });
  }

  // --- Native RPC -------------------------------------------------------------------------------

  /**
   * Admits the initial prompt and provisions the project in the background. Repeating it for the
   * same Session is harmless.
   */
  async create(input: CreateSessionInput): Promise<{ readonly created: boolean }> {
    if (await this.#runtime !== undefined) return { created: false };
    this.#write({
      workspaceId: Schema.decodeUnknownSync(WorkspaceId)(input.workspaceId),
      sessionId: input.sessionId,
      projectId: input.projectId,
      createdAt: input.createdAt,
      initialPromptPreview: initialPromptPreview(input.initialPrompt),
      environmentProvider: resolveEnvironmentProvider(input.environmentProvider ?? {}),
      guestCredentialOptIn: input.guestCredentialOptIn ?? false,
      runnerId: input.runnerId,
      orbSize: input.orbSize,
      repositoryUrl: input.repositoryUrl,
      ref: input.ref,
      branchName: input.branchName,
      gitAuthor: new GitAuthor(input.gitAuthor),
      model: input.model,
      initialThinkingLevel: input.thinkingLevel,
      environmentState: "stopped",
      environmentReachable: true,
      checkoutState: "pending",
      issues: [],
      operation: "provisioning",
      operationStage: "created",
      agentPaused: false,
      gitMutationRevision: 0,
      lastActivityAt: Date.now(),
      deleting: false,
    });
    this.#runtime = this.#open();
    await this.#runtime;
    // The prompt is admitted at once; its guest tools wait for project setup.
    await this.submit({ prompt: input.initialPrompt, requestId: input.sessionId });
    return { created: true };
  }

  view(): EncodedSessionView | null {
    const record = this.#record;
    if (record === undefined || record.deleting) return null;
    return encodeSessionView({
      runnerId: record.runnerId,
      snapshot: sessionSnapshot(record, this.#busy),
    });
  }

  async submit(
    input: { prompt: string; requestId: string; thinkingLevel?: ThinkingLevel },
  ): Promise<{ submissionId: number }> {
    const runtime = await this.#required();
    const { agent } = runtime;
    if (!/^[A-Za-z0-9-]{1,100}$/.test(input.requestId) || !input.prompt.trim()) {
      throw new SessionError("A prompt and a request ID are required.");
    }
    // A retried request only observes its admission; even a duplicate submit resumes scheduling.
    const existing = await agent.storage.submissionByRequest(
      agent.conversation.id,
      input.requestId,
      context,
    );
    if (existing !== undefined) return { submissionId: existing.id };
    if (input.thinkingLevel !== undefined) await this.setThinkingLevel(input.thinkingLevel);
    // A prompt resumes a paused agent and wakes stopped compute, as the runner did.
    if (this.#record?.agentPaused) this.#update({ agentPaused: false });
    if (this.#record?.environmentState === "stopped" && this.#record.operation === undefined) {
      this.#background(this.#serialized(() => this.#startEnvironment(runtime)));
    }
    await using admission = new AsyncDisposableStack();
    this.#admitting++;
    admission.defer(async () => {
      this.#admitting--;
      await this.#wake(runtime);
    });
    // Persist recovery before Pi can accept this input.
    await this.#wake(runtime);
    this.#touch();
    const submission = await agent.conversation.submit({
      type: "input",
      content: input.prompt,
      requestId: input.requestId,
      whenBusy: "followUp",
    }, context);
    return { submissionId: submission.id };
  }

  async abort(): Promise<void> {
    const { agent } = await this.#required();
    await agent.conversation.abort(context, { background: true });
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    const runtime = await this.#required();
    const effective = effectiveThinkingLevel(runtime.agent.models, this.#record!.model, level);
    await runtime.agent.conversation.configure({ thinkingLevel: effective }, context);
    return effective;
  }

  /** Wake: resume the agent at once, then start compute and run `.agents/resume` behind it. */
  async wake(recovery?: SessionEnvironmentRecoveryMode): Promise<void> {
    const runtime = await this.#required();
    if (this.#record?.agentPaused) {
      this.#update({ agentPaused: false });
      await this.#wake(runtime);
    }
    this.#background(this.#serialized(() => this.#startEnvironment(runtime, recovery)));
  }

  /** Stop Session: pause the agent recoverably, then stop compute (ADR 0005). */
  async stop(): Promise<EnvironmentControlResult> {
    const runtime = await this.#required();
    return await this.#serialized(async () => {
      await this.#pause(runtime);
      const current = (await this.#runtime)!;
      // The final Git Snapshot is taken before compute stops; failure keeps the previous one.
      await this.#refreshGit(current);
      return await current.environment.control("stop");
    });
  }

  async retry(recovery: "retry-provisioning" | "restart-environment"): Promise<void> {
    const runtime = await this.#required();
    this.#update({ issues: clearFailures(this.#record!.issues) });
    if (recovery === "restart-environment") {
      this.#background(this.#serialized(() => this.#startEnvironment(runtime, recovery)));
      return;
    }
    this.#update({ operation: "provisioning", operationStage: "created" });
    this.#background(this.#serialized(() => this.#provision(runtime)));
  }

  async controlEnvironment(
    action: EnvironmentAction,
    recovery?: SessionEnvironmentRecoveryMode,
  ): Promise<{ state: EnvironmentState; forced: boolean }> {
    const runtime = await this.#required();
    if (action === "stop") return await runtime.environment.control("stop");
    return await this.#control(runtime, action, recovery);
  }

  /** The Runners Durable Object reports runner-side changes to this Session's environment. */
  async environmentNotice(
    workspaceId: string,
    sessionId: string,
    notice: EnvironmentNotice,
  ): Promise<void> {
    const record = this.#record;
    if (
      record === undefined || record.workspaceId !== workspaceId ||
      record.sessionId !== sessionId || record.runnerId !== notice.runnerId
    ) return;
    if (notice.type === "updated") {
      this.#update({ environmentState: notice.environment.state, environmentReachable: true });
      if (notice.environment.state !== "running" && notice.environment.state !== "starting") {
        this.#links.closeAll(1000, "The environment is no longer running.");
      }
    } else if (notice.type === "removed") {
      this.#update({ environmentState: "stopped", environmentReachable: false });
      this.#links.closeAll(1000, "The environment was removed.");
    } else if (notice.type === "unreachable") {
      // The link is independent of the control connection and may still be healthy.
      this.#update({ environmentReachable: false });
    } else {
      this.#update({ environmentReachable: false });
      this.#links.closeAll(4401, "The runner was revoked.");
    }
    const runtime = await this.#runtime;
    if (runtime !== undefined) await this.#wake(runtime);
  }

  /** Deletes compute, then this object's storage. Retried by the alarm while the runner is away. */
  async delete(): Promise<void> {
    const runtime = await this.#runtime;
    if (runtime === undefined) return;
    this.#update({ deleting: true });
    await tryAsync(runtime.agent.conversation.abort(context, { background: true }), () => {});
    await this.#finishDeletion(runtime);
  }

  /** The latest Git Snapshot summary, served while the environment is stopped or offline. */
  gitSnapshot(): (typeof SessionGitSnapshot)["Encoded"] {
    const record = this.#record;
    const stored = readGitSnapshot(this.#ctx.storage) ?? staleGitSnapshot();
    return encodeGitSnapshot(
      record === undefined
        ? stored
        : new SessionGitSnapshot({ ...stored, mutationRevision: gitMutationRevision(record) }),
    );
  }

  /** One byte range of a full patch, read from the guest; needs a running environment. */
  async gitPatchChunk(
    input: { snapshotId: string; section: SessionGitPatchSection; offset: number },
  ): Promise<GitPatchChunk> {
    const runtime = await this.#required();
    const snapshot = readGitSnapshot(this.#ctx.storage);
    if (snapshot?.snapshotId !== input.snapshotId) {
      throw new SessionError("This Git Snapshot was replaced; refresh the changes view.");
    }
    if (this.#record?.environmentState !== "running" || !this.#record.environmentReachable) {
      throw new SessionError("Start the environment to load the full diff.");
    }
    return await readGitPatchChunk(
      runtime.environment.env,
      input.snapshotId,
      input.section,
      input.offset,
      snapshot.sections[input.section].fullPatchBytes ?? 0,
      context,
    );
  }

  async updateGitFile(
    input: { action: SessionGitFileAction; path: string; previousPath?: string },
  ): Promise<{ mutationRevision: number }> {
    const runtime = await this.#required();
    const record = this.#record!;
    const result = await updateGitFile(runtime.environment.env, record, input, context);
    if (!result.ok) {
      this.#scheduleGitRefresh(runtime, 0);
      throw new SessionError(result.message);
    }
    const mutationRevision = record.gitMutationRevision + 1;
    this.#update({ gitMutationRevision: mutationRevision });
    this.#scheduleGitRefresh(runtime, 0);
    return { mutationRevision };
  }

  /** Published media in R2, or an inline image's bytes from Harness State. */
  async media(id: string): Promise<SessionMedia | null> {
    const record = this.#record;
    if (record === undefined || record.deleting) return null;
    const published = this.#ctx.storage.sql.exec(
      "SELECT file_name, media_type, byte_length FROM openorb_media WHERE id = ?",
      id,
    ).toArray()[0];
    if (published !== undefined) {
      return {
        kind: "published",
        key: `${mediaPrefix(record.workspaceId, record.sessionId)}${id}`,
        mediaType: Schema.decodeUnknownSync(SessionArtifactMediaTypeSchema)(published.media_type),
        byteLength: Number(published.byte_length),
        fileName: String(published.file_name),
      };
    }
    const inline = this.#ctx.storage.sql.exec(
      "SELECT entry_id FROM openorb_inline_image WHERE id = ?",
      id,
    ).toArray()[0];
    if (inline === undefined) return null;
    const runtime = await this.#required();
    const { conversation } = runtime.agent;
    let found: Awaited<ReturnType<typeof findInlineImage>>;
    if (inline.entry_id === null) {
      found = await findInlineImage(asJson((await conversation.viewState(context)).value.docs), id);
    } else {
      const entryId = storedEntryId(Number(inline.entry_id));
      const page = await conversation.entries(
        { minEntryId: entryId, maxEntryId: entryId },
        1,
        undefined,
        context,
      );
      for (const entry of page.items) found ??= await findInlineImage(asJson(entry), id);
    }
    return found === undefined ? null : { kind: "inline", ...found };
  }

  // --- HTTP and WebSockets ----------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/link")) return this.#links.accept(request);
    if (url.pathname.endsWith("/events")) return await this.#events(request);
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(socket: SessionWebSocket, message: string | ArrayBuffer): Promise<void> {
    const record = this.#record;
    await this.#links.message(
      socket,
      message,
      record === undefined ? undefined : {
        runnerId: record.runnerId,
        workspaceId: record.workspaceId,
        authenticate: (token) => this.#workspace.authenticateRunner(token),
      },
    );
  }

  webSocketClose(socket: SessionWebSocket, _code: number, reason: string): void {
    this.#links.closed(socket, reason);
  }

  webSocketError(socket: SessionWebSocket): void {
    this.#links.closed(socket, "The Environment Link failed.");
  }

  async alarm(): Promise<void> {
    await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
    const runtime = await this.#runtime;
    if (runtime === undefined) {
      await this.#ctx.storage.deleteAlarm();
      return;
    }
    if (this.#record?.deleting) {
      await this.#finishDeletion(runtime);
      return;
    }
    if (this.#busy) this.#scheduleGitRefresh(runtime, 0);
    await this.#stopIfIdle(runtime);
    await this.#wake(runtime);
  }

  /** Model access with Workspace credentials; the only seam for scripted test models. */
  protected agentModels(credentials: CredentialStore): Models {
    return createAgentModels(credentials);
  }

  // --- Lifecycle --------------------------------------------------------------------------------

  async #open(): Promise<Runtime | undefined> {
    const record = this.#record;
    if (record === undefined) return undefined;
    await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
    const environment = this.#provider(record.environmentProvider).bind({
      workspaceId: record.workspaceId,
      sessionId: Schema.decodeUnknownSync(SessionId)(record.sessionId),
      placement: record.runnerId,
      repository: { url: record.repositoryUrl, gitAuthor: record.gitAuthor },
    });
    const gated = gatedExecutionEnv(environment.env, () => this.#readiness);
    const agent = await openAgent(this.#ctx.storage, {
      sessionId: record.sessionId,
      model: record.model,
      thinkingLevel: record.initialThinkingLevel,
      repositoryUrl: record.repositoryUrl,
      branchName: record.branchName,
      models: this.agentModels(new WorkspaceCredentialStore(this.#workspace, record.workspaceId)),
      env: gated,
      controlEnvironment: async (action) => {
        const runtime = await this.#required();
        if (action === "stop") return await runtime.environment.control("stop");
        return await this.#control(runtime, action);
      },
      publishMedia: (path, description) => this.#publishMedia(gated, path, description),
      repositorySkills: () => this.#skills ?? SKILLS_PENDING_PROMPT,
    }, context);
    const runtime: Runtime = { environment, agent };
    // The transcript records the catalog the model was shown; reopening restores it unchanged.
    this.#skills ??= shownRepositorySkills((await agent.conversation.context(context)).messages);
    await this.#watchActivity(agent);
    if (record.operation === undefined && record.environmentState === "running") {
      this.#background(this.#loadSkills(runtime));
    }
    if (record.operation !== undefined) {
      // An eviction interrupted setup; finish it from the start, which is idempotent.
      this.#background(
        this.#serialized(() =>
          record.operation === "provisioning"
            ? this.#provision(runtime)
            : this.#startEnvironment(runtime)
        ),
      );
    }
    await this.#wake(runtime);
    return runtime;
  }

  async #watchActivity(agent: Agent): Promise<void> {
    const events = await watchEvents(agent.harness, agent.conversation.id, context);
    this.#busy = events.snapshot.run !== undefined;
    events.start((batch) => {
      // A queued follow-up can end one run and start another in the same commit.
      const before = this.#busy;
      let boundary = false;
      for (const event of batch) {
        if (event.type === "snapshot") this.#busy = event.run !== undefined;
        if (event.type === "run_start") this.#busy = true;
        if (event.type === "run_end") this.#busy = false;
        boundary ||= event.type === "tool_execution_end" || event.type === "turn_end" ||
          event.type === "run_end";
      }
      if (before !== this.#busy) this.#publishState();
      if (boundary) {
        void this.#runtime.then((runtime) =>
          runtime && this.#scheduleGitRefresh(runtime, GIT_REFRESH_DEBOUNCE_MS)
        );
      }
      return Promise.resolve();
    });
  }

  async #required(): Promise<Runtime> {
    const runtime = await this.#runtime;
    if (runtime === undefined || this.#record?.deleting) {
      throw new SessionError("Session not found.");
    }
    return runtime;
  }

  /** Environment creation, start, clone, branch, and setup; then the agent's tools proceed. */
  async #provision(runtime: Runtime): Promise<void> {
    await this.#operation("provisioning", async (reporter, secrets) => {
      const record = this.#record!;
      reporter.stage("starting-vm");
      await this.#guard(
        "vm-start",
        "The environment could not be created.",
        () => runtime.environment.create({ orbSize: record.orbSize }),
      );
      await this.#guard(
        "vm-start",
        "The environment could not be started.",
        () => this.#control(runtime, "start"),
      );
      const checkout = await provisionCheckout(
        runtime.environment.env,
        { repositoryUrl: record.repositoryUrl, ref: record.ref, branchName: record.branchName },
        {
          ...reporter,
          // Skills are repository content; load them before setup, which may take minutes.
          checkedOut: (baseCommit) => {
            this.#update({ checkoutState: "available", baseCommit });
            this.#background(this.#loadSkills(runtime));
          },
        },
        secrets,
        context,
      );
      this.#update({
        checkoutState: checkout.checkoutState,
        ...(checkout.baseCommit === undefined ? {} : { baseCommit: checkout.baseCommit }),
        issues: appendIssues(this.#record!.issues, checkout.issues),
      });
    });
    this.#scheduleGitRefresh(runtime, 0);
  }

  /** Starts compute and runs `.agents/resume` on an available checkout. */
  async #startEnvironment(
    runtime: Runtime,
    recovery?: SessionEnvironmentRecoveryMode,
  ): Promise<void> {
    const record = this.#record!;
    if (record.checkoutState === "pending") {
      this.#update({ operation: "provisioning", operationStage: "created" });
      await this.#provision(runtime);
      return;
    }
    if (record.environmentState === "running" && recovery === undefined) return;
    await this.#operation("resuming", async (reporter, secrets) => {
      reporter.stage("starting-vm");
      await this.#guard(
        "vm-start",
        "The environment could not be started.",
        () => this.#control(runtime, recovery === undefined ? "start" : "restart", recovery),
      );
      if (this.#record!.checkoutState !== "available") return;
      const issues = await resumeCheckout(runtime.environment.env, reporter, secrets, context);
      this.#update({ issues: appendIssues(this.#record!.issues, issues) });
    });
  }

  /**
   * Loads repository skills once, from the first checkout. The catalog then stays fixed for the
   * Session: a changed system prompt section would rewrite the model's cached prompt prefix. It is
   * kept only in the transcript, so a load the model has not yet been shown is redone after an
   * eviction; a failed load is retried at the next start or reopen. Never blocks the agent.
   */
  #loadSkills(runtime: Runtime): Promise<void> {
    const record = this.#record;
    if (
      this.#skills !== undefined || this.#skillsScan !== undefined ||
      record?.checkoutState !== "available" || record.environmentState !== "running"
    ) return this.#skillsScan ?? Promise.resolve();
    this.#skillsScan = (async () => {
      const [skills, failure] = await tryAsync(
        discoverRepositorySkills(
          runtime.environment.env,
          withAbortSignal(AbortSignal.timeout(SKILL_DISCOVERY_TIMEOUT_MS), context),
        ),
        () => new SessionError("Repository skill discovery failed or timed out."),
      );
      if (failure !== undefined) return;
      this.#skills ??= repositorySkillsPrompt(skills);
    })().finally(() => {
      this.#skillsScan = undefined;
    });
    return this.#skillsScan;
  }

  /** Runs one setup operation with its stages and logs published, and the readiness gate held. */
  async #operation(
    operation: "provisioning" | "resuming",
    work: (reporter: ProvisioningReporter, secrets: readonly string[]) => Promise<void>,
  ): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#readiness = promise;
    this.#update({ operation });
    using settle = new DisposableStack();
    settle.defer(() => {
      this.#readiness = undefined;
      resolve();
      const { operation: _operation, operationStage: _stage, ...settled } = this.#record!;
      this.#write(settled);
    });
    const reporter: ProvisioningReporter = {
      stage: (stage) => this.#update({ operationStage: stage }),
      log: (stream, text) => this.#publish({ type: "provisioning.log", stream, text }),
    };
    const [, failure] = await tryAsync(
      (async () => await work(reporter, await this.#secretValues()))(),
      (cause) => cause,
    );
    if (failure !== undefined) {
      const issue = failure instanceof ProvisioningFailure ? failure.issue : sessionIssue({
        category: "vm-start",
        severity: "failure",
        message: failure instanceof Error ? failure.message : "Session setup failed.",
        recovery: operation === "provisioning" ? "retry-provisioning" : "restart-environment",
      });
      this.#update({ issues: appendIssues(this.#record!.issues, [issue]) });
      return;
    }
  }

  /** Runs an infrastructure step whose failure needs the retry-provisioning recovery. */
  async #guard(
    category: "vm-start",
    message: string,
    action: () => Promise<void | EnvironmentControlResult>,
  ): Promise<void> {
    const [, failure] = await tryAsync(action(), (cause) =>
      new ProvisioningFailure(sessionIssue({
        category,
        severity: "failure",
        message,
        diagnostics: cause instanceof Error ? cause.message : undefined,
        recovery: "retry-provisioning",
      })));
    if (failure !== undefined) throw failure;
  }

  async #pause(runtime: Runtime): Promise<void> {
    if (this.#record?.agentPaused) return;
    // Closing checkpoints the work; reopening without resuming keeps it paused until Wake.
    this.#update({ agentPaused: true });
    await runtime.agent.harness.close(context);
    this.#runtime = this.#open();
    await this.#runtime;
  }

  #provider(kind: EnvironmentProviderKind): AgentEnvironmentProvider {
    switch (kind) {
      case "runner":
        return runnerProvider({
          runners: this.#runners,
          links: this.#links.host(),
          state: () => ({
            state: this.#record?.environmentState ?? "stopped",
            reachable: this.#record?.environmentReachable ?? false,
          }),
          recordState: (environmentState) => this.#update({ environmentState }),
        });
    }
  }

  async #control(
    runtime: Runtime,
    action: "start" | "restart",
    recovery?: SessionEnvironmentRecoveryMode,
  ): Promise<EnvironmentControlResult> {
    const record = this.#record!;
    const [githubToken, githubError] = await this.#workspace.getGitHubToken(record.workspaceId);
    if (githubError !== undefined) throw githubError;
    const [secrets, secretsError] = await this.#workspace.getEnvironmentSecrets(
      record.workspaceId,
    );
    if (secretsError !== undefined) throw secretsError;
    this.#touch();
    const provider = this.#provider(record.environmentProvider);
    const result = await runtime.environment.control(action, {
      credentials: permittedCredentials(
        provider.capabilities,
        record.guestCredentialOptIn,
        {
          ...(githubToken === null ? {} : { githubToken }),
          ...(secrets.length === 0 ? {} : { environmentSecrets: secrets }),
        },
      ),
      ...(recovery === undefined ? {} : { recovery }),
    });
    // Retries a first load that failed or was interrupted; a loaded catalog is never rescanned.
    if (result.state === "running") this.#background(this.#loadSkills(runtime));
    return result;
  }

  /** Values redacted from setup output shown to Session viewers. */
  async #secretValues(): Promise<readonly string[]> {
    const record = this.#record!;
    const [[githubToken], [secrets]] = await Promise.all([
      this.#workspace.getGitHubToken(record.workspaceId),
      this.#workspace.getEnvironmentSecrets(record.workspaceId),
    ]);
    return [
      ...(githubToken ? [githubToken] : []),
      ...(secrets ?? []).map((secret) => secret.value),
    ];
  }

  /** pi-celld's recovery loop: alarms renew bounded host waits until the durable work settles. */
  #wake(runtime: Runtime): Promise<void> {
    const wake = this.#wakeTail.then(async () => {
      const { harness, conversation } = runtime.agent;
      const { tasks, scheduling } = await harness.inspect(context);
      if (scheduling === "closing") return;
      const record = this.#record;
      if (record === undefined || record.agentPaused) {
        await this.#ctx.storage.deleteAlarm();
        return;
      }
      if (tasks.length > 0) this.#touch();
      if (!tasks.length && !this.#admitting) {
        // Idle: wake only to stop compute once the idle period has passed.
        if (record.environmentState === "running" || record.operation !== undefined) {
          await this.#ctx.storage.setAlarm(
            Math.max(record.lastActivityAt + IDLE_STOP_MS, Date.now() + RECOVERY_MS),
          );
        } else {
          await this.#ctx.storage.deleteAlarm();
        }
        return;
      }
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const at = live?.generation?.deferred?.pollAt ?? live?.generation?.retry?.at;
      const sleeping = !this.#idle && !this.#admitting && at !== undefined &&
        at - Date.now() > 60_000;
      await this.#ctx.storage.setAlarm(sleeping ? at : Date.now() + RECOVERY_MS);
      if (!tasks.length) return;
      harness.resume();
      if (sleeping || this.#idle || tasks.every((task) => task.record.background)) return;
      // Bound the host wait, not the durable turn; an alarm renews it if needed.
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(), 10 * 60_000);
      this.#idle = conversation.waitForIdle(withAbortSignal(budget.signal, context))
        .then(() => {}, () => {})
        .finally(async () => {
          clearTimeout(timer);
          this.#idle = undefined;
          this.#touch();
          await this.#wake(runtime);
        });
      this.#ctx.waitUntil(this.#idle);
    });
    this.#wakeTail = wake.then(() => {}, () => {});
    return wake;
  }

  async #stopIfIdle(runtime: Runtime): Promise<void> {
    const record = this.#record;
    if (record?.environmentState !== "running" || record.operation !== undefined) return;
    if (this.#idle || this.#admitting || Date.now() - record.lastActivityAt < IDLE_STOP_MS) return;
    const { tasks } = await runtime.agent.harness.inspect(context);
    if (tasks.some((task) => !task.record.background)) return;
    await tryAsync(runtime.environment.control("stop"), () => {});
  }

  async #publishMedia(env: ExecutionEnv, path: string, description: string): Promise<string> {
    const record = this.#record!;
    const used = Number(
      this.#ctx.storage.sql.exec("SELECT COALESCE(SUM(byte_length), 0) AS used FROM openorb_media")
        .toArray()[0]?.used ?? 0,
    );
    const published = await publishGuestMedia(env, this.#media, {
      path,
      prefix: mediaPrefix(record.workspaceId, record.sessionId),
      usedBytes: used,
    }, context);
    this.#ctx.storage.sql.exec(
      "INSERT INTO openorb_media (id, file_name, media_type, byte_length) VALUES (?, ?, ?, ?)",
      published.id,
      published.fileName,
      published.mediaType,
      published.byteLength,
    );
    const kind = published.mediaType.startsWith("image/") ? "image" : "video";
    const label = (description.trim() || published.fileName).replaceAll("\\", "\\\\")
      .replaceAll("]", "\\]").replaceAll("\n", " ");
    return `![${label}](openorb-artifact:${kind}:${published.id})`;
  }

  async #finishDeletion(runtime: Runtime): Promise<void> {
    const record = this.#record!;
    const [, mediaFailure] = await tryAsync(
      deleteSessionMedia(this.#media, mediaPrefix(record.workspaceId, record.sessionId)),
      (cause) => cause,
    );
    if (mediaFailure !== undefined) {
      await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
      return;
    }
    const [, failure] = await tryAsync(runtime.environment.delete(), (cause) => cause);
    if (failure !== undefined) {
      // The runner may be offline; the alarm retries until compute is gone.
      await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
      return;
    }
    this.#links.closeAll(1000, "The session was deleted.");
    await tryAsync(runtime.agent.harness.close(context), () => {});
    await this.#ctx.storage.deleteAlarm();
    await this.#ctx.storage.deleteAll();
    this.#record = undefined;
    this.#runtime = Promise.resolve(undefined);
  }

  // --- Git Snapshots ----------------------------------------------------------------------------

  /** Requests a refresh within `delayMs`; a sooner request wins and none is postponed. */
  #scheduleGitRefresh(runtime: Runtime, delayMs: number): void {
    const state = this.#gitRefresh;
    const dueAt = Date.now() + delayMs;
    if (state.dueAt === undefined || dueAt < state.dueAt) {
      state.dueAt = dueAt;
      state.wake?.();
    }
    if (state.loop !== undefined) return;
    state.loop = this.#gitRefreshLoop(runtime).finally(() => {
      state.loop = undefined;
    });
    this.#ctx.waitUntil(state.loop);
  }

  /**
   * Refreshes never overlap: a request during one runs once more after it, and a busy agent's
   * changes refresh periodically. Waits stay inside this waitUntil promise, because a timer set
   * after its request context has ended may never fire.
   */
  async #gitRefreshLoop(runtime: Runtime): Promise<void> {
    const state = this.#gitRefresh;
    while (state.dueAt !== undefined) {
      const wait = state.dueAt - Date.now();
      if (wait > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        state.wake = resolve;
        const timer = setTimeout(resolve, wait);
        await promise;
        clearTimeout(timer);
        state.wake = undefined;
        continue;
      }
      state.dueAt = undefined;
      await this.#refreshGit(runtime);
      if (this.#busy && state.dueAt === undefined) {
        state.dueAt = Date.now() + GIT_REFRESH_INTERVAL_MS;
      }
    }
  }

  async #refreshGit(runtime: Runtime): Promise<void> {
    const record = this.#record;
    if (
      record === undefined || record.checkoutState !== "available" ||
      record.environmentState !== "running" || !record.environmentReachable ||
      record.operation !== undefined
    ) return;
    const previous = readGitSnapshot(this.#ctx.storage);
    const [snapshot, failure] = await tryAsync(
      generateGitSnapshot(runtime.environment.env, record, context),
      (cause) => new SessionError("The Git Snapshot could not be refreshed.", { cause }),
    );
    if (failure !== undefined) {
      this.#storeGitSnapshot(previous, staleGitSnapshot(previous));
      return;
    }
    this.#storeGitSnapshot(previous, snapshot);
  }

  #storeGitSnapshot(previous: SessionGitSnapshot | undefined, next: SessionGitSnapshot): void {
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return;
    writeGitSnapshot(this.#ctx.storage, next);
    this.#publish({ type: "git.snapshot.updated" });
  }

  // --- Events -----------------------------------------------------------------------------------

  /** A snapshot, the session state, then structural operations and infrastructure events. */
  async #events(request: Request): Promise<Response> {
    const runtime = await this.#required();
    const watch = await runtime.agent.conversation.watch(context);
    // Inline images cross the stream only as references to Harness State.
    const projection = new ConversationProjection({
      found: (id, mediaType, entryId) =>
        this.#ctx.storage.sql.exec(
          "INSERT INTO openorb_inline_image (id, media_type, entry_id) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
          id,
          mediaType,
          entryId ?? null,
        ),
    });
    let delivered = await projection.project(watch.value);
    const encoder = new TextEncoder();
    const subscribers = this.#subscribers;
    const initialState = this.#stateEvent();
    let cleanup = () => {};
    let resume = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let stopped = false;
        const send = (event: SessionEvent) =>
          controller.enqueue(encoder.encode(`event: session\ndata: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(
          encoder.encode(
            `event: session\ndata: ${
              JSON.stringify({ type: "conversation.snapshot", view: delivered })
            }\n\n`,
          ),
        );
        if (initialState !== undefined) send(initialState);
        // Infrastructure events are small and rare; a stalled viewer reconnects for a snapshot.
        const subscriber = (event: SessionEvent) => {
          if (!stopped) send(event);
        };
        subscribers.add(subscriber);
        watch.start(async (value) => {
          // Pi bounds pending frames and replaces them with a snapshot on overflow.
          while (!stopped && (controller.desiredSize ?? 0) <= 0) {
            await new Promise<void>((done) => resume = done);
          }
          if (stopped) return;
          const latest = await projection.project(value);
          const ops = diffRevisions(delivered, latest);
          delivered = latest;
          if (ops.length > 0 && !stopped) {
            controller.enqueue(
              encoder.encode(
                `event: session\ndata: ${JSON.stringify({ type: "conversation.ops", ops })}\n\n`,
              ),
            );
          }
        });
        const heartbeat = setInterval(() => {
          if (!stopped && (controller.desiredSize ?? 0) > 0) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          }
        }, 15_000);
        cleanup = () => {
          if (stopped) return;
          stopped = true;
          subscribers.delete(subscriber);
          clearInterval(heartbeat);
          resume();
          void watch.stop();
        };
        const abort = () => {
          cleanup();
          controller.close();
        };
        void watch.closed.then(abort);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      },
      pull: () => resume(),
      cancel: () => cleanup(),
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  #stateEvent(): SessionEvent | undefined {
    const record = this.#record;
    if (record === undefined) return undefined;
    const snapshot = sessionSnapshot(record, this.#busy);
    return {
      type: "session.state",
      stage: sessionStage(record, this.#busy) satisfies SessionProvisioningStage,
      agentState: snapshot.agentState,
      environmentState: record.environmentState,
      checkoutState: record.checkoutState,
      issues: snapshot.issues,
    };
  }

  #publish(event: SessionEvent): void {
    for (const subscriber of this.#subscribers) subscriber(event);
  }

  #publishState(): void {
    const event = this.#stateEvent();
    if (event !== undefined) this.#publish(event);
  }

  // --- Record -----------------------------------------------------------------------------------

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(work, work);
    this.#operations = result.then(() => {}, () => {});
    return result;
  }

  #background(work: Promise<unknown>): void {
    this.#ctx.waitUntil(work.then(() => {}, () => {}));
  }

  #touch(): void {
    if (this.#record !== undefined) {
      this.#record = { ...this.#record, lastActivityAt: Date.now() };
      writeRecord(this.#ctx.storage, this.#record);
    }
  }

  #write(record: SessionRecord): void {
    this.#record = record;
    writeRecord(this.#ctx.storage, record);
    this.#publishState();
  }

  #update(update: Partial<SessionRecord>): void {
    if (this.#record === undefined) return;
    this.#write({ ...this.#record, ...update });
  }
}

/** Entry IDs in the inline image index were recorded from this conversation's entries. */
function storedEntryId(value: number): EntryId {
  // SAFETY: only `EntryRecord.id` values of this Session's conversation are stored.
  return value as EntryId;
}
