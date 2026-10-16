import type { SessionIssue, SessionRecoveryAction } from "../cells/session/view.ts";

export function currentSessionRecovery(
  issues: readonly SessionIssue[],
): Exclude<SessionRecoveryAction, "none"> | undefined {
  const recovery = issues.findLast((issue) => issue.severity === "failure")?.recovery;
  return recovery === "none" ? undefined : recovery;
}
