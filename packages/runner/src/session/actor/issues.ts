import type {
  SessionIssue,
  SessionIssueCategory,
  SessionRecoveryAction,
} from "@openorb/protocol/runner-api";
import { MAX_SESSION_ISSUES } from "@openorb/protocol/runner-api";

export interface SessionIssueInput {
  readonly category: SessionIssueCategory;
  readonly severity: "warning" | "failure";
  readonly message: string;
  readonly diagnostics?: string | undefined;
  readonly recovery: SessionRecoveryAction;
}

export function makeSessionIssue(input: SessionIssueInput): SessionIssue {
  const diagnostics = input.diagnostics?.trim();
  return {
    category: input.category,
    severity: input.severity,
    message: input.message,
    ...(diagnostics ? { diagnostics } : {}),
    recovery: input.recovery,
  };
}

export function appendSessionIssues(
  current: readonly SessionIssue[],
  additions: readonly SessionIssue[],
): readonly SessionIssue[] {
  let next = [...current];
  for (const issue of additions) {
    next = next.filter((existing) =>
      existing.category !== issue.category &&
      !(issue.severity === "failure" && existing.severity === "failure")
    );
    next.push(issue);
  }
  return next.slice(-MAX_SESSION_ISSUES);
}

export function clearFailureIssues(issues: readonly SessionIssue[]): readonly SessionIssue[] {
  return issues.filter((issue) => issue.severity !== "failure");
}

export function clearIssueCategories(
  issues: readonly SessionIssue[],
  categories: readonly SessionIssueCategory[],
): readonly SessionIssue[] {
  return issues.filter((issue) => !categories.includes(issue.category));
}

export function currentRecovery(
  issues: readonly SessionIssue[],
): Exclude<SessionRecoveryAction, "none" | "retry-provisioning"> | undefined {
  const recovery = issues.findLast((issue) => issue.severity === "failure")?.recovery;
  return recovery === "resume-prior-checkpoint" || recovery === "start-clean-vm"
    ? recovery
    : undefined;
}
