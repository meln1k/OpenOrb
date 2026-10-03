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
  snapshot: Pick<RunnerSessionSnapshot, "agentState" | "environmentState" | "issues">,
  recovery: SessionEnvironmentRecoveryMode | undefined,
): "warm" | "cold" | undefined {
  if (snapshot.environmentState === "stopping") return undefined;
  if (snapshot.agentState === "error" || snapshot.environmentState === "error") {
    return recovery !== undefined && currentSessionRecovery(snapshot.issues) === recovery
      ? "cold"
      : undefined;
  }
  if (recovery !== undefined) return undefined;
  return snapshot.environmentState === "stopped" || snapshot.agentState === "paused"
    ? "cold"
    : "warm";
}
