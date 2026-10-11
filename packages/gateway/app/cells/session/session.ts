import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import { type ConversationView, LiveDoc } from "@earendil-works/pi-durable";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { EnvLink, EnvLinkHandlers } from "@openorb/pi-env";
import {
  type EnvironmentAction,
  type EnvironmentState,
  GitAuthor,
  type OrbSize,
  type SessionEnvironmentRecoveryMode,
  SessionId,
  type ThinkingLevel,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import type { Env } from "../../env.ts";
import type { EnvironmentNotice } from "../runners/runner-registry.ts";
import type { WorkspaceApi } from "../workspace/api.ts";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import {
  type Agent,
  createAgentModels,
  effectiveThinkingLevel,
  openAgent,
  SessionError,
} from "./agent.ts";
import { tryAsync } from "@openorb/result";
import { WorkspaceCredentialStore } from "./credentials.ts";
import type { SessionEnvironment } from "./environment/provider.ts";
import {
  type EnvironmentLinkHost,
  type RunnerEnvironmentApi,
  runnerProvider,
} from "./environment/runner-provider.ts";

const context = BACKGROUND_CONTEXT;
/** Deadman alarm: a crash during startup or an alarm leaves another wake behind. */
const RECOVERY_MS = 30_000;
const IDLE_STOP_MS = 15 * 60_000;
const LINK_ATTACH_TIMEOUT_MS = 30_000;
const LINK_TAG = "link";
const ATTACH_REQUEST = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("attach"), token: Schema.String, nonce: Schema.String }),
);

export interface SessionWebSocket {
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: LinkAttachment): void;
  /** Returns what `serializeAttachment` stored; this object only stores link attachments. */
  deserializeAttachment(): LinkAttachment | null;
}

export interface SessionStorage extends DurableObjectSqliteStorage {
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
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
  readonly runnerId: string;
  readonly orbSize: OrbSize;
  readonly repositoryUrl: string;
  readonly branchName: string;
  readonly gitAuthor: { readonly name: string; readonly email: string };
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly initialPrompt?: string;
}

interface SessionRecord {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: string;
  readonly runnerId: string;
  readonly orbSize: OrbSize;
  readonly repositoryUrl: string;
  readonly branchName: string;
  readonly gitAuthor: GitAuthor;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly environmentState: EnvironmentState;
  readonly environmentReachable: boolean;
  readonly lastActivityAt: number;
  readonly deleting: boolean;
}

interface Runtime {
  readonly record: SessionRecord;
  readonly environment: SessionEnvironment;
  readonly agent: Agent;
}

type ConversationEvent =
  | { readonly type: "conversation.snapshot"; readonly view: ConversationView }
  | { readonly type: "conversation.ops"; readonly ops: readonly Op[] };

interface LinkAttachment {
  readonly phase: "pending" | "attached";
  readonly runnerId?: string;
}

type PendingLink = {
  readonly resolve: (link: EnvLink) => void;
  readonly reject: (error: Error) => void;
};

/**
 * One Session's agent: Pi Durable on this object's SQLite storage, reaching its Agent Environment
 * only through the provider's ExecutionEnv (ADRs 0005 and 0006). The session keeps running while
 * the runner is offline; guest tools then fail immediately.
 */
export class Session extends DurableObject<Env> {
  readonly #ctx: SessionContext;
  readonly #workspace: WorkspaceApi;
  readonly #runners: RunnerEnvironmentApi;
  #runtime: Promise<Runtime | undefined>;
  #record: SessionRecord | undefined;
  #routed: EnvLinkHandlers | undefined;
  readonly #pendingLinks = new Map<string, PendingLink>();
  #wakeTail: Promise<void> = Promise.resolve();
  #idle: Promise<void> | undefined;
  #admitting = 0;

  constructor(ctx: SessionContext, env: Env) {
    super(ctx, env);
    this.#ctx = ctx;
    // SAFETY: native RPC stubs implement these interfaces; platform thenables differ only in types.
    // deno-lint-ignore openorb/no-chained-type-assertions
    this.#workspace = env.WORKSPACE.getByName("workspace") as unknown as WorkspaceApi;
    // SAFETY: as above, for the Runners Durable Object's environment procedures.
    // deno-lint-ignore openorb/no-chained-type-assertions
    this.#runners = env.RUNNERS.getByName("runners") as unknown as RunnerEnvironmentApi;
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS openorb_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      record TEXT NOT NULL
    )`);
    // Link liveness answered by the platform, so an idle link never wakes this object.
    ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
    this.#record = this.#readRecord();
    this.#runtime = ctx.blockConcurrencyWhile(() => this.#open());
  }

  // --- Native RPC -------------------------------------------------------------------------------

  /** Creates the environment and agent once; repeating it with the same Session is harmless. */
  async create(input: CreateSessionInput): Promise<{ readonly created: boolean }> {
    const existing = await this.#runtime;
    if (existing !== undefined) return { created: false };
    const record: SessionRecord = {
      workspaceId: Schema.decodeUnknownSync(WorkspaceId)(input.workspaceId),
      sessionId: input.sessionId,
      runnerId: input.runnerId,
      orbSize: input.orbSize,
      repositoryUrl: input.repositoryUrl,
      branchName: input.branchName,
      gitAuthor: new GitAuthor(input.gitAuthor),
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      environmentState: "stopped",
      environmentReachable: true,
      lastActivityAt: Date.now(),
      deleting: false,
    };
    this.#writeRecord(record);
    this.#runtime = this.#open();
    const runtime = (await this.#runtime)!;
    await runtime.environment.create({ orbSize: input.orbSize });
    await this.#control(runtime, "start");
    // The checkout's parent must exist before the agent's first command; cloning comes later.
    await runtime.environment.env.createDir("/workspace", { recursive: true }, context);
    if (input.initialPrompt !== undefined) {
      await this.submit({ prompt: input.initialPrompt, requestId: input.sessionId });
    }
    return { created: true };
  }

  async submit(input: { prompt: string; requestId: string }): Promise<{ submissionId: number }> {
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
    const effective = effectiveThinkingLevel(runtime.agent.models, runtime.record.model, level);
    await runtime.agent.conversation.configure({ thinkingLevel: effective }, context);
    return effective;
  }

  async controlEnvironment(
    action: EnvironmentAction,
    recovery?: SessionEnvironmentRecoveryMode,
  ): Promise<{ state: EnvironmentState; forced: boolean }> {
    return await this.#control(await this.#required(), action, recovery);
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
      this.#updateRecord({
        environmentState: notice.environment.state,
        environmentReachable: true,
      });
      if (notice.environment.state !== "running" && notice.environment.state !== "starting") {
        this.#closeLinks(1000, "The environment is no longer running.");
      }
    } else if (notice.type === "removed") {
      this.#updateRecord({ environmentState: "stopped", environmentReachable: false });
      this.#closeLinks(1000, "The environment was removed.");
    } else if (notice.type === "unreachable") {
      // The link is independent of the control connection and may still be healthy.
      this.#updateRecord({ environmentReachable: false });
    } else {
      this.#updateRecord({ environmentReachable: false });
      this.#closeLinks(4401, "The runner was revoked.");
    }
    const runtime = await this.#runtime;
    if (runtime !== undefined) await this.#wake(runtime);
  }

  /** Deletes compute, then this object's storage. Retried by the alarm while the runner is away. */
  async delete(): Promise<void> {
    const runtime = await this.#runtime;
    if (runtime === undefined) return;
    this.#updateRecord({ deleting: true });
    await runtime.agent.conversation.abort(context, { background: true }).catch(() => {});
    await this.#finishDeletion(runtime);
  }

  // --- HTTP and WebSockets ----------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/link")) return this.#acceptLink(request);
    if (url.pathname.endsWith("/events")) return await this.#events(request);
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(socket: SessionWebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = linkAttachment(socket);
    if (attachment?.phase === "attached") {
      // Text messages are link control; `ping` is answered by the platform.
      if (message instanceof ArrayBuffer) this.#routed?.frame(new Uint8Array(message));
      return;
    }
    if (attachment?.phase !== "pending" || message instanceof ArrayBuffer) {
      socket.close(4400, "Expected an attach request.");
      return;
    }
    const request = Schema.decodeUnknownOption(ATTACH_REQUEST)(message);
    const pending = request._tag === "Some"
      ? this.#pendingLinks.get(request.value.nonce)
      : undefined;
    const record = this.#record;
    if (request._tag === "None" || pending === undefined || record === undefined) {
      socket.close(4401, "Unknown attach request.");
      return;
    }
    this.#pendingLinks.delete(request.value.nonce);
    const runner = await this.#workspace.authenticateRunner(request.value.token);
    if (runner?.id !== record.runnerId || runner.workspaceId !== record.workspaceId) {
      socket.close(4401, "The runner is not authorized for this session.");
      pending.reject(new Error("The runner failed link authentication."));
      return;
    }
    // One current link: a new attach replaces any previous one.
    for (const other of this.#ctx.getWebSockets(LINK_TAG)) {
      if (other !== socket && linkAttachment(other)?.phase === "attached") {
        other.close(1000, "Replaced by a newer link.");
      }
    }
    socket.serializeAttachment({ phase: "attached", runnerId: runner.id });
    socket.send("attached");
    pending.resolve(socketLink(socket));
  }

  webSocketClose(socket: SessionWebSocket, _code: number, reason: string): void {
    if (linkAttachment(socket)?.phase !== "attached") return;
    this.#routed?.closed(reason || "The Environment Link closed.");
  }

  webSocketError(socket: SessionWebSocket): void {
    this.webSocketClose(socket, 1011, "The Environment Link failed.");
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
    await this.#stopIfIdle(runtime);
    await this.#wake(runtime);
  }

  /** Model access with Workspace credentials; the only seam for scripted test models. */
  protected agentModels(credentials: CredentialStore): Models {
    return createAgentModels(credentials);
  }

  // --- Internals --------------------------------------------------------------------------------

  async #open(): Promise<Runtime | undefined> {
    const record = this.#record;
    if (record === undefined) return undefined;
    await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
    const environment = runnerProvider({
      runners: this.#runners,
      links: this.#links(),
      state: () => ({
        state: this.#record?.environmentState ?? "stopped",
        reachable: this.#record?.environmentReachable ?? false,
      }),
      recordState: (environmentState) => this.#updateRecord({ environmentState }),
    }).bind({
      workspaceId: record.workspaceId,
      sessionId: Schema.decodeUnknownSync(SessionId)(record.sessionId),
      placement: record.runnerId,
      repository: { url: record.repositoryUrl, gitAuthor: record.gitAuthor },
    });
    const agent = await openAgent(this.#ctx.storage, {
      sessionId: record.sessionId,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      repositoryUrl: record.repositoryUrl,
      branchName: record.branchName,
      models: this.agentModels(new WorkspaceCredentialStore(this.#workspace, record.workspaceId)),
      environment,
      controlEnvironment: async (action) => await this.#control(await this.#required(), action),
    }, context);
    const runtime: Runtime = { record, environment, agent };
    await this.#wake(runtime);
    return runtime;
  }

  async #required(): Promise<Runtime> {
    const runtime = await this.#runtime;
    if (runtime === undefined || this.#record?.deleting) {
      throw new SessionError("Session not found.");
    }
    return runtime;
  }

  async #control(
    runtime: Runtime,
    action: EnvironmentAction,
    recovery?: SessionEnvironmentRecoveryMode,
  ) {
    const record = this.#record ?? runtime.record;
    if (action === "stop") {
      return await runtime.environment.control("stop");
    }
    const [githubToken, githubError] = await this.#workspace.getGitHubToken(record.workspaceId);
    if (githubError !== undefined) throw githubError;
    const [secrets, secretsError] = await this.#workspace.getEnvironmentSecrets(
      record.workspaceId,
    );
    if (secretsError !== undefined) throw secretsError;
    this.#touch();
    return await runtime.environment.control(action, {
      credentials: {
        ...(githubToken === null ? {} : { githubToken }),
        ...(secrets.length === 0 ? {} : { environmentSecrets: secrets }),
      },
      ...(recovery === undefined ? {} : { recovery }),
    });
  }

  /** pi-celld's recovery loop: alarms renew bounded host waits until the durable work settles. */
  #wake(runtime: Runtime): Promise<void> {
    const wake = this.#wakeTail.then(async () => {
      const { harness, conversation } = runtime.agent;
      const { tasks, scheduling } = await harness.inspect(context);
      if (scheduling === "closing") return;
      const record = this.#record;
      if (tasks.length > 0) this.#touch();
      if (!tasks.length && !this.#admitting) {
        // Idle: wake only to stop compute once the idle period has passed.
        if (record?.environmentState === "running") {
          await this.#ctx.storage.setAlarm((record.lastActivityAt ?? Date.now()) + IDLE_STOP_MS);
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
        .catch(() => {})
        .finally(async () => {
          clearTimeout(timer);
          this.#idle = undefined;
          this.#touch();
          await this.#wake(runtime);
        });
      this.#ctx.waitUntil(this.#idle);
    });
    this.#wakeTail = wake.catch(() => {});
    return wake;
  }

  async #stopIfIdle(runtime: Runtime): Promise<void> {
    const record = this.#record;
    if (record?.environmentState !== "running" || this.#idle || this.#admitting) return;
    if (Date.now() - record.lastActivityAt < IDLE_STOP_MS) return;
    const { tasks } = await runtime.agent.harness.inspect(context);
    if (tasks.some((task) => !task.record.background)) return;
    await runtime.environment.control("stop").catch(() => {});
  }

  async #finishDeletion(runtime: Runtime): Promise<void> {
    const [, failure] = await tryAsync(runtime.environment.delete(), (cause) => cause);
    if (failure !== undefined) {
      // The runner may be offline; the alarm retries until compute is gone.
      await this.#ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
      return;
    }
    this.#closeLinks(1000, "The session was deleted.");
    await runtime.agent.harness.close(context).catch(() => {});
    await this.#ctx.storage.deleteAlarm();
    await this.#ctx.storage.deleteAll();
    this.#record = undefined;
    this.#runtime = Promise.resolve(undefined);
  }

  #links(): EnvironmentLinkHost {
    return {
      current: () => {
        const socket = this.#ctx.getWebSockets(LINK_TAG).find((candidate) =>
          linkAttachment(candidate)?.phase === "attached"
        );
        return socket === undefined ? undefined : socketLink(socket);
      },
      expect: (nonce, signal) =>
        new Promise<EnvLink>((resolve, reject) => {
          const timer = setTimeout(
            () => fail(new Error("The runner did not dial the link.")),
            LINK_ATTACH_TIMEOUT_MS,
          );
          const fail = (error: Error) => {
            clearTimeout(timer);
            this.#pendingLinks.delete(nonce);
            reject(error);
          };
          signal.addEventListener("abort", () => fail(new Error("Link attach cancelled.")), {
            once: true,
          });
          this.#pendingLinks.set(nonce, {
            resolve: (link) => {
              clearTimeout(timer);
              resolve(link);
            },
            reject: fail,
          });
        }),
      route: (handlers) => {
        this.#routed = handlers;
      },
    };
  }

  #acceptLink(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server: SessionWebSocket = pair[1];
    this.#ctx.acceptWebSocket(server, [LINK_TAG]);
    server.serializeAttachment({ phase: "pending" });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  #closeLinks(code: number, reason: string): void {
    for (const socket of this.#ctx.getWebSockets(LINK_TAG)) socket.close(code, reason);
    this.#routed?.closed(reason);
  }

  /** Conversation frames as Server-Sent Events: a snapshot, then structural operations. */
  async #events(request: Request): Promise<Response> {
    const runtime = await this.#required();
    const watch = await runtime.agent.conversation.watch(context);
    const encoder = new TextEncoder();
    let cleanup = () => {};
    let resume = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let stopped = false;
        const send = (event: ConversationEvent) =>
          controller.enqueue(encoder.encode(`event: session\ndata: ${JSON.stringify(event)}\n\n`));
        send({ type: "conversation.snapshot", view: watch.value });
        watch.start(async (_value: unknown, ops: readonly Op[]) => {
          // Pi bounds pending frames and replaces them with a snapshot on overflow.
          while (!stopped && (controller.desiredSize ?? 0) <= 0) {
            await new Promise<void>((done) => resume = done);
          }
          if (!stopped) send({ type: "conversation.ops", ops });
        });
        const heartbeat = setInterval(() => {
          if (!stopped && (controller.desiredSize ?? 0) > 0) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          }
        }, 15_000);
        cleanup = () => {
          if (stopped) return;
          stopped = true;
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

  #touch(): void {
    this.#updateRecord({ lastActivityAt: Date.now() });
  }

  #readRecord(): SessionRecord | undefined {
    const row = this.#ctx.storage.sql.exec("SELECT record FROM openorb_session WHERE id = 1")
      .toArray()[0];
    if (row === undefined) return undefined;
    const parsed = JSON.parse(String(row.record));
    return {
      ...parsed,
      workspaceId: Schema.decodeUnknownSync(WorkspaceId)(parsed.workspaceId),
      gitAuthor: new GitAuthor(parsed.gitAuthor),
    };
  }

  #writeRecord(record: SessionRecord): void {
    this.#record = record;
    this.#ctx.storage.sql.exec(
      "INSERT INTO openorb_session (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record",
      JSON.stringify(record),
    );
  }

  #updateRecord(update: Partial<SessionRecord>): void {
    if (this.#record === undefined) return;
    this.#writeRecord({ ...this.#record, ...update });
  }
}

function linkAttachment(socket: SessionWebSocket): LinkAttachment | undefined {
  return socket.deserializeAttachment() ?? undefined;
}

function socketLink(socket: SessionWebSocket): EnvLink {
  return {
    send: (frame) => socket.send(frame),
    close: () => socket.close(1000, "The session closed the link."),
  };
}
