import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { v5 } from "@jsr/std__uuid";
import { SESSION_THINKING_LEVELS, type SessionThinkingLevel } from "@openorb/protocol";
import type { WorkspaceApi } from "../../workspace/api.ts";
import { SessionError } from "../agent.ts";
import type { PeerThreadStatus, SessionPeer, ThreadContext } from "../api.ts";
import { isSafeGitReference } from "../git-snapshot-schema.ts";
import { type SessionProject, type SessionRecord, sessionView } from "../record.ts";
import { startSession } from "../start.ts";
import { pastedSessionIds, referencedSessionId } from "./references.ts";
import type { Threads, ThreadStatus } from "./tools.ts";
import { recentMessages } from "./transcript.ts";

/** How another Session relates to this one (ADR 0010). */
export type ThreadRelation = "parent" | "child" | "referenced";
type Ability = "read" | "message";

/** What each relation permits; every other Session is out of reach. */
const PERMITTED = {
  read: ["child", "referenced"],
  message: ["parent", "child"],
} as const satisfies Record<Ability, readonly ThreadRelation[]>;

const UNREACHABLE = {
  read: "Thread not found or not readable: a thread can read only its child threads and threads whose URL the user pasted into a prompt.",
  message:
    "Thread not found or not reachable: send_thread_message reaches only this thread's parent and child threads.",
} as const satisfies Record<Ability, string>;

export interface ThreadHostOptions {
  readonly storage: Pick<DurableObjectSqliteStorage, "sql">;
  readonly workspace: Pick<
    WorkspaceApi,
    "getSessionCatalogEntry" | "addSessionCatalogEntry" | "deleteSessionCatalogEntry"
  >;
  /** The Session's record; only read once the Session exists. */
  readonly record: () => SessionRecord;
  /** Another Session Durable Object of this gateway. */
  readonly peer: (sessionId: string) => SessionPeer;
}

/**
 * One Session's side of Session-to-Session work (ADR 0010): which Sessions it may reach, the
 * thread tools' operations, and creating its Child Sessions. Access is recorded in this Session's
 * own `openorb_thread_access` table, and its parent in its record.
 */
export class ThreadHost implements Threads {
  readonly #options: ThreadHostOptions;

  constructor(options: ThreadHostOptions) {
    this.#options = options;
  }

  get sessionId(): string {
    return this.#options.record().sessionId;
  }

  get parentSessionId(): string | undefined {
    return this.#options.record().parentSessionId;
  }

  /**
   * Records the Sessions whose URL the user pasted as readable. Call it only for prompts the user
   * wrote, never for messages from other Sessions, so no agent can grant itself access.
   */
  grantPastedSessions(prompt: string): void {
    for (const id of pastedSessionIds(prompt)) {
      if (id === this.sessionId) continue;
      this.#options.storage.sql.exec(
        "INSERT INTO openorb_thread_access (session_id, relation) VALUES (?, 'referenced') ON CONFLICT (session_id) DO NOTHING",
        id,
      );
    }
  }

  /** How a Session that messages this one relates to it; any other sender is not found. */
  sender(sessionId: string): "parent" | "child" {
    for (const relation of this.#relations(sessionId)) {
      if (relation === "parent" || relation === "child") return relation;
    }
    throw new SessionError("Thread not found.");
  }

  /**
   * Starts a Child Session with this Session's project, placement, model, and thinking level. Its
   * ID derives from the tool call, so a repeated call starts the same child once.
   */
  async create(
    prompt: string,
    options: { readonly callId: string; readonly thinkingLevel: ModelThinkingLevel },
  ): Promise<string> {
    const record = this.#options.record();
    if (record.parentSessionId !== undefined) {
      throw new SessionError("A child thread cannot start threads.");
    }
    const sessionId = await v5.generate(
      record.sessionId,
      new TextEncoder().encode(`create_thread\n${options.callId}`),
    );
    // Recorded first, so a child that may have started stays reachable from here.
    this.#options.storage.sql.exec(
      "INSERT INTO openorb_thread_access (session_id, relation) VALUES (?, 'child') ON CONFLICT (session_id) DO UPDATE SET relation = 'child'",
      sessionId,
    );
    const [, error] = await startSession(this.#options.workspace, this.#options.peer(sessionId), {
      workspaceId: record.workspaceId,
      sessionId,
      ...(record.project === undefined ? {} : { project: childProject(record.project, sessionId) }),
      createdAt: new Date().toISOString(),
      placement: record.placement,
      guestCredentialOptIn: record.guestCredentialOptIn,
      orbSize: record.orbSize,
      model: record.model,
      thinkingLevel: sessionThinkingLevel(options.thinkingLevel) ?? record.initialThinkingLevel,
      // The child labels it for its model, and names itself in the sidebar by what it says.
      initialPrompt: prompt,
      origin: { kind: "parent", sessionId: record.sessionId, title: record.initialPromptPreview },
    });
    if (error !== undefined) {
      if (!error.kept) {
        this.#options.storage.sql.exec(
          "DELETE FROM openorb_thread_access WHERE session_id = ?",
          sessionId,
        );
      }
      throw new SessionError(
        error.kept
          ? `Child thread ${sessionId} may not have started: ${error.message}`
          : `The child thread could not be started: ${error.message}`,
      );
    }
    return sessionId;
  }

  async send(thread: string, message: string, callId: string): Promise<string> {
    const { id, relation, peer } = await this.#reach(thread, "message");
    await peer.receiveThreadMessage({
      workspaceId: this.#options.record().workspaceId,
      fromSessionId: this.sessionId,
      fromTitle: this.#options.record().initialPromptPreview,
      message,
      // Stable per tool call, so the recipient admits a repeated delivery once.
      requestId: `thread-${await v5.generate(this.sessionId, new TextEncoder().encode(`send_thread_message\n${callId}`))}`,
    });
    return `Sent to ${relation} thread ${id}.`;
  }

  async status(thread: string): Promise<ThreadStatus> {
    const { relation, peer } = await this.#reach(thread, "read");
    const status = await peer.threadStatus({ workspaceId: this.#options.record().workspaceId });
    // PERMITTED.read admits only these two relations.
    return { ...status, relation: relation === "child" ? "child" : "referenced" };
  }

  async transcript(thread: string, scope: ThreadContext): Promise<string> {
    const { peer } = await this.#reach(thread, "read");
    return await peer.threadTranscript({ workspaceId: this.#options.record().workspaceId, scope });
  }

  /** The named Session, if this one may use `ability` on it and it is still in the catalog. */
  async #reach(reference: string, ability: Ability) {
    const record = this.#options.record();
    const id = referencedSessionId(reference);
    if (id === undefined) throw new SessionError("Name the thread by its ID or URL.");
    if (id === record.sessionId) throw new SessionError("That is this thread.");
    // A child's parent may also be pasted by the user, which makes it readable.
    const relation = this.#relations(id).find((held) =>
      PERMITTED[ability].some((permitted) => permitted === held),
    );
    if (relation === undefined) throw new SessionError(UNREACHABLE[ability]);
    if ((await this.#options.workspace.getSessionCatalogEntry(record.workspaceId, id)) === null) {
      throw new SessionError("Thread not found.");
    }
    return { id, relation, peer: this.#options.peer(id) };
  }

  /** Every way another Session relates to this one: its parent may also be referenced. */
  #relations(sessionId: string): ThreadRelation[] {
    const row = this.#options.storage.sql
      .exec("SELECT relation FROM openorb_thread_access WHERE session_id = ?", sessionId)
      .toArray()[0];
    const relations: ThreadRelation[] = sessionId === this.parentSessionId ? ["parent"] : [];
    const recorded = row?.relation;
    if (recorded === "child" || recorded === "referenced") relations.push(recorded);
    return relations;
  }
}

/** What this Session reports to another Session's get_thread_status. */
export function peerThreadStatus(
  record: SessionRecord,
  busy: boolean,
  messages: readonly Message[],
): PeerThreadStatus {
  const { state, agentState, environmentState } = sessionView(record, busy);
  return {
    sessionId: record.sessionId,
    state,
    agentState,
    environmentState,
    createdAt: record.createdAt,
    initialPromptPreview: record.initialPromptPreview,
    recentMessages: recentMessages(messages),
  };
}

/** A Child Session's branch: its parent's, suffixed so siblings never share one. */
export function childBranchName(parentBranch: string, childSessionId: string): string {
  const suffix = `-child-${childSessionId.slice(0, 8)}`;
  const branch = `${parentBranch.slice(0, 255 - suffix.length)}${suffix}`;
  if (!isSafeGitReference(branch)) {
    throw new SessionError("The child thread's branch name would be invalid.");
  }
  return branch;
}

/** The parent's project on the child's branch, as plain data: GitAuthor cannot cross RPC. */
function childProject(project: SessionProject, childSessionId: string) {
  return {
    id: project.id,
    repositoryUrl: project.repositoryUrl,
    ref: project.ref,
    branchName: childBranchName(project.branchName, childSessionId),
    gitAuthor: { name: project.gitAuthor.name, email: project.gitAuthor.email },
  };
}

function sessionThinkingLevel(level: ModelThinkingLevel): SessionThinkingLevel | undefined {
  return SESSION_THINKING_LEVELS.find((candidate) => candidate === level);
}
