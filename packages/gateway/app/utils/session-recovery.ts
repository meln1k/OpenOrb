import type {
  RunnerSessionSnapshot,
  SessionEnvironmentRecoveryMode,
  SessionIssue,
  SessionRecoveryAction,
} from "@openorb/protocol/runner-api";

export function currentSessionRecovery(
  issues: readonly SessionIssue[],
): Exclude<SessionRecoveryAction, "none"> | undefined {
  const recovery = issues.findLast((issue) => issue.severity === "failure")?.recovery;
  return recovery === "none" ? undefined : recovery;
}

export function sessionWakeKind(
  snapshot: Pick<RunnerSessionSnapshot, "state" | "issues">,
  recovery: SessionEnvironmentRecoveryMode | undefined,
): "warm" | "cold" | undefined {
  switch (snapshot.state) {
    case "ready":
    case "running":
      return recovery === undefined ? "warm" : undefined;
    case "stopped":
      return recovery === undefined ? "cold" : undefined;
    case "error":
      return recovery !== undefined && currentSessionRecovery(snapshot.issues) === recovery
        ? "cold"
        : undefined;
    case "created":
    case "provisioning":
      return undefined;
  }
}
