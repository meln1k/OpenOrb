import { DurableObject } from "cloudflare:workers";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { diffRevisions } from "@earendil-works/chord/delta";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { type EntryId, LiveDoc, watchEvents } from "@earendil-works/pi-durable";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  type Environment,
  type EnvironmentCapabilities,
  type EnvironmentControlResult,
  type EnvironmentCredentials,
  type EnvironmentHost,
  type EnvironmentPlacement,
  type EnvironmentProvider,
  type EnvironmentProviders,
  type HostWebSocket,
  receivesCredentials,
} from "@openorb/environments";
import type { SessionThinkingLevel as ThinkingLevel } from "@openorb/protocol";
import { GitAuthor, type OrbSize, SessionId, WorkspaceId } from "@openorb/protocol/runner-api";
import { tryAsync } from "@openorb/result";
import { Schema } from "effect";
import type { Env } from "../../env.ts";
import { initialPromptPreview, type WorkspaceApi } from "../workspace/api.ts";
import {
  type Agent,
  createAgentModels,
  effectiveThinkingLevel,
  openAgent,
  SessionError,
} from "./agent.ts";
import { WorkspaceCredentialStore } from "./credentials.ts";
import { codemodeFacet } from "./codemode/facet.ts";
import { environmentProviders } from "./environments.ts";
import { migrateDurableObjectDatabase } from "../migrations.ts";
import { sessionMigrations } from "./migrations.ts";
import { shownRepositorySkills } from "./skills.ts";
import {
  asJson,
  ConversationProjection,
  deleteSessionMedia,
  findInlineImage,
  type MediaBucket,
  mediaPrefix,
  publishGuestMedia,
  SessionArtifactMediaType,
} from "./media.ts";
import {
  appendIssues,
  clearFailures,
  createWorkspace,
  ProvisioningFailure,
  type ProvisioningReporter,
  redactedValues,
  sessionIssue,
  setupEntry,
} from "./provisioning.ts";
import {
  hasFailure,
  readGitSnapshot,
  readRecord,
  type SessionProject,
  type SessionRecord,
  sessionSnapshot,
  sessionView,
  writeRecord,
} from "./record.ts";
import { type GitPatchChunk, staleGitSnapshot } from "./git-snapshot.ts";
import type {
  SessionGitFileAction,
  SessionGitPatchSection,
  SessionGitSnapshot,
} from "./git-snapshot-schema.ts";
import type { SessionEvent, SessionIssue, SessionView } from "./view.ts";
import type { PeerThreadStatus, SessionPeer, ThreadContext } from "./api.ts";
import { peerThreadStatus, ThreadHost } from "./threads/host.ts";
import {
  THREAD_MESSAGE_KIND,
  threadMessage,
  type ThreadMessageData,
} from "@openorb/protocol/thread-message";
import { conversationTranscript } from "./threads/transcript.ts";
import { GIT_REFRESH_DEBOUNCE_MS, ProjectIntegration } from "./project.ts";

const context = BACKGROUND_CONTEXT;
/** Deadman alarm: a crash during startup or an alarm leaves another wake behind. */
const RECOVERY_MS = 30_000;
const IDLE_STOP_MS = 15 * 60_000;
/** A deferred or retried model request further out than this lets the object sleep until then. */
const SLEEP_AFTER_MS = 60_000;
/** Bounds this object's wait for the agent, not the durable turn; an alarm renews it. */
const HOST_WAIT_MS = 10 * 60_000;

export interface SessionStorage extends DurableObjectSqliteStorage {
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
  sync(): Promise<void>;
}

export interface SessionContext {
  readonly storage: SessionStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: HostWebSocket, tags?: string[]): void;
  /** Child Durable Objects with their own storage, such as the sandbox environment. */
  readonly facets: DurableObjectFacets;
  getWebSockets(tag?: string): HostWebSocket[];
  waitUntil(promise: Promise<unknown>): void;
  setWebSocketAutoResponse?(pair: InstanceType<typeof WebSocketRequestResponsePair>): void;
}

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** Absent for a Session without a project; the Sandbox never has one (ADR 0007). */
  readonly project?: Omit<SessionProject, "gitAuthor"> & {
    readonly gitAuthor: { readonly name: string; readonly email: string };
  };
  /** The catalog entry's creation time, so both records agree. */
  readonly createdAt: string;
  /** Where the Agent Environment runs (ADRs 0006 and 0007). */
  readonly placement: EnvironmentPlacement;
  /** The Project's Guest Credential Opt-in (ADR 0006). Absent: not opted in. */
  readonly guestCredentialOptIn?: boolean;
  readonly orbSize: OrbSize;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly initialPrompt: string;
  /** Who wrote the initial prompt: the user, or a parent creating a Child Session (ADR 0010). */
  readonly origin: SessionOrigin;
}

/** A prompt the user wrote; only these grant access to the Sessions they paste (ADR 0010). */
export interface UserOrigin {
  readonly kind: "user";
}

/** A parent creating a Child Session: its ID, and its Initial Prompt Preview, which names it. */
export interface ParentOrigin {
  readonly kind: "parent";
  readonly sessionId: string;
  readonly title: string;
}

export type SessionOrigin = UserOrigin | ParentOrigin;

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

interface Runtime {
  readonly environment: Environment;
  /** What the Session's provider guarantees; fixed for the Session's lifetime. */
  readonly capabilities: EnvironmentCapabilities;
  /** The project's checkout, hooks, skills, and Git Snapshots; absent without a project. */
  readonly project: ProjectIntegration | undefined;
  readonly agent: Agent;
}

export interface AlarmInputs {
  readonly now: number;
  readonly record: Pick<SessionRecord, "environment" | "operation" | "lastActivityAt" | "deleting">;
  /** Unsettled harness tasks. */
  readonly tasks: number;
  /** When a deferred or retried model request is due, if the agent waits for one. */
  readonly resumeAt: number | undefined;
  /** This object is already waiting for the agent to settle. */
  readonly hostWait: boolean;
}

/**
 * When the Session must wake next, or `undefined` when nothing needs it. Unfinished work, setup,
 * and deletion renew a short recovery deadline, unless the agent waits for a distant model retry;
 * idle compute wakes the Session once the idle period has passed, to stop it.
 */
export function nextAlarm({
  now,
  record,
  tasks,
  resumeAt,
  hostWait,
}: AlarmInputs): number | undefined {
  const recovery = now + RECOVERY_MS;
  if (tasks > 0) {
    return !hostWait && resumeAt !== undefined && resumeAt - now > SLEEP_AFTER_MS
      ? resumeAt
      : recovery;
  }
  if (record.deleting || record.operation !== undefined) return recovery;
  if (record.environment.state === "running") {
    return Math.max(record.lastActivityAt + IDLE_STOP_MS, recovery);
  }
  return undefined;
}

/**
 * One Session's agent and project: Pi Durable on this object's SQLite storage, reaching its Agent
 * Environment only through the provider's ExecutionEnv (ADRs 0005 and 0006). The Session never
 * depends on which provider that is. Pi owns every prompt from admission; its runs wait only for
 * queued environment setup to settle, and guest tools fail immediately while the environment is
 * unavailable.
 */
export class Session extends DurableObject<Env> {
  readonly #ctx: SessionContext;
  readonly #workspace: WorkspaceApi;
  readonly #threads: ThreadHost;
  readonly #media: MediaBucket;
  readonly #subscribers = new Set<(event: SessionEvent) => void>();
  #providers: EnvironmentProviders | undefined;
  #record: SessionRecord | undefined;
  #runtime: Promise<Runtime | undefined>;
  #busy = false;
  /** Orders idle and alarm decisions; never waits for the agent or for compute. */
  #decisions: Promise<unknown> = Promise.resolve();
  /** Runs environment operations one at a time: setup, start, and stop. */
  #operations: Promise<unknown> = Promise.resolve();
  #queuedOperations = 0;
  /** This object's bounded wait for the agent to settle, while one runs. */
  #hostWait: Promise<void> | undefined;

  constructor(ctx: SessionContext, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
    // SAFETY: native RPC stubs implement these interfaces; platform thenables differ only in types.
    // oxlint-disable-next-line openorb/no-chained-type-assertions
    this.#workspace = env.WORKSPACE.getByName("workspace") as unknown as WorkspaceApi;
    // SAFETY: the R2 binding implements this subset; its thenables differ only in checker types.
    // oxlint-disable-next-line openorb/no-chained-type-assertions
    this.#media = env.MEDIA;
    this.#threads = new ThreadHost({
      storage: ctx.storage,
      workspace: this.#workspace,
      record: () => this.#record!,
      peer: (sessionId) => this.sessionPeer(sessionId),
    });
    // Requests wait until the schema is current and the record and runtime are loaded.
    this.#runtime = ctx.blockConcurrencyWhile(async () => {
      await migrateDurableObjectDatabase(ctx.storage, sessionMigrations);
      this.#record = readRecord(ctx.storage);
      return await this.#open();
    });
  }

  // --- Native RPC -------------------------------------------------------------------------------

  /**
   * Records the Session, provisions it in the background, and admits its initial prompt, which
   * runs once setup settles. Repeating it is harmless: Pi admits the prompt once.
   */
  async create(input: CreateSessionInput): Promise<{ readonly created: boolean }> {
    const created = (await this.#runtime) === undefined;
    if (created) this.#record = this.#createdRecord(input);
    if (this.#record?.deleting) return { created: false };
    if (created) {
      this.#runtime = this.#open();
      // A placement its provider cannot open, such as one without a runner, leaves no Session.
      const [, failure] = await tryAsync(this.#runtime, (cause) => cause);
      if (failure !== undefined) {
        this.#ctx.storage.sql.exec("DELETE FROM openorb_session");
        this.#record = undefined;
        this.#runtime = Promise.resolve(undefined);
        throw failure;
      }
    }
    const runtime = await this.#required();
    if (input.origin.kind === "user") {
      this.#threads.grantPastedSessions(input.initialPrompt);
      await this.#admit(runtime, input.initialPrompt, input.sessionId);
    } else {
      const { sessionId, title } = input.origin;
      await this.#admit(
        runtime,
        threadMessage("parent", sessionId, input.initialPrompt),
        input.sessionId,
        { relation: "parent", sessionId, title },
      );
    }
    return { created };
  }

  #createdRecord(input: CreateSessionInput): SessionRecord {
    // Resolved before anything is recorded: an unknown provider leaves no Session behind.
    const provider = this.#provider(input.placement);
    if (input.project !== undefined && !provider.capabilities.git) {
      throw new SessionError("This environment has no Git, so its Sessions cannot have a project.");
    }
    const record: SessionRecord = {
      workspaceId: Schema.decodeUnknownSync(WorkspaceId)(input.workspaceId),
      sessionId: input.sessionId,
      ...(input.origin.kind === "parent" ? { parentSessionId: input.origin.sessionId } : {}),
      ...(input.project === undefined
        ? {}
        : { project: { ...input.project, gitAuthor: new GitAuthor(input.project.gitAuthor) } }),
      createdAt: input.createdAt,
      initialPromptPreview: initialPromptPreview(input.initialPrompt),
      placement: input.placement,
      guestCredentialOptIn: input.guestCredentialOptIn ?? false,
      orbSize: input.orbSize,
      model: input.model,
      initialThinkingLevel: input.thinkingLevel,
      environment: { state: "stopped", reachable: true },
      checkoutState: "pending",
      issues: [],
      operation: "provisioning",
      operationStage: "created",
      gitMutationRevision: 0,
      lastActivityAt: Date.now(),
      deleting: false,
    };
    writeRecord(this.#ctx.storage, record);
    return record;
  }

  view(): SessionView | null {
    const record = this.#record;
    if (record === undefined || record.deleting) return null;
    return sessionSnapshot(record, this.#busy);
  }

  /** Admits a prompt to Pi; it starts a stopped environment and runs once setup settles. */
  async submit(input: {
    prompt: string;
    requestId: string;
    thinkingLevel?: ThinkingLevel;
    origin: UserOrigin;
  }): Promise<void> {
    const runtime = await this.#required();
    if (!/^[A-Za-z0-9-]{1,100}$/.test(input.requestId) || !input.prompt.trim()) {
      throw new SessionError("A prompt and a request ID are required.");
    }
    if (input.thinkingLevel !== undefined) await this.setThinkingLevel(input.thinkingLevel);
    if (input.origin.kind === "user") this.#threads.grantPastedSessions(input.prompt);
    await this.#admit(runtime, input.prompt, input.requestId);
  }

  /** Abort: cancels agent work and queued prompts; the environment keeps running. */
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

  /** Wake: starts compute and runs `.agents/resume`. */
  async wake(): Promise<void> {
    const runtime = await this.#required();
    this.#background(this.#startEnvironment(runtime));
  }

  /**
   * Stop Session: aborts agent work and queued prompts, then stops compute (ADR 0008). Pi's
   * conversation is durable, so the next prompt continues it and starts compute again.
   */
  async stop(): Promise<EnvironmentControlResult> {
    const runtime = await this.#required();
    // Queued first, so a prompt admitted after the abort runs after the stop, on started compute.
    const stopped = this.#stopEnvironment(runtime);
    await tryAsync(runtime.agent.conversation.abort(context, { background: true }), () => {});
    return await stopped;
  }

  async retry(recovery: "retry-provisioning" | "restart-environment"): Promise<void> {
    const runtime = await this.#required();
    this.#update({ issues: clearFailures(this.#record!.issues) });
    this.#background(
      recovery === "restart-environment"
        ? this.#startEnvironment(runtime, { restart: true })
        : this.#provision(runtime),
    );
  }

  /** The provider's control plane reports a change to this Session's environment. */
  async environmentNotice(workspaceId: string, sessionId: string, notice: unknown): Promise<void> {
    const runtime = await this.#runtime;
    const record = this.#record;
    if (
      runtime === undefined ||
      record?.workspaceId !== workspaceId ||
      record.sessionId !== sessionId
    )
      return;
    runtime.environment.notice?.(notice);
    await this.#reconcile(runtime);
  }

  /** Deletes compute, then this object's storage. Retried by the alarm while the provider is away. */
  async delete(): Promise<void> {
    const runtime = await this.#runtime;
    if (runtime === undefined) return;
    this.#update({ deleting: true });
    await tryAsync(runtime.agent.conversation.abort(context, { background: true }), () => {});
    await this.#finishDeletion(runtime);
  }

  /** The latest Git Snapshot summary, served while the environment is stopped or offline. */
  gitSnapshot(): SessionGitSnapshot {
    const record = this.#record;
    const stored = readGitSnapshot(this.#ctx.storage) ?? staleGitSnapshot();
    return record === undefined
      ? stored
      : { ...stored, mutationRevision: record.gitMutationRevision };
  }

  /** One byte range of a full patch, read from the guest; needs a running environment. */
  async gitPatchChunk(input: {
    snapshotId: string;
    section: SessionGitPatchSection;
    offset: number;
  }): Promise<GitPatchChunk> {
    return await (await this.#project()).patchChunk(input);
  }

  async updateGitFile(input: {
    action: SessionGitFileAction;
    path: string;
    previousPath?: string;
  }): Promise<{ mutationRevision: number }> {
    return { mutationRevision: await (await this.#project()).updateFile(input) };
  }

  /** Published media in R2, or an inline image's bytes from Harness State. */
  async media(id: string): Promise<SessionMedia | null> {
    const record = this.#record;
    if (record === undefined || record.deleting) return null;
    const published = this.#ctx.storage.sql
      .exec("SELECT file_name, media_type, byte_length FROM openorb_media WHERE id = ?", id)
      .toArray()[0];
    if (published !== undefined) {
      return {
        kind: "published",
        key: `${mediaPrefix(record.workspaceId, record.sessionId)}${id}`,
        mediaType: Schema.decodeUnknownSync(SessionArtifactMediaType)(published.media_type),
        byteLength: Number(published.byte_length),
        fileName: String(published.file_name),
      };
    }
    const inline = this.#ctx.storage.sql
      .exec("SELECT entry_id FROM openorb_inline_image WHERE id = ?", id)
      .toArray()[0];
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

  // --- Session-to-Session RPC (ADR 0010) --------------------------------------------------------

  /** Lifecycle and the newest messages, for another Session's get_thread_status. */
  async threadStatus(input: { workspaceId: string }): Promise<PeerThreadStatus> {
    const { runtime, record } = await this.#peerTarget(input.workspaceId);
    const { messages } = await runtime.agent.conversation.context(context);
    return peerThreadStatus(record, this.#busy, messages);
  }

  /** The bounded transcript another Session's read_thread reads. */
  async threadTranscript(input: { workspaceId: string; scope: ThreadContext }): Promise<string> {
    const { runtime } = await this.#peerTarget(input.workspaceId);
    return await conversationTranscript(runtime.agent.conversation, input.scope, context);
  }

  /** A message from this Session's parent or one of its children, admitted like a prompt. */
  async receiveThreadMessage(input: {
    workspaceId: string;
    fromSessionId: string;
    fromTitle: string;
    message: string;
    requestId: string;
  }): Promise<void> {
    const { runtime } = await this.#peerTarget(input.workspaceId);
    const relation = this.#threads.sender(input.fromSessionId);
    await this.#admit(
      runtime,
      threadMessage(relation, input.fromSessionId, input.message),
      input.requestId,
      { relation, sessionId: input.fromSessionId, title: input.fromTitle },
    );
  }

  /** This Session's runtime and record, for a peer call from a Session of the same Workspace. */
  async #peerTarget(workspaceId: string): Promise<{ runtime: Runtime; record: SessionRecord }> {
    const runtime = await this.#required();
    const record = this.#record!;
    if (record.workspaceId !== workspaceId) throw new SessionError("Thread not found.");
    return { runtime, record };
  }

  // --- HTTP and WebSockets ----------------------------------------------------------------------

  /** Conversation events; anything else is the environment's, such as a runner's link upgrade. */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/events")) return await this.#events(request);
    const environment = (await this.#runtime)?.environment;
    return (await environment?.fetch?.(request)) ?? new Response("Not found", { status: 404 });
  }

  async webSocketMessage(socket: HostWebSocket, message: string | ArrayBuffer): Promise<void> {
    const environment = (await this.#runtime)?.environment;
    if (environment?.webSocketMessage === undefined) {
      socket.close(4400, "This session accepts no WebSocket messages.");
      return;
    }
    await environment.webSocketMessage(socket, message);
  }

  async webSocketClose(socket: HostWebSocket, _code: number, reason: string): Promise<void> {
    (await this.#runtime)?.environment.webSocketClose?.(socket, reason);
  }

  async webSocketError(socket: HostWebSocket): Promise<void> {
    (await this.#runtime)?.environment.webSocketClose?.(socket, "The WebSocket failed.");
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
    if (this.#busy) runtime.project?.scheduleRefresh(0);
    await this.#stopIfIdle(runtime);
    await this.#reconcile(runtime);
  }

  /** Model access with Workspace credentials; a seam for scripted test models. */
  protected agentModels(credentials: CredentialStore): Models {
    return createAgentModels(credentials);
  }

  /** Another Session Durable Object of this gateway; a seam for in-memory peers in tests. */
  protected sessionPeer(sessionId: string): SessionPeer {
    // SAFETY: the Session class implements this native RPC surface; platform thenables differ only
    // in checker types.
    // oxlint-disable-next-line openorb/no-chained-type-assertions
    return this.env.SESSIONS.getByName(sessionId) as unknown as SessionPeer;
  }

  /** The Agent Environment Providers by placement name; a seam for test providers. */
  protected environmentProviders(): EnvironmentProviders {
    return environmentProviders(this.env, this.#workspace);
  }

  // --- Lifecycle --------------------------------------------------------------------------------

  async #open(): Promise<Runtime | undefined> {
    const record = this.#record;
    if (record === undefined) return undefined;
    await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
    const provider = this.#provider(record.placement);
    const ctx = this.#ctx;
    const host: EnvironmentHost = {
      workspaceId: record.workspaceId,
      sessionId: Schema.decodeUnknownSync(SessionId)(record.sessionId),
      placement: record.placement,
      ...(record.project === undefined
        ? {}
        : {
            repository: { url: record.project.repositoryUrl, gitAuthor: record.project.gitAuthor },
          }),
      facets: ctx.facets,
      acceptWebSocket: (socket, tags) => ctx.acceptWebSocket(socket, tags),
      getWebSockets: (tag) => ctx.getWebSockets(tag),
      ...(ctx.setWebSocketAutoResponse === undefined
        ? {}
        : { setWebSocketAutoResponse: (pair) => ctx.setWebSocketAutoResponse!(pair) }),
      status: () => this.#record?.environment ?? { state: "stopped", reachable: false },
      report: (environment) => this.#update({ environment }),
      reconcile: () =>
        this.#background(this.#runtime.then((current) => current && this.#reconcile(current))),
    };
    const environment = provider.open(host);
    let project: ProjectIntegration | undefined;
    const agent = await openAgent(
      this.#ctx.storage,
      {
        sessionId: record.sessionId,
        model: record.model,
        thinkingLevel: record.initialThinkingLevel,
        project: record.project,
        guestPrompt: provider.guestPrompt,
        models: this.agentModels(new WorkspaceCredentialStore(this.#workspace, record.workspaceId)),
        env: environment.env,
        setupSettled: (context) => this.#setupSettled(context),
        controlEnvironment: async (action) =>
          action === "stop"
            ? await environment.control("stop")
            : await this.#control(await this.#required(), action),
        publishMedia: (path, description) => this.#publishMedia(environment.env, path, description),
        // Without a project there is no repository to discover skills in.
        repositorySkills: () => project?.skillsPrompt() ?? "",
        searchProviderKeys: () => this.#workspace.getSearchProviderKeys(record.workspaceId),
        codemode: codemodeFacet({
          loader: this.env.LOADER,
          facets: ctx.facets,
          sessionId: record.sessionId,
        }),
        threads: this.#threads,
      },
      context,
    );
    if (record.project !== undefined && provider.capabilities.git) {
      project = new ProjectIntegration(
        record.project,
        {
          env: environment.env,
          storage: this.#ctx.storage,
          record: () => this.#record,
          update: (update) => this.#update(update),
          publish: (event) => this.#publish(event),
          background: (work) => this.#background(work),
          busy: () => this.#busy,
        }, // The transcript records the catalog the model was shown; reopening restores it unchanged.
        shownRepositorySkills((await agent.conversation.context(context)).messages),
      );
    }
    const runtime: Runtime = { environment, capabilities: provider.capabilities, project, agent };
    await this.#watchActivity(runtime);
    if (record.operation === undefined && record.environment.state === "running") {
      this.#background(project?.loadSkills());
    }
    // An eviction interrupted setup; finish it from the start, which is idempotent.
    if (record.operation === "provisioning") this.#background(this.#provision(runtime));
    if (record.operation === "resuming") this.#background(this.#startEnvironment(runtime));
    this.#background(this.#reconcile(runtime));
    return runtime;
  }

  async #watchActivity(runtime: Runtime): Promise<void> {
    const { agent } = runtime;
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
        boundary ||=
          event.type === "tool_execution_end" ||
          event.type === "turn_end" ||
          event.type === "run_end";
      }
      if (before !== this.#busy) this.#publishState();
      if (before && !this.#busy) {
        this.#background(this.#reconcile(runtime));
        const record = this.#record;
        if (record !== undefined) {
          this.#background(this.#workspace.sessionSettled(record.workspaceId, record.sessionId));
        }
      }
      if (boundary) runtime.project?.scheduleRefresh(GIT_REFRESH_DEBOUNCE_MS);
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

  /** The project integration for Git operations; a Session without a project has no Git. */
  async #project(): Promise<ProjectIntegration> {
    const { project } = await this.#required();
    if (project === undefined) throw new SessionError("This Session has no project.");
    return project;
  }

  #provider(placement: EnvironmentPlacement): EnvironmentProvider {
    const provider = (this.#providers ??= this.environmentProviders())[placement.provider];
    if (provider === undefined) {
      throw new SessionError(`There is no "${placement.provider}" environment provider.`);
    }
    return provider;
  }

  /**
   * Keeps unfinished agent work running with an alarm behind it, and releases the environment's
   * memory once the agent is idle. Ordered with the idle-stop decision.
   */
  #reconcile(runtime: Runtime): Promise<void> {
    return this.#decide(async () => {
      // A deleted Session's harness makes no more decisions.
      if ((await this.#runtime) !== runtime) return;
      const { harness, conversation } = runtime.agent;
      const { tasks, scheduling } = await harness.inspect(context);
      const record = this.#record;
      if (scheduling === "closing" || record === undefined) return;
      if (tasks.length === 0 && !this.#busy && !record.deleting && record.operation === undefined) {
        runtime.environment.release();
      }
      const live =
        tasks.length === 0 || this.#hostWait !== undefined
          ? undefined
          : await harness.snapshot(LiveDoc, conversation.id, context);
      const now = Date.now();
      const alarm = nextAlarm({
        now,
        record,
        tasks: tasks.length,
        resumeAt: live?.generation?.deferred?.pollAt ?? live?.generation?.retry?.at,
        hostWait: this.#hostWait !== undefined,
      });
      if (alarm === undefined) await this.#ctx.storage.deleteAlarm();
      else await this.#ctx.storage.setAlarm(alarm);
      if (tasks.length === 0) return;
      this.#touch();
      harness.resume();
      const sleeping = alarm !== undefined && alarm > now + RECOVERY_MS;
      if (sleeping || this.#hostWait || tasks.every((task) => task.record.background)) return;
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(), HOST_WAIT_MS);
      this.#hostWait = conversation
        .waitForIdle(withAbortSignal(budget.signal, context))
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          clearTimeout(timer);
          this.#hostWait = undefined;
          this.#touch();
          this.#background(this.#reconcile(runtime));
        });
      this.#ctx.waitUntil(this.#hostWait);
    });
  }

  /**
   * Admits a prompt to Pi behind a queued start, so a stopped environment starts for it and its
   * run waits for that start and any setup before it. The recovery alarm is persisted first.
   */
  async #admit(
    runtime: Runtime,
    prompt: string,
    requestId: string,
    /** Set for a prompt from another thread, which the transcript shows as its message. */
    sender?: ThreadMessageData,
  ): Promise<void> {
    this.#touch();
    this.#background(
      this.#operate(runtime, async () => {
        const record = this.#record!;
        const { state } = record.environment;
        // A failed setup waits for the user's recovery action; the agent runs anyway and may fix it.
        if ((state === "stopped" || state === "stopping") && !hasFailure(record)) {
          await this.#starting(runtime);
        }
      }),
    );
    await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
    await runtime.agent.conversation.submit(
      {
        type: "input",
        content: prompt,
        requestId,
        // The user's prompts wait for the run to end; another thread's message steers the run.
        whenBusy: sender === undefined ? "followUp" : "steer",
        ...(sender === undefined
          ? {}
          : { entry: { kind: THREAD_MESSAGE_KIND, data: { ...sender } } }),
      },
      context,
    );
    await this.#reconcile(runtime);
  }

  /** Resolves once no environment operation is queued, or rejects when `context` is cancelled. */
  async #setupSettled(context: Context): Promise<void> {
    const signal = context.abortSignal;
    while (this.#queuedOperations > 0) {
      signal?.throwIfAborted();
      using listening = new DisposableStack();
      const cancelled = Promise.withResolvers<never>();
      const cancel = () => cancelled.reject(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      listening.defer(() => signal?.removeEventListener("abort", cancel));
      await Promise.race([this.#operations, cancelled.promise]);
    }
  }

  async #stopIfIdle(runtime: Runtime): Promise<void> {
    const decided = await this.#decide(async () => {
      const { tasks } = await runtime.agent.harness.inspect(context);
      if (tasks.some((task) => !task.record.background)) return undefined;
      // Setup, admission, and explicit control can change eligibility during the inspection.
      const record = this.#record;
      if (
        record?.environment.state !== "running" ||
        record.operation !== undefined ||
        this.#queuedOperations > 0 ||
        this.#hostWait !== undefined ||
        Date.now() - record.lastActivityAt < IDLE_STOP_MS
      )
        return undefined;
      // Queued while decisions are ordered; the potentially long drain runs outside them.
      return { stopping: this.#stopEnvironment(runtime) };
    });
    if (decided !== undefined) await tryAsync(decided.stopping, () => {});
  }

  /** Runs an environment operation after the ones before it; agent runs wait for the queue. */
  #operate<T>(runtime: Runtime, work: () => Promise<T>): Promise<T> {
    this.#queuedOperations++;
    const result = this.#operations.then(work);
    this.#operations = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.#queuedOperations--;
        this.#background(this.#reconcile(runtime));
      });
    return result;
  }

  /** Environment creation and start; then, with a project, its clone, branch, and setup. */
  #provision(runtime: Runtime): Promise<void> {
    return this.#operate(runtime, () => this.#provisioning(runtime));
  }

  async #provisioning(runtime: Runtime): Promise<void> {
    this.#update({ operationStage: "created" });
    await this.#setup(runtime, "provisioning", async (reporter, credentials) => {
      const record = this.#record!;
      reporter.stage("starting-vm");
      await this.#guard("The environment could not be created.", "retry-provisioning", () =>
        runtime.environment.create({ orbSize: record.orbSize }),
      );
      await this.#guard("The environment could not be started.", "retry-provisioning", () =>
        this.#control(runtime, "start", credentials),
      );
      if (runtime.project === undefined) {
        // Without a project /workspace starts empty and no project behaviour runs.
        await createWorkspace(runtime.environment.env, context);
        this.#update({ checkoutState: "available" });
        return;
      }
      const checkout = await runtime.project.provision(
        reporter,
        redactedValues(credentials),
        context,
      );
      this.#update({
        checkoutState: checkout.checkoutState,
        ...(checkout.baseCommit === undefined ? {} : { baseCommit: checkout.baseCommit }),
        issues: appendIssues(this.#record!.issues, checkout.issues),
      });
    });
    runtime.project?.scheduleRefresh(0);
  }

  #startEnvironment(runtime: Runtime, options: { restart?: boolean } = {}): Promise<void> {
    return this.#operate(runtime, () => this.#starting(runtime, options.restart));
  }

  /** Starts compute and, with a project, runs `.agents/resume` on an available checkout. */
  async #starting(runtime: Runtime, restart = false): Promise<void> {
    const record = this.#record!;
    if (record.checkoutState === "pending") return await this.#provisioning(runtime);
    if (record.environment.state === "running" && !restart && record.operation === undefined)
      return;
    await this.#setup(runtime, "resuming", async (reporter, credentials) => {
      reporter.stage("starting-vm");
      // Recovery restarts compute: re-provisioning would replace an available checkout.
      await this.#guard("The environment could not be started.", "restart-environment", () =>
        this.#control(runtime, restart ? "restart" : "start", credentials),
      );
      if (runtime.project === undefined || this.#record!.checkoutState !== "available") return;
      const issues = await runtime.project.resume(reporter, redactedValues(credentials), context);
      this.#update({ issues: appendIssues(this.#record!.issues, issues) });
    });
  }

  #stopEnvironment(runtime: Runtime): Promise<EnvironmentControlResult> {
    return this.#operate(runtime, async () => {
      // The final Git Snapshot is taken before compute stops; failure keeps the previous one.
      await runtime.project?.refresh();
      return await runtime.environment.control("stop");
    });
  }

  /** Runs provisioning or resume with its stages and logs published; failure becomes an issue. */
  async #setup(
    runtime: Runtime,
    operation: "provisioning" | "resuming",
    work: (reporter: ProvisioningReporter, credentials: EnvironmentCredentials) => Promise<void>,
  ): Promise<void> {
    this.#update({ operation });
    const reporter: ProvisioningReporter = {
      stage: (stage) => this.#update({ operationStage: stage }),
      // In the transcript; a failure also reaches the agent at its next boundary.
      output: async (outcome) => {
        await tryAsync(
          runtime.agent.conversation.submit(
            { type: "write", entry: setupEntry(outcome, Date.now()) },
            context,
          ),
          () => {},
        );
      },
    };
    const settle = (issues: readonly SessionIssue[]) => {
      const { operation: _operation, operationStage: _stage, ...settled } = this.#record!;
      this.#write({ ...settled, issues: appendIssues(settled.issues, issues) });
    };
    const [, failure] = await tryAsync(
      // Fetched once per operation, and only for a provider that receives them.
      (async () => await work(reporter, await this.#credentials(runtime)))(),
      (cause) => cause,
    );
    if (failure !== undefined) {
      settle([
        failure instanceof ProvisioningFailure
          ? failure.issue
          : sessionIssue({
              category: "vm-start",
              severity: "failure",
              message: failure instanceof Error ? failure.message : "Session setup failed.",
              recovery: operation === "provisioning" ? "retry-provisioning" : "restart-environment",
            }),
      ]);
      return;
    }
    settle([]);
  }

  /** Runs an infrastructure step whose failure becomes an issue with the given recovery. */
  async #guard(
    message: string,
    recovery: "retry-provisioning" | "restart-environment",
    action: () => Promise<void | EnvironmentControlResult>,
  ): Promise<void> {
    const [, failure] = await tryAsync(
      action(),
      (cause) =>
        new ProvisioningFailure(
          sessionIssue({
            category: "vm-start",
            severity: "failure",
            message,
            diagnostics: cause instanceof Error ? cause.message : undefined,
            recovery,
          }),
        ),
    );
    if (failure !== undefined) throw failure;
  }

  async #control(
    runtime: Runtime,
    action: "start" | "restart",
    credentials?: EnvironmentCredentials,
  ): Promise<EnvironmentControlResult> {
    const permitted = credentials ?? (await this.#credentials(runtime));
    this.#touch();
    const result = await runtime.environment.control(action, { credentials: permitted });
    // Retries a first load that failed or was interrupted; a loaded catalog is never rescanned.
    if (result.state === "running") this.#background(runtime.project?.loadSkills());
    return result;
  }

  /**
   * The Workspace credentials the provider receives (ADR 0006). Providers that receive none, such
   * as the Sandbox, cause no credential to be read or decrypted at all.
   */
  async #credentials(runtime: Runtime): Promise<EnvironmentCredentials> {
    const record = this.#record!;
    if (!receivesCredentials(runtime.capabilities, record.guestCredentialOptIn)) return {};
    const [githubToken, githubError] = await this.#workspace.getGitHubToken(record.workspaceId);
    if (githubError !== undefined) throw githubError;
    const [secrets, secretsError] = await this.#workspace.getEnvironmentSecrets(record.workspaceId);
    if (secretsError !== undefined) throw secretsError;
    return {
      ...(githubToken === null ? {} : { githubToken }),
      ...(secrets.length === 0 ? {} : { environmentSecrets: secrets }),
    };
  }

  async #publishMedia(env: ExecutionEnv, path: string, description: string): Promise<string> {
    const record = this.#record!;
    const used = Number(
      this.#ctx.storage.sql
        .exec("SELECT COALESCE(SUM(byte_length), 0) AS used FROM openorb_media")
        .toArray()[0]?.used ?? 0,
    );
    const published = await publishGuestMedia(
      env,
      this.#media,
      {
        path,
        prefix: mediaPrefix(record.workspaceId, record.sessionId),
        usedBytes: used,
      },
      context,
    );
    this.#ctx.storage.sql.exec(
      "INSERT INTO openorb_media (id, file_name, media_type, byte_length) VALUES (?, ?, ?, ?)",
      published.id,
      published.fileName,
      published.mediaType,
      published.byteLength,
    );
    const kind = published.mediaType.startsWith("image/") ? "image" : "video";
    const label = (description.trim() || published.fileName)
      .replaceAll("\\", "\\\\")
      .replaceAll("]", "\\]")
      .replaceAll("\n", " ");
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
      // The provider may be offline; the alarm retries until compute is gone.
      await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
      return;
    }
    await tryAsync(runtime.agent.harness.close(context), () => {});
    await this.#ctx.storage.deleteAlarm();
    await this.#ctx.storage.deleteAll();
    this.#record = undefined;
    this.#runtime = Promise.resolve(undefined);
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
            `event: session\ndata: ${JSON.stringify({
              type: "conversation.snapshot",
              view: delivered,
            })}\n\n`,
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
            await new Promise<void>((done) => (resume = done));
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
          // A viewer that cancelled the stream already stopped it, and its controller is closed.
          if (stopped) return;
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
    const { stage, agentState, environmentState, environmentReachable } = sessionView(
      record,
      this.#busy,
    );
    return {
      type: "session.state",
      stage,
      agentState,
      environmentState,
      environmentReachable,
      checkoutState: record.checkoutState,
      issues: [...record.issues],
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

  #decide<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#decisions.then(work);
    this.#decisions = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  #background(work: Promise<unknown> | undefined): void {
    if (work !== undefined)
      this.#ctx.waitUntil(
        work.then(
          () => {},
          () => {},
        ),
      );
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
