import type { SessionProvisioningStage } from "@openorb/protocol/browser-session-events";

import type { SessionState } from "@/app/ui/session/session-transcript-state.ts";

export type SessionVmPhase =
  | "starting"
  | "active"
  | "waking"
  | "stopping"
  | "sleeping"
  | "failed"
  | "offline";

export function initialSessionVmPhase(state: SessionState): SessionVmPhase {
  switch (state) {
    case "created":
    case "provisioning":
      return "starting";
    case "running":
    case "ready":
      return "active";
    case "stopped":
      return "sleeping";
    case "error":
      return "failed";
    case "offline":
      return "offline";
  }
}

export function sessionVmPhaseForStage(stage: SessionProvisioningStage): SessionVmPhase {
  switch (stage) {
    case "created":
    case "starting-vm":
    case "cloning":
    case "creating-branch":
    case "setup":
      return "starting";
    case "resuming":
      return "waking";
    case "checkpointing":
      return "stopping";
    case "running":
    case "ready":
      return "active";
    case "stopped":
      return "sleeping";
    case "failed":
      return "failed";
  }
}

export function sessionVmPhaseLabel(phase: SessionVmPhase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

export function isSessionVmTransitioning(phase: SessionVmPhase): boolean {
  return phase === "starting" || phase === "waking" || phase === "stopping";
}
