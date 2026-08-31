import type {
  AbortSessionPayload,
  PromptSessionPayload,
  RunId,
  SessionModelRuntime,
  StopSessionPayload,
  UpdateSessionGitFilePayload,
  WakeSessionPayload,
} from "@openorb/protocol/runner-api";
import type { Deferred } from "effect";

import type {
  AgentEnvironment,
  AgentEnvironmentCheckpoint,
} from "../../environment/agent-environment.ts";
import type { ActiveAgentRun } from "../../harness/agent-harness.ts";
import type { SessionActorError } from "./actor-error.ts";
import type { OpenAgentSession } from "./agent-runtime.ts";
import type { RunnerSessionCheckpointCandidate, RunnerSessionMetadata } from "../store.ts";

export type PromptAcceptance =
  | { readonly ok: true; readonly runId: RunId; readonly mode: "started" | "follow-up" }
  | { readonly ok: false; readonly message: string };

export type AbortAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type GitFileUpdateAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type WakeAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type StopAcceptance =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

interface SessionActorInputBase {
  metadata: RunnerSessionMetadata;
  githubToken?: string | undefined;
  correlationId: string;
  idleTimeoutMs: number;
}

export type SessionActorInput =
  | (SessionActorInputBase & { readonly mode: "restore" | "reconcile" })
  | (SessionActorInputBase & {
    readonly mode: "create" | "retry";
    modelRuntime: SessionModelRuntime;
  });

export interface ProvisioningLogBudget {
  remainingBytes: number;
  truncated: boolean;
  secrets: string[];
}

export interface ProvisioningUpdate {
  readonly checkoutState: RunnerSessionMetadata["checkoutState"];
  readonly baseCommit?: string;
}

export type ActorCommand =
  | {
    readonly kind: "command";
    readonly _tag: "Wake";
    readonly payload: WakeSessionPayload;
    readonly reply: Deferred.Deferred<WakeAcceptance>;
  }
  | {
    readonly kind: "command";
    readonly _tag: "Prompt";
    readonly payload: PromptSessionPayload;
    readonly reply: Deferred.Deferred<PromptAcceptance>;
  }
  | {
    readonly kind: "command";
    readonly _tag: "Abort";
    readonly payload: AbortSessionPayload;
    readonly reply: Deferred.Deferred<AbortAcceptance>;
  }
  | {
    readonly kind: "command";
    readonly _tag: "Stop";
    readonly payload: StopSessionPayload;
    readonly idle: boolean;
    readonly reply: Deferred.Deferred<StopAcceptance>;
  }
  | {
    readonly kind: "command";
    readonly _tag: "UpdateGitFile";
    readonly payload: UpdateSessionGitFilePayload;
    readonly reply: Deferred.Deferred<GitFileUpdateAcceptance>;
  };

export type ResumeContinuation =
  | {
    readonly _tag: "Wake";
    readonly payload: WakeSessionPayload;
    readonly reply: Deferred.Deferred<WakeAcceptance>;
  }
  | {
    readonly _tag: "Prompt";
    readonly payload: PromptSessionPayload;
    readonly runId: RunId;
    readonly reply: Deferred.Deferred<PromptAcceptance>;
  };

export type RunCompletion =
  | {
    readonly _tag: "Provisioning";
    readonly correlationId: string;
    readonly logBudget: ProvisioningLogBudget;
  }
  | {
    readonly _tag: "Prompt";
    readonly reply: Deferred.Deferred<PromptAcceptance>;
  };

export type InternalCommand =
  | {
    readonly kind: "internal";
    readonly _tag: "Initialize";
    readonly reply: Deferred.Deferred<void, SessionActorError>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "ProvisioningUpdated";
    readonly input: ProvisioningUpdate;
    readonly reply: Deferred.Deferred<RunnerSessionMetadata, SessionActorError>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "ProvisioningEnvironmentStarted";
    readonly environment: AgentEnvironment;
    readonly reply: Deferred.Deferred<void, SessionActorError>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "ProvisioningPrepared";
    readonly environment: AgentEnvironment;
    readonly modelRuntime: SessionModelRuntime;
    readonly correlationId: string;
    readonly logBudget: ProvisioningLogBudget;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "ProvisioningFailed";
    readonly correlationId: string;
    readonly logBudget: ProvisioningLogBudget;
    readonly error: SessionActorError;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "WakeOpened";
    readonly wakeId: string;
    readonly agentSession: OpenAgentSession;
    readonly reply: Deferred.Deferred<WakeAcceptance>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "WakeOpenFailed";
    readonly wakeId: string;
    readonly reply: Deferred.Deferred<WakeAcceptance>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "RunStarted";
    readonly runId: RunId;
    readonly run: ActiveAgentRun;
    readonly agentSession: OpenAgentSession;
    readonly openedAgentSession: boolean;
    readonly acceptedAt: string;
    readonly completion: RunCompletion;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "RunStartFailed";
    readonly runId: RunId;
    readonly error: SessionActorError;
    readonly openedAgentSession?: OpenAgentSession;
    readonly completion: RunCompletion;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "FollowUpAccepted";
    readonly runId: RunId;
    readonly followUpId: string;
    readonly acceptedAt: string;
    readonly reply: Deferred.Deferred<PromptAcceptance>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "FollowUpFailed";
    readonly runId: RunId;
    readonly followUpId: string;
    readonly reply: Deferred.Deferred<PromptAcceptance>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "RunSettled";
    readonly runId: RunId;
    readonly error?: SessionActorError;
    readonly completion: RunCompletion;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "AbortConfirmed";
    readonly runId: RunId;
    readonly reply: Deferred.Deferred<AbortAcceptance>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "AbortFailed";
    readonly runId: RunId;
    readonly reply: Deferred.Deferred<AbortAcceptance>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "CheckpointCompleted";
    readonly candidate: RunnerSessionCheckpointCandidate;
    readonly checkpoint: AgentEnvironmentCheckpoint;
    readonly correlationId: string;
    readonly reply: Deferred.Deferred<StopAcceptance>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "CheckpointFailed";
    readonly candidate: RunnerSessionCheckpointCandidate;
    readonly consumed: boolean;
    readonly agentSessionClosed: boolean;
    readonly correlationId: string;
    readonly reply: Deferred.Deferred<StopAcceptance>;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "ResumeCompleted";
    readonly resumeId: string;
    readonly environment: AgentEnvironment;
    readonly agentSession: OpenAgentSession;
    readonly correlationId: string;
    readonly continuation: ResumeContinuation;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "ResumeFailed";
    readonly resumeId: string;
    readonly correlationId: string;
    readonly continuation: ResumeContinuation;
  }
  | {
    readonly kind: "internal";
    readonly _tag: "RefreshGitSnapshot";
    readonly reply: Deferred.Deferred<void, unknown>;
  };

export type SessionCommand = ActorCommand | InternalCommand;
