import type { SessionThinkingLevel as ThinkingLevel } from "@openorb/protocol";
import type { EnvironmentState } from "@openorb/protocol/runner-api";
import type { GitPatchChunk } from "./git-snapshot.ts";
import type {
  SessionGitFileAction,
  SessionGitPatchSection,
  SessionGitSnapshot,
} from "./git-snapshot-schema.ts";
import type { CreateSessionInput, SessionMedia } from "./session.ts";
import type { SessionView } from "./view.ts";

export type { CreateSessionInput, SessionMedia } from "./session.ts";

/** The Session Durable Object's native RPC surface used by browser routes. */
export interface SessionApi {
  create(input: CreateSessionInput): Promise<{ readonly created: boolean }>;
  /** The view browser pages render; null once the Session is deleted. */
  view(): Promise<SessionView | null>;
  submit(input: {
    prompt: string;
    requestId: string;
    thinkingLevel?: ThinkingLevel;
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
