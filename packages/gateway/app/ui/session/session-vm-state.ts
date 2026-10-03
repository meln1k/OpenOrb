import type { EnvironmentState } from "@openorb/protocol/browser-session-events";

export type SessionVmPhase = "starting" | "active" | "stopping" | "sleeping" | "failed" | "offline";

export function sessionVmPhase(state: EnvironmentState | null): SessionVmPhase {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
      return "active";
    case "stopping":
      return "stopping";
    case "stopped":
      return "sleeping";
    case "error":
      return "failed";
    case null:
      return "offline";
  }
}

export function sessionVmPhaseLabel(phase: SessionVmPhase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

export function isSessionVmTransitioning(phase: SessionVmPhase): boolean {
  return phase === "starting" || phase === "stopping";
}
