import { Context, Data, type Effect, type Scope } from "effect";
import type { SessionEnvironmentSecret } from "@openorb/protocol/runner-api";

export const AGENT_WORKSPACE = "/workspace";

export interface AgentEnvironmentOutput {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface AgentEnvironmentCommandOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: AgentEnvironmentOutput) => Effect.Effect<void, unknown>;
}

export interface AgentEnvironmentCommandResult {
  readonly exitCode: number;
}

/** A started Environment Daemon in the guest, joined to the runner through its stdio. */
export interface EnvironmentDaemon {
  /** The token of the daemon's `PI-ENV <token>` sync line. */
  readonly token: string;
  readonly write: (bytes: Uint8Array) => void;
  /** The daemon's stdout; it ends when the daemon exits. */
  readonly stdout: AsyncIterable<Uint8Array>;
  /**
   * Ends the daemon's stdin, which makes it kill every process it started and exit, then waits
   * briefly before abandoning it. Idempotent.
   */
  readonly close: Effect.Effect<void>;
}

/** One Session's guest VM as the runner sees it; the agent reaches it only via the daemon. */
export interface AgentEnvironment {
  /** Runs an absolute-path command in the guest, for lifecycle probes and durability. */
  readonly run: (
    command: readonly string[],
    options?: AgentEnvironmentCommandOptions,
  ) => Effect.Effect<AgentEnvironmentCommandResult, AgentEnvironmentError>;
  readonly startDaemon: Effect.Effect<EnvironmentDaemon, AgentEnvironmentError>;
  readonly stop: Effect.Effect<void, AgentEnvironmentError>;
}

export interface AgentEnvironmentOptions {
  readonly rootDiskPath: string;
  readonly sessionLabel?: string;
  readonly sessionId?: string;
  readonly github?: {
    readonly repositoryUrl: string;
    readonly gitAuthor: {
      readonly name: string;
      readonly email: string;
    };
    readonly token?: string;
  };
  readonly environmentSecrets?: readonly SessionEnvironmentSecret[];
  readonly cpuCount: number;
  readonly memoryMiB: number;
}

export interface AgentEnvironmentProvider {
  readonly initializeRootDisk: (path: string) => Effect.Effect<void, AgentEnvironmentError>;
  readonly make: (
    options: AgentEnvironmentOptions,
  ) => Effect.Effect<AgentEnvironment, AgentEnvironmentError, Scope.Scope>;
}

export const AgentEnvironmentProvider: Context.Service<
  AgentEnvironmentProvider,
  AgentEnvironmentProvider
> = Context.Service("@openorb/runner/environment/AgentEnvironmentProvider");

export class AgentEnvironmentError extends Data.TaggedError("AgentEnvironmentError")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  constructor(message: string, cause: unknown) {
    super({ message, cause });
  }
}
