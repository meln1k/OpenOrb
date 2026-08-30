import { Context, Data, type Effect, type Scope } from "effect";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";

export const AGENT_WORKSPACE = "/workspace";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface AgentEnvironmentOutput {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface AgentEnvironmentCommandOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: AgentEnvironmentOutput) => Effect.Effect<void, unknown>;
}

export interface AgentEnvironmentShellOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutSeconds?: number;
  readonly onOutput: (data: Uint8Array) => Effect.Effect<void, unknown>;
}

export interface AgentEnvironmentCommandResult {
  readonly exitCode: number;
}

export type AgentEnvironmentBackend = "qemu" | "krun";

export interface AgentEnvironmentCheckpoint {
  readonly path: string;
  readonly guestAssetBuildId: string;
  readonly createdWithVmm?: AgentEnvironmentBackend;
  readonly compatibleVmm: readonly AgentEnvironmentBackend[];
}

export interface AgentEnvironment {
  readonly run: (
    command: readonly string[],
    options?: AgentEnvironmentCommandOptions,
  ) => Effect.Effect<AgentEnvironmentCommandResult, AgentEnvironmentError>;
  readonly runShell: (
    command: string,
    options: AgentEnvironmentShellOptions,
  ) => Effect.Effect<AgentEnvironmentCommandResult, AgentEnvironmentError>;
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, AgentEnvironmentError>;
  readonly access: (path: string) => Effect.Effect<void, AgentEnvironmentError>;
  readonly writeFile: (
    path: string,
    content: string,
  ) => Effect.Effect<void, AgentEnvironmentError>;
  readonly makeDirectory: (path: string) => Effect.Effect<void, AgentEnvironmentError>;
  readonly detectImageMimeType: (
    path: string,
  ) => Effect.Effect<string | null, AgentEnvironmentError>;
  readonly checkpoint: (
    path: string,
  ) => Effect.Effect<AgentEnvironmentCheckpoint, AgentEnvironmentCheckpointError>;
}

export interface AgentEnvironmentOptions {
  readonly workspacePath: string;
  readonly sessionLabel?: string;
  readonly github?: {
    readonly repositoryUrl: string;
    readonly gitAuthor: {
      readonly name: string;
      readonly email: string;
    };
    readonly token?: string;
  };
  readonly cpuCount: number;
  readonly memoryMiB: number;
  readonly resumeCheckpoint?: AgentEnvironmentCheckpoint;
}

export interface AgentEnvironmentProvider {
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

export class AgentEnvironmentCheckpointError extends Data.TaggedError(
  "AgentEnvironmentCheckpointError",
)<{
  readonly message: string;
  readonly cause: unknown;
  readonly consumed: boolean;
}> {
  constructor(message: string, cause: unknown, consumed: boolean) {
    super({ message, cause, consumed });
  }
}

export function resolveAgentWorkspacePath(inputPath: string): string {
  if (inputPath.includes("\0")) {
    throw new AgentEnvironmentError("Workspace paths must not contain NUL bytes.", undefined);
  }

  let normalized = inputPath.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~" || normalized.startsWith("~/")) {
    throw outsideWorkspace();
  }
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  if (normalized.includes("\0")) {
    throw new AgentEnvironmentError("Workspace paths must not contain NUL bytes.", undefined);
  }

  const resolved = posix.isAbsolute(normalized)
    ? posix.resolve(normalized)
    : posix.resolve(AGENT_WORKSPACE, normalized);
  if (resolved !== AGENT_WORKSPACE && !resolved.startsWith(`${AGENT_WORKSPACE}/`)) {
    throw outsideWorkspace();
  }
  return resolved;
}

function outsideWorkspace(): AgentEnvironmentError {
  return new AgentEnvironmentError(
    `Path must remain within ${AGENT_WORKSPACE}.`,
    undefined,
  );
}
