/**
 * What browser pages see of a Session. Plain types: the Session Durable Object produces these
 * values and the browser renders them, so nothing in between decodes them again.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Op } from "@earendil-works/chord/delta";
import type { SessionThinkingLevel } from "@openorb/protocol";
import type { EnvironmentState, OrbSize } from "@openorb/protocol/runner-api";

export type { ConversationView, EnvironmentState, Op };

export const MAX_SESSION_ISSUES = 16;
/** Bounds an issue's diagnostics and a setup step's recorded output. */
export const MAX_SESSION_OUTPUT_BYTES = 32 * 1024;

export type SessionState = "created" | "provisioning" | "running" | "ready" | "stopped" | "error";
export type AgentState = "idle" | "running";
export type CheckoutState = "pending" | "available" | "unavailable";
export type SessionProvisioningStage =
  | "created"
  | "starting-vm"
  | "cloning"
  | "creating-branch"
  | "setup"
  | "resuming"
  | "stopping"
  | "running"
  | "ready"
  | "stopped"
  | "failed";

export type SessionIssueCategory =
  | "vm-start"
  | "github-authentication"
  | "clone"
  | "setup"
  | "resume-hook"
  | "vm-stop"
  | "model"
  | "report"
  | "operation-uncertain"
  | "actor-crash"
  | "environment-storage";
export type SessionRecoveryAction = "none" | "retry-provisioning" | "restart-environment";
export interface SessionIssue {
  readonly category: SessionIssueCategory;
  readonly severity: "warning" | "failure";
  readonly message: string;
  readonly diagnostics?: string;
  readonly recovery: SessionRecoveryAction;
}

export interface SessionView {
  readonly id: string;
  /** Absent for a Session without a project, which has no checkout and no Git integration. */
  readonly projectId?: string;
  readonly createdAt: string;
  readonly initialPromptPreview: string;
  readonly model: string;
  readonly initialThinkingLevel: SessionThinkingLevel;
  readonly orbSize: OrbSize;
  readonly state: SessionState;
  readonly agentState: AgentState;
  readonly environmentState: EnvironmentState;
  /** False while the runner hosting the environment is disconnected; its state is the last known. */
  readonly environmentReachable: boolean;
  readonly issues: readonly SessionIssue[];
}

export type ConversationFrame =
  | { readonly type: "conversation.snapshot"; readonly view: ConversationView }
  | { readonly type: "conversation.ops"; readonly ops: readonly Op[] };

/** Infrastructure facts and exact structural Durable frames. No semantic replay or cursors. */
export type SessionEvent =
  | ConversationFrame
  | {
      readonly type: "session.state";
      readonly stage: SessionProvisioningStage;
      readonly agentState: AgentState;
      readonly environmentState: EnvironmentState;
      readonly environmentReachable: boolean;
      readonly checkoutState: CheckoutState;
      readonly issues: readonly SessionIssue[];
    }
  | { readonly type: "git.snapshot.updated" };
