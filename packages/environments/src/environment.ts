import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
  EnvironmentAction,
  EnvironmentState,
  GitAuthor,
  OrbSize,
  SessionEnvironmentSecret,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";

/** What an Agent Environment Provider guarantees, declared rather than assumed (ADR 0006). */
export interface EnvironmentCapabilities {
  /**
   * How real credentials reach the guest: `mediated` substitutes them outside it (Egress Secret
   * Mediation), `opt-in` places them in it only with the Project's Guest Credential Opt-in, and
   * `none` never gives them to the provider at all.
   */
  readonly credentials: "mediated" | "opt-in" | "none";
  /** The guest runs Git, which a Session's project needs: its checkout and Git Snapshots. */
  readonly git: boolean;
}

/**
 * Where a Session's Agent Environment runs, fixed at creation. `provider` names the
 * implementation; every other field belongs to that implementation, such as the runner that owns
 * the Persistent Root Disk, and is opaque to the Session.
 */
export interface EnvironmentPlacement {
  readonly provider: string;
  readonly [field: string]: string;
}

/** The last environment state the provider reported, and whether its control plane answers. */
export interface EnvironmentStatus {
  readonly state: EnvironmentState;
  readonly reachable: boolean;
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

/** What a hibernatable WebSocket keeps across hibernation: structured-cloneable JSON. */
export type SocketAttachment =
  | string
  | number
  | boolean
  | null
  | readonly SocketAttachment[]
  | { readonly [key: string]: SocketAttachment | undefined };

/** A hibernatable WebSocket accepted by the Session Durable Object. */
export interface HostWebSocket {
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: SocketAttachment): void;
  deserializeAttachment(): SocketAttachment;
}

/** What the Session Durable Object lends the environment of one Session. */
export interface EnvironmentHost {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly placement: EnvironmentPlacement;
  /**
   * The project's repository, which scopes credential mediation where the provider has it, and
   * the Git identity for its commits. Absent for a Session without a project.
   */
  readonly repository?: { readonly url: string; readonly gitAuthor: GitAuthor };
  /** Child Durable Objects with their own storage. */
  readonly facets: DurableObjectFacets;
  acceptWebSocket(socket: HostWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HostWebSocket[];
  setWebSocketAutoResponse?(pair: InstanceType<typeof WebSocketRequestResponsePair>): void;
  /** The status the Session last recorded. */
  readonly status: () => EnvironmentStatus;
  /** Records a status change and shows it to Session viewers. */
  readonly report: (status: EnvironmentStatus) => void;
  /** Asks the Session to recheck its activity, for example once transport work drains. */
  readonly reconcile: () => void;
}

/**
 * One Session's Agent Environment. `env` is handed to the Agent Harness unchanged; its guest
 * operations fail immediately while the provider is unreachable or the environment is stopped.
 * The optional hooks receive the Session Durable Object's traffic addressed to the environment.
 */
export interface Environment {
  readonly env: ExecutionEnv;
  create(spec: EnvironmentSpec): Promise<void>;
  control(
    action: EnvironmentAction,
    options?: EnvironmentControlOptions,
  ): Promise<EnvironmentControlResult>;
  delete(): Promise<void>;
  /** The agent has no live work: release in-memory resources. Persistent state is unaffected. */
  release(): void;
  /** An HTTP request routed to the Session for its environment, such as a link upgrade. */
  fetch?(request: Request): Response | Promise<Response>;
  webSocketMessage?(socket: HostWebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose?(socket: HostWebSocket, reason: string): void;
  /** A fact from the provider's own control plane, relayed by the Session. */
  notice?(notice: unknown): void;
}

/** An Agent Environment Provider: the runner, the built-in Sandbox, or a sandbox vendor. */
export interface EnvironmentProvider {
  readonly capabilities: EnvironmentCapabilities;
  /** What the agent's system prompt says about this provider's guest, beyond the common rules. */
  readonly guestPrompt: readonly string[];
  /** Binds a Session to its environment. Creates no compute. */
  open(host: EnvironmentHost): Environment;
}

/** The providers a gateway offers, by `EnvironmentPlacement.provider`. */
export type EnvironmentProviders = Readonly<Record<string, EnvironmentProvider>>;

/**
 * Whether a provider receives the Workspace's credentials: always where egress mediation keeps
 * them out of the guest, never where it declares none, otherwise only with the Project's Guest
 * Credential Opt-in.
 */
export function receivesCredentials(
  capabilities: EnvironmentCapabilities,
  guestCredentialOptIn: boolean,
): boolean {
  return (
    capabilities.credentials === "mediated" ||
    (capabilities.credentials === "opt-in" && guestCredentialOptIn)
  );
}
