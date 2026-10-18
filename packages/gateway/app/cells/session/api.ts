import type { SessionThinkingLevel as ThinkingLevel } from "@openorb/protocol";
import type { EnvironmentState } from "@openorb/protocol/runner-api";
import type { GitPatchChunk } from "./git-snapshot.ts";
import type {
  SessionGitFileAction,
  SessionGitPatchSection,
  SessionGitSnapshot,
} from "./git-snapshot-schema.ts";
import type { CreateSessionInput, SessionMedia, UserOrigin } from "./session.ts";
import type { AgentState, SessionState, SessionView } from "./view.ts";

export type { CreateSessionInput, SessionMedia, SessionOrigin, UserOrigin } from "./session.ts";

/** The Session Durable Object's native RPC surface used by browser routes. */
export interface SessionApi {
  create(input: CreateSessionInput): Promise<{ readonly created: boolean }>;
  /** The view browser pages render; null once the Session is deleted. */
  view(): Promise<SessionView | null>;
  submit(input: {
    prompt: string;
    requestId: string;
    thinkingLevel?: ThinkingLevel;
    /** Only the user's own prompts grant access to the Sessions they paste (ADR 0010). */
    origin: UserOrigin;
  }): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel>;
  abort(): Promise<void>;
  stop(): Promise<{ state: EnvironmentState; forced: boolean }>;
  wake(): Promise<void>;
  retry(recovery: "retry-provisioning" | "restart-environment"): Promise<void>;
  delete(): Promise<void>;
  media(id: string): Promise<SessionMedia | null>;
  gitSnapshot(): Promise<SessionGitSnapshot>;
  gitPatchChunk(input: {
    snapshotId: string;
    section: SessionGitPatchSection;
    offset: number;
  }): Promise<GitPatchChunk>;
  updateGitFile(input: {
    action: SessionGitFileAction;
    path: string;
    previousPath?: string;
  }): Promise<{ mutationRevision: number }>;
  /** Conversation and session events as Server-Sent Events. */
  events(request: Request): Promise<Response>;
}

/** The native RPC methods; the event stream uses HTTP, as celld requires. */
export type SessionRpc = Omit<SessionApi, "events">;

/** Forwards each method to the stub, whose results are plain objects that survive RPC. */
export function sessionApiFromRpc(
  rpc: SessionRpc,
  events: (request: Request) => Promise<Response>,
): SessionApi {
  return {
    create: (input) => rpc.create(input),
    view: () => rpc.view(),
    submit: (input) => rpc.submit(input),
    setThinkingLevel: (level) => rpc.setThinkingLevel(level),
    abort: () => rpc.abort(),
    stop: () => rpc.stop(),
    wake: () => rpc.wake(),
    retry: (recovery) => rpc.retry(recovery),
    delete: () => rpc.delete(),
    media: (id) => rpc.media(id),
    gitSnapshot: () => rpc.gitSnapshot(),
    gitPatchChunk: (input) => rpc.gitPatchChunk(input),
    updateGitFile: (input) => rpc.updateGitFile(input),
    events,
  };
}

/** Reads published media objects; R2 implements it. */
export interface MediaReader {
  get(
    key: string,
    options: { range: { offset: number; length: number } },
  ): Promise<{ readonly body: ReadableStream<Uint8Array> } | null>;
}

/** Resolves a Session Durable Object by its gateway-generated identifier. */
export type SessionDirectory = (sessionId: string) => SessionApi;

/** Which transcript read_thread reads: the active context window or the whole history. */
export type ThreadContext = "current" | "full";

/** What a Session reports to another Session's get_thread_status (ADR 0010). */
export interface PeerThreadStatus {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly agentState: AgentState;
  readonly environmentState: EnvironmentState;
  readonly createdAt: string;
  readonly initialPromptPreview: string;
  /** The newest user and assistant messages, shortened. */
  readonly recentMessages: readonly string[];
}

/**
 * The native RPC one Session Durable Object calls on another (ADR 0010). The calling Session checks
 * its own access first; the target checks the Workspace and, for messages, the relation again.
 */
export interface SessionPeer extends Pick<SessionRpc, "create" | "view"> {
  threadStatus(input: { readonly workspaceId: string }): Promise<PeerThreadStatus>;
  threadTranscript(input: {
    readonly workspaceId: string;
    readonly scope: ThreadContext;
  }): Promise<string>;
  receiveThreadMessage(input: {
    readonly workspaceId: string;
    readonly fromSessionId: string;
    /** The sender's Initial Prompt Preview, which the recipient's transcript names it by. */
    readonly fromTitle: string;
    readonly message: string;
    readonly requestId: string;
  }): Promise<void>;
}
