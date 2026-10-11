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
  readonly persistence: "root-disk" | "snapshot" | "ephemeral";
  /** Real credentials are substituted outside the guest and never enter it. */
  readonly egressSecretMediation: boolean;
  /** The Session Durable Object can hibernate while the Environment Link stays open. */
  readonly hibernatableLink: boolean;
}

export interface EnvironmentBinding {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  /** Provider-specific placement, such as the runner that owns the Session's root disk. */
  readonly placement: string;
  /** The Session's repository, which scopes credential mediation where the provider has it. */
  readonly repository: { readonly url: string; readonly gitAuthor: GitAuthor };
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
  /** Releases in-memory resources such as an open Environment Link; compute is unaffected. */
  readonly close: () => void;
}

/** The implemented Agent Environment Providers. */
export type EnvironmentProviderKind = "runner";

export const DEFAULT_ENVIRONMENT_PROVIDER: EnvironmentProviderKind = "runner";

/** The most specific choice wins: Session over Project over the Workspace default (ADR 0006). */
export function resolveEnvironmentProvider(
  levels: {
    readonly session?: EnvironmentProviderKind;
    readonly project?: EnvironmentProviderKind;
    readonly workspace?: EnvironmentProviderKind;
  },
): EnvironmentProviderKind {
  return levels.session ?? levels.project ?? levels.workspace ?? DEFAULT_ENVIRONMENT_PROVIDER;
}

/**
 * Credentials a provider may receive: all of them where egress mediation keeps them out of the
 * guest, otherwise none without the Project's Guest Credential Opt-in.
 */
export function permittedCredentials(
  capabilities: AgentEnvironmentCapabilities,
  guestCredentialOptIn: boolean,
  credentials: EnvironmentCredentials,
): EnvironmentCredentials {
  return capabilities.egressSecretMediation || guestCredentialOptIn ? credentials : {};
}

export interface AgentEnvironmentProvider {
  readonly kind: EnvironmentProviderKind;
  readonly capabilities: AgentEnvironmentCapabilities;
  /** Binds a Session to its environment. Creates no compute. */
  readonly bind: (binding: EnvironmentBinding) => SessionEnvironment;
}
