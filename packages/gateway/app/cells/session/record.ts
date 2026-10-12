import {
  type AgentState,
  type EnvironmentState,
  GitAuthor,
  GitMutationRevision,
  type OrbSize,
  type RunnerCheckoutState,
  RunnerSessionSnapshot,
  type RunnerSessionState,
  SessionGitSnapshot,
  type SessionIssue,
  type SessionProvisioningStage,
  type ThinkingLevel,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import type { SessionPlacement } from "./environment/provider.ts";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

/**
 * The project a Session works on: the repository its Project Checkout is cloned from and the
 * session branch. Only a Session with a project loads Git integration (ADR 0007).
 */
export interface SessionProject {
  readonly id: string;
  readonly repositoryUrl: string;
  readonly ref: string;
  readonly branchName: string;
  /** The Git identity of the user who started the Session, for its commits. */
  readonly gitAuthor: GitAuthor;
}

/** Project, environment, and lifecycle facts the Session Durable Object owns (ADR 0006). */
export interface SessionRecord {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: string;
  /** Absent for a Session without a project: /workspace starts empty and Git is not loaded. */
  readonly project?: SessionProject;
  readonly createdAt: string;
  readonly initialPromptPreview: string;
  /** Chosen at creation; the Session keeps its provider and placement for its lifetime. */
  readonly placement: SessionPlacement;
  /** The Project's Guest Credential Opt-in at creation; only unmediated providers consult it. */
  readonly guestCredentialOptIn: boolean;
  readonly orbSize: OrbSize;
  readonly model: string;
  readonly initialThinkingLevel: ThinkingLevel;
  readonly environmentState: EnvironmentState;
  readonly environmentReachable: boolean;
  readonly checkoutState: RunnerCheckoutState;
  readonly baseCommit?: string;
  readonly issues: readonly SessionIssue[];
  /** Set while provisioning or resume runs; guest tools wait for it to finish. */
  readonly operation?: "provisioning" | "resuming";
  readonly operationStage?: SessionProvisioningStage;
  /** Stop Session paused the agent recoverably; Wake or a prompt resumes it. */
  readonly agentPaused: boolean;
  /** Counts accepted stage/unstage requests so viewers can order snapshots after them. */
  readonly gitMutationRevision: number;
  readonly lastActivityAt: number;
  readonly deleting: boolean;
}

export function readRecord(storage: DurableObjectSqliteStorage): SessionRecord | undefined {
  const row = storage.sql.exec("SELECT record FROM openorb_session WHERE id = 1").toArray()[0];
  if (row === undefined) return undefined;
  const {
    environmentProvider: _provider,
    runnerId,
    projectId,
    repositoryUrl,
    ref,
    branchName,
    gitAuthor,
    ...parsed
  } = JSON.parse(String(row.record));
  return {
    ...parsed,
    // Records written before placements were runner Sessions with a separate `runnerId`, and
    // before optional projects every Session had flat project fields.
    placement: parsed.placement ??
      { provider: "runner", runnerId: Schema.decodeUnknownSync(Schema.String)(runnerId) },
    ...(parsed.project !== undefined
      ? { project: { ...parsed.project, gitAuthor: new GitAuthor(parsed.project.gitAuthor) } }
      : projectId !== undefined
      ? {
        project: {
          id: projectId,
          repositoryUrl,
          ref,
          branchName,
          gitAuthor: new GitAuthor(gitAuthor),
        },
      }
      : {}),
    workspaceId: Schema.decodeUnknownSync(WorkspaceId)(parsed.workspaceId),
  };
}

export function writeRecord(storage: DurableObjectSqliteStorage, record: SessionRecord): void {
  storage.sql.exec(
    "INSERT INTO openorb_session (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record",
    JSON.stringify(record),
  );
}

export function agentState(record: SessionRecord, busy: boolean): AgentState {
  if (record.agentPaused) return "paused";
  return busy ? "running" : "idle";
}

export function sessionStage(record: SessionRecord, busy: boolean): SessionProvisioningStage {
  if (record.operationStage !== undefined) return record.operationStage;
  switch (record.environmentState) {
    case "starting":
      return "starting-vm";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "error":
      return "failed";
    case "running":
      return busy ? "running" : "ready";
  }
}

export function publicState(record: SessionRecord, busy: boolean): RunnerSessionState {
  const agent = agentState(record, busy);
  if (record.issues.some((issue) => issue.severity === "failure")) return "error";
  if (record.environmentState === "error") return "error";
  if (agent === "running") return "running";
  if (record.operation !== undefined || record.environmentState === "starting") {
    return "provisioning";
  }
  return record.environmentState === "stopped" ? "stopped" : "ready";
}

/** The view browser pages render; unchanged in shape from the runner-hosted sessions. */
export function sessionSnapshot(record: SessionRecord, busy: boolean): RunnerSessionSnapshot {
  return new RunnerSessionSnapshot({
    id: Schema.decodeUnknownSync(RunnerSessionSnapshot.fields.id)(record.sessionId),
    ...(record.project === undefined ? {} : {
      projectId: Schema.decodeUnknownSync(RunnerSessionSnapshot.fields.projectId)(
        record.project.id,
      ),
    }),
    createdAt: record.createdAt,
    initialPromptPreview: record.initialPromptPreview,
    model: record.model,
    initialThinkingLevel: record.initialThinkingLevel,
    orbSize: record.orbSize,
    state: publicState(record, busy),
    agentState: agentState(record, busy),
    environmentState: record.environmentState,
    issues: [...record.issues],
  });
}

/** The latest Git Snapshot summary; full patches stay in the guest (ADR 0006). */
export function readGitSnapshot(
  storage: DurableObjectSqliteStorage,
): SessionGitSnapshot | undefined {
  const row = storage.sql.exec("SELECT snapshot FROM openorb_git_snapshot WHERE id = 1")
    .toArray()[0];
  return row === undefined
    ? undefined
    : Schema.decodeUnknownSync(Schema.fromJsonString(SessionGitSnapshot))(String(row.snapshot));
}

export function writeGitSnapshot(
  storage: DurableObjectSqliteStorage,
  snapshot: SessionGitSnapshot,
): void {
  storage.sql.exec(
    "INSERT INTO openorb_git_snapshot (id, snapshot) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot",
    Schema.encodeSync(Schema.fromJsonString(SessionGitSnapshot))(snapshot),
  );
}

export function gitMutationRevision(record: SessionRecord): GitMutationRevision {
  return GitMutationRevision.make(record.gitMutationRevision);
}
