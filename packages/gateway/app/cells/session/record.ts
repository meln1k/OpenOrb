import type { EnvironmentPlacement, EnvironmentStatus } from "@openorb/environments";
import type { SessionThinkingLevel } from "@openorb/protocol";
import { GitAuthor, type OrbSize, WorkspaceId } from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import { SessionGitSnapshot } from "./git-snapshot-schema.ts";
import type {
  AgentState,
  CheckoutState,
  SessionIssue,
  SessionProvisioningStage,
  SessionState,
  SessionView,
} from "./view.ts";
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
  readonly placement: EnvironmentPlacement;
  /** The Project's Guest Credential Opt-in at creation; only unmediated providers consult it. */
  readonly guestCredentialOptIn: boolean;
  readonly orbSize: OrbSize;
  readonly model: string;
  readonly initialThinkingLevel: SessionThinkingLevel;
  readonly environment: EnvironmentStatus;
  readonly checkoutState: CheckoutState;
  readonly baseCommit?: string;
  readonly issues: readonly SessionIssue[];
  /** Set while provisioning or resume runs; an eviction restarts it. */
  readonly operation?: "provisioning" | "resuming";
  readonly operationStage?: SessionProvisioningStage;
  /** Counts accepted stage/unstage requests so viewers can order snapshots after them. */
  readonly gitMutationRevision: number;
  readonly lastActivityAt: number;
  readonly deleting: boolean;
}

export function readRecord(storage: DurableObjectSqliteStorage): SessionRecord | undefined {
  const row = storage.sql.exec("SELECT record FROM openorb_session WHERE id = 1").toArray()[0];
  if (row === undefined) return undefined;
  const parsed = JSON.parse(String(row.record));
  return {
    ...parsed,
    ...(parsed.project === undefined
      ? {}
      : { project: { ...parsed.project, gitAuthor: new GitAuthor(parsed.project.gitAuthor) } }),
    workspaceId: Schema.decodeUnknownSync(WorkspaceId)(parsed.workspaceId),
  };
}

export function writeRecord(storage: DurableObjectSqliteStorage, record: SessionRecord): void {
  storage.sql.exec(
    "INSERT INTO openorb_session (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record",
    JSON.stringify(record),
  );
}

export function hasFailure(record: SessionRecord): boolean {
  return record.issues.some((issue) => issue.severity === "failure");
}

/** What viewers see of a Session's lifecycle. */
export function sessionView(record: SessionRecord, busy: boolean) {
  const { state: environmentState, reachable: environmentReachable } = record.environment;
  const agentState: AgentState = busy ? "running" : "idle";
  const stage: SessionProvisioningStage =
    record.operationStage ??
    {
      starting: "starting-vm" as const,
      stopping: "stopping" as const,
      stopped: "stopped" as const,
      error: "failed" as const,
      running: busy ? ("running" as const) : ("ready" as const),
    }[environmentState];
  const state: SessionState =
    hasFailure(record) || environmentState === "error"
      ? "error"
      : record.operation !== undefined || environmentState === "starting"
        ? "provisioning"
        : busy
          ? "running"
          : environmentState === "stopped"
            ? "stopped"
            : "ready";
  return { agentState, environmentState, environmentReachable, stage, state };
}

/** The view browser pages render. */
export function sessionSnapshot(record: SessionRecord, busy: boolean): SessionView {
  const { agentState, environmentState, environmentReachable, state } = sessionView(record, busy);
  return {
    id: record.sessionId,
    ...(record.project === undefined ? {} : { projectId: record.project.id }),
    createdAt: record.createdAt,
    initialPromptPreview: record.initialPromptPreview,
    model: record.model,
    initialThinkingLevel: record.initialThinkingLevel,
    orbSize: record.orbSize,
    state,
    agentState,
    environmentState,
    environmentReachable,
    issues: record.issues,
  };
}

/** The latest Git Snapshot summary; full patches stay in the guest (ADR 0006). */
export function readGitSnapshot(
  storage: DurableObjectSqliteStorage,
): SessionGitSnapshot | undefined {
  const row = storage.sql
    .exec("SELECT snapshot FROM openorb_git_snapshot WHERE id = 1")
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
