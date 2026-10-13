import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
  EnvironmentAction,
  EnvironmentState,
  GitAuthor,
  OrbSize,
  SessionEnvironmentRecoveryMode,
  SessionEnvironmentSecret,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";

/** What an Agent Environment Provider guarantees, declared rather than assumed (ADR 0006). */
export interface AgentEnvironmentCapabilities {
  readonly persistence: "root-disk" | "virtual-disk" | "snapshot" | "ephemeral";
  /**
   * How real credentials reach the guest: `mediated` substitutes them outside it (Egress Secret
   * Mediation), `opt-in` places them in it only with the Project's Guest Credential Opt-in, and
   * `none` never gives them to the provider at all.
   */
  readonly credentials: "mediated" | "opt-in" | "none";
  /** The Session Durable Object can hibernate while the Environment Link stays open. */
  readonly hibernatableLink: boolean;
  /** The guest runs Git, which a Session's project needs: its checkout and Git Snapshots. */
  readonly git: boolean;
}

export interface EnvironmentBinding {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  /**
   * The project's repository, which scopes credential mediation where the provider has it, and
   * the Git identity for its commits. Absent for a Session without a project.
   */
  readonly repository?: { readonly url: string; readonly gitAuthor: GitAuthor };
}

export interface EnvironmentSpec {
  readonly orbSize: OrbSize;
}

/** Credentials a started environment may use; how they reach the guest is the provider's concern. */
export interface EnvironmentCredentials {
  readonly githubToken?: string;
  readonly environmentSecrets?: readonly SessionEnvironmentSecret[];
}

export interface EnvironmentControlOptions {
  readonly credentials?: EnvironmentCredentials;
  readonly recovery?: SessionEnvironmentRecoveryMode;
}

export interface EnvironmentControlResult {
  readonly state: EnvironmentState;
  /** Stopping forced termination and may have lost unsynced writes. */
  readonly forced: boolean;
}

export class EnvironmentUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EnvironmentUnavailableError";
  }
}

/**
 * One Session's Agent Environment as its provider exposes it. `env` is created once and handed to
 * the Agent Harness unchanged; its guest operations fail immediately while the provider is
 * unreachable or the environment is stopped.
 */
export interface SessionEnvironment {
  readonly env: ExecutionEnv;
  /** The last state the provider reported. */
  readonly state: () => EnvironmentState;
  readonly create: (spec: EnvironmentSpec) => Promise<void>;
  readonly control: (
    action: EnvironmentAction,
    options?: EnvironmentControlOptions,
  ) => Promise<EnvironmentControlResult>;
  readonly delete: () => Promise<void>;
  /** Releases in-memory resources; persistent state and logical availability are unaffected. */
  readonly close: () => void;
}

/**
 * Where a Session's Agent Environment runs, fixed at creation: its provider and whatever that
 * provider needs to find the environment, such as the runner that owns its root disk.
 */
export type SessionPlacement =
  | { readonly provider: "runner"; readonly runnerId: string }
  | { readonly provider: "sandbox" };

/** The implemented Agent Environment Providers. */
export type EnvironmentProviderKind = SessionPlacement["provider"];

/**
 * Whether a provider receives the Workspace's credentials: always where egress mediation keeps
 * them out of the guest, never where it declares none, otherwise only with the Project's Guest
 * Credential Opt-in.
 */
export function receivesCredentials(
  capabilities: AgentEnvironmentCapabilities,
  guestCredentialOptIn: boolean,
): boolean {
  return capabilities.credentials === "mediated" ||
    (capabilities.credentials === "opt-in" && guestCredentialOptIn);
}

export interface AgentEnvironmentProvider {
  readonly kind: EnvironmentProviderKind;
  readonly capabilities: AgentEnvironmentCapabilities;
  /** What the agent's system prompt says about this provider's guest, beyond the common rules. */
  readonly guestPrompt: readonly string[];
  /** Binds a Session to its environment. Creates no compute. */
  readonly bind: (binding: EnvironmentBinding) => SessionEnvironment;
}
