import {
  type EnvironmentState,
  RunnerSessionSnapshot,
  type SessionEnvironmentRecoveryMode,
  type SessionGitFileAction,
  SessionGitSnapshot,
  type ThinkingLevel,
} from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import type { SessionGitPatchSection } from "@openorb/protocol/runner-bulk-api";
import type { GitPatchChunk } from "./git-snapshot.ts";
import type { CreateSessionInput, SessionMedia, SessionView } from "./session.ts";

export type { CreateSessionInput, SessionMedia, SessionView } from "./session.ts";

/** The Session Durable Object's native RPC surface used by browser routes. */
export interface SessionApi {
  create(input: CreateSessionInput): Promise<{ readonly created: boolean }>;
  view(): Promise<SessionView | null>;
  submit(
    input: { prompt: string; requestId: string; thinkingLevel?: ThinkingLevel },
  ): Promise<{ submissionId: number }>;
  setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel>;
  abort(): Promise<void>;
  stop(): Promise<{ state: EnvironmentState; forced: boolean }>;
  wake(recovery?: SessionEnvironmentRecoveryMode): Promise<void>;
  retry(recovery: "retry-provisioning" | "restart-environment"): Promise<void>;
  delete(): Promise<void>;
  media(id: string): Promise<SessionMedia | null>;
  gitSnapshot(): Promise<SessionGitSnapshot>;
  gitPatchChunk(
    input: { snapshotId: string; section: SessionGitPatchSection; offset: number },
  ): Promise<GitPatchChunk>;
  updateGitFile(
    input: { action: SessionGitFileAction; path: string; previousPath?: string },
  ): Promise<{ mutationRevision: number }>;
  /** Conversation and session events as Server-Sent Events. */
  events(request: Request): Promise<Response>;
}

/**
 * The Session Durable Object's wire surface. Native RPC structured-clones results, which drops
 * Schema classes, so their encoded forms cross and `decodeSessionRpc` restores them.
 */
export interface SessionRpc extends Omit<SessionApi, "view" | "gitSnapshot"> {
  view(): Promise<EncodedSessionView | null>;
  gitSnapshot(): Promise<(typeof SessionGitSnapshot)["Encoded"]>;
}

export interface EncodedSessionView {
  readonly runnerId: string;
  readonly snapshot: (typeof RunnerSessionSnapshot)["Encoded"];
}

export function encodeSessionView(view: SessionView): EncodedSessionView {
  return {
    runnerId: view.runnerId,
    snapshot: Schema.encodeSync(RunnerSessionSnapshot)(view.snapshot),
  };
}

export function encodeGitSnapshot(
  snapshot: SessionGitSnapshot,
): (typeof SessionGitSnapshot)["Encoded"] {
  return Schema.encodeSync(SessionGitSnapshot)(snapshot);
}

/** The browser-facing API over a Session's wire surface. */
export function decodeSessionRpc(
  rpc: SessionRpc,
  events: (request: Request) => Promise<Response>,
): SessionApi {
  return {
    create: (input) => rpc.create(input),
    view: async () => {
      const view = await rpc.view();
      return view === null ? null : {
        runnerId: view.runnerId,
        snapshot: Schema.decodeUnknownSync(RunnerSessionSnapshot)(view.snapshot),
      };
    },
    submit: (input) => rpc.submit(input),
    setThinkingLevel: (level) => rpc.setThinkingLevel(level),
    abort: () => rpc.abort(),
    stop: () => rpc.stop(),
    wake: (recovery) => rpc.wake(recovery),
    retry: (recovery) => rpc.retry(recovery),
    delete: () => rpc.delete(),
    media: (id) => rpc.media(id),
    gitSnapshot: async () => Schema.decodeUnknownSync(SessionGitSnapshot)(await rpc.gitSnapshot()),
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
