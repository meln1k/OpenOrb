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
import type { EnvironmentProviderKind } from "./environment/provider.ts";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

/** Project, environment, and lifecycle facts the Session Durable Object owns (ADR 0006). */
export interface SessionRecord {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly initialPromptPreview: string;
  /** Resolved once at creation; the Session keeps its provider for its lifetime. */
  readonly environmentProvider: EnvironmentProviderKind;
  /** The Project's Guest Credential Opt-in at creation; only unmediated providers consult it. */
  readonly guestCredentialOptIn: boolean;
  /** The provider placement: the runner that owns this Session's root disk. */
  readonly runnerId: string;
  readonly orbSize: OrbSize;
  readonly repositoryUrl: string;
  readonly ref: string;
  readonly branchName: string;
  readonly gitAuthor: GitAuthor;
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
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS openorb_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    record TEXT NOT NULL
  )`);
  const row = storage.sql.exec("SELECT record FROM openorb_session WHERE id = 1").toArray()[0];
  if (row === undefined) return undefined;
  const parsed = JSON.parse(String(row.record));
  return {
    ...parsed,
    workspaceId: Schema.decodeUnknownSync(WorkspaceId)(parsed.workspaceId),
    gitAuthor: new GitAuthor(parsed.gitAuthor),
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
    projectId: Schema.decodeUnknownSync(RunnerSessionSnapshot.fields.projectId)(record.projectId),
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
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS openorb_git_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot TEXT NOT NULL
  )`);
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
