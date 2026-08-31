import type {
  RunId,
  RunnerCheckoutState,
  RunnerId,
  RunnerSessionCreatedAt,
  RunnerSessionState,
  SessionGitHead,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Data, Effect, Schema } from "effect";

import type { Journal } from "../persistent-actor/journal.ts";
import {
  type PersistentActorBehavior,
  type PersistentActorError,
  recoverPersistentState,
} from "../persistent-actor/persistent-actor.ts";
import type { RunnerSessionDefinition } from "../definition.ts";
import {
  type PersistedResumeContinuation,
  type RunnerSessionCheckpointMetadata,
  type RunPurpose,
  SessionEvent,
  type SessionEvent as SessionEventType,
} from "./events.ts";

const strictSchemaOptions = { onExcessProperty: "error" } as const;

export interface SessionData {
  readonly id: typeof SessionId.Type;
  readonly definition: RunnerSessionDefinition;
  readonly runnerId: typeof RunnerId.Type;
  readonly createdAt: typeof RunnerSessionCreatedAt.Type;
  readonly checkoutState: RunnerCheckoutState;
  readonly baseCommit?: typeof SessionGitHead.Type;
  readonly lastAcceptedUserMessageAt?: typeof RunnerSessionCreatedAt.Type;
}

export type FollowUpPhase =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Delivering"; readonly followUpId: string };

export type AbortPhase =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Requested" }
  | { readonly _tag: "Confirmed" };

interface CheckpointRetainingPhase {
  readonly checkpoint?: RunnerSessionCheckpointMetadata;
}

export type SessionPhase =
  | ({ readonly _tag: "Provisioning" } & CheckpointRetainingPhase)
  | ({ readonly _tag: "Ready" } & CheckpointRetainingPhase)
  | ({ readonly _tag: "Waking"; readonly wakeId: string } & CheckpointRetainingPhase)
  | ({
    readonly _tag: "StartingRun";
    readonly runId: RunId;
    readonly purpose: RunPurpose;
  } & CheckpointRetainingPhase)
  | ({
    readonly _tag: "Running";
    readonly runId: RunId;
    readonly purpose: RunPurpose;
    readonly followUp: FollowUpPhase;
    readonly abort: AbortPhase;
  } & CheckpointRetainingPhase)
  | {
    readonly _tag: "Resuming";
    readonly resumeId: string;
    readonly continuation: PersistedResumeContinuation;
    readonly checkpoint: RunnerSessionCheckpointMetadata;
  }
  | ({ readonly _tag: "Checkpointing"; readonly file: string } & CheckpointRetainingPhase)
  | {
    readonly _tag: "Stopped";
    readonly checkpoint: RunnerSessionCheckpointMetadata;
  }
  | ({ readonly _tag: "Failed" } & CheckpointRetainingPhase);

export interface SessionState {
  readonly data: SessionData;
  readonly phase: SessionPhase;
}

export type RunnerSessionMetadata = SessionData & {
  readonly state: RunnerSessionState;
  readonly checkpoint?: RunnerSessionCheckpointMetadata;
  readonly checkpointCandidate?: { readonly file: string };
};

export const sessionBehavior: PersistentActorBehavior<SessionState | undefined, SessionEventType> =
  {
    codec: {
      decode: (encoded) => Schema.decodeUnknownEffect(SessionEvent)(encoded, strictSchemaOptions),
      encode: (event) => Schema.encodeEffect(SessionEvent)(event, strictSchemaOptions),
    },
    initialState: () => undefined,
    eventHandler: applySessionEvent,
  };

export function recoverSessionState(
  sessionId: string,
): Effect.Effect<SessionState, PersistentActorError | SessionRecoveryError, Journal> {
  return recoverPersistentState(sessionId, sessionBehavior).pipe(
    Effect.flatMap((recovered) =>
      recovered.state === undefined
        ? Effect.fail(new SessionRecoveryError("The session event journal is empty."))
        : Effect.succeed(recovered.state)
    ),
  );
}

export class SessionRecoveryError extends Data.TaggedError(
  "SessionRecoveryError",
)<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

export function sessionMetadata(state: SessionState): RunnerSessionMetadata {
  const checkpoint = state.phase.checkpoint;
  return {
    ...state.data,
    state: publicSessionState(state.phase),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(state.phase._tag === "Checkpointing"
      ? { checkpointCandidate: { file: state.phase.file } }
      : {}),
  };
}

export function publicSessionState(phase: SessionPhase): RunnerSessionState {
  switch (phase._tag) {
    case "Provisioning":
      return "provisioning";
    case "StartingRun":
      return phase.purpose === "initial" ? "provisioning" : "ready";
    case "Running":
      return "running";
    case "Ready":
    case "Waking":
    case "Checkpointing":
      return "ready";
    case "Resuming":
    case "Stopped":
      return "stopped";
    case "Failed":
      return "error";
  }
}

export function applySessionEvent(
  current: SessionState | undefined,
  event: SessionEventType,
): SessionState | undefined {
  if (event.type === "session.provisioning-started") {
    return current ?? {
      data: {
        id: event.id,
        definition: event.definition,
        runnerId: event.runnerId,
        createdAt: event.createdAt,
        checkoutState: "pending",
      },
      phase: { _tag: "Provisioning" },
    };
  }
  if (current === undefined) return undefined;

  const { data, phase } = current;
  switch (event.type) {
    case "provisioning.retried":
      return phase._tag === "Failed"
        ? { data, phase: { _tag: "Provisioning", ...retainedCheckpoint(phase) } }
        : current;
    case "provisioning.interrupted":
    case "provisioning.failed":
      return phase._tag === "Provisioning"
        ? { data, phase: { _tag: "Failed", ...retainedCheckpoint(phase) } }
        : current;
    case "restore.failed":
      return phase._tag === "Ready"
        ? { data, phase: { _tag: "Failed", ...retainedCheckpoint(phase) } }
        : current;
    case "checkout.updated":
      return phase._tag === "Provisioning"
        ? {
          ...current,
          data: {
            ...data,
            checkoutState: event.checkoutState,
            ...(event.baseCommit === undefined ? {} : { baseCommit: event.baseCommit }),
          },
        }
        : current;
    case "wake.started":
      return phase._tag === "Ready"
        ? {
          data,
          phase: { _tag: "Waking", wakeId: event.wakeId, ...retainedCheckpoint(phase) },
        }
        : current;
    case "wake.completed":
    case "wake.failed":
    case "wake.interrupted":
      return phase._tag === "Waking" && phase.wakeId === event.wakeId
        ? { data, phase: { _tag: "Ready", ...retainedCheckpoint(phase) } }
        : current;
    case "run.requested": {
      const allowed = event.purpose === "initial"
        ? phase._tag === "Provisioning"
        : phase._tag === "Ready";
      return allowed
        ? {
          data,
          phase: {
            _tag: "StartingRun",
            runId: event.runId,
            purpose: event.purpose,
            ...retainedCheckpoint(phase),
          },
        }
        : current;
    }
    case "run.started":
      return phase._tag === "StartingRun" && phase.runId === event.runId
        ? {
          data: { ...data, lastAcceptedUserMessageAt: event.acceptedAt },
          phase: {
            _tag: "Running",
            runId: phase.runId,
            purpose: phase.purpose,
            followUp: { _tag: "Idle" },
            abort: { _tag: "Idle" },
            ...retainedCheckpoint(phase),
          },
        }
        : current;
    case "run.start-failed":
      return phase._tag === "StartingRun" && phase.runId === event.runId
        ? finishRun(data, phase, phase.purpose === "initial")
        : current;
    case "follow-up.requested":
      return phase._tag === "Running" && phase.runId === event.runId &&
          phase.followUp._tag === "Idle"
        ? {
          data,
          phase: {
            ...phase,
            followUp: { _tag: "Delivering", followUpId: event.followUpId },
          },
        }
        : current;
    case "follow-up.accepted":
      return matchesFollowUp(phase, event)
        ? {
          data: { ...data, lastAcceptedUserMessageAt: event.acceptedAt },
          phase: { ...phase, followUp: { _tag: "Idle" } },
        }
        : current;
    case "follow-up.failed":
    case "follow-up.interrupted":
      return matchesFollowUp(phase, event)
        ? { data, phase: { ...phase, followUp: { _tag: "Idle" } } }
        : current;
    case "abort.requested":
      return phase._tag === "Running" && phase.runId === event.runId &&
          phase.abort._tag === "Idle"
        ? { data, phase: { ...phase, abort: { _tag: "Requested" } } }
        : current;
    case "abort.confirmed":
      return phase._tag === "Running" && phase.runId === event.runId &&
          phase.abort._tag === "Requested"
        ? { data, phase: { ...phase, abort: { _tag: "Confirmed" } } }
        : current;
    case "abort.failed":
      return phase._tag === "Running" && phase.runId === event.runId &&
          phase.abort._tag === "Requested"
        ? { data, phase: { ...phase, abort: { _tag: "Idle" } } }
        : current;
    case "run.completed":
      return phase._tag === "Running" && phase.runId === event.runId
        ? finishRun(data, phase, false)
        : current;
    case "run.failed":
      return phase._tag === "Running" && phase.runId === event.runId
        ? finishRun(data, phase, phase.purpose === "initial")
        : current;
    case "run.interrupted":
      return (phase._tag === "StartingRun" || phase._tag === "Running") &&
          phase.runId === event.runId
        ? finishRun(data, phase, phase.purpose === "initial")
        : current;
    case "resume.started":
      return phase._tag === "Stopped"
        ? {
          data,
          phase: {
            _tag: "Resuming",
            resumeId: event.resumeId,
            continuation: event.continuation,
            checkpoint: phase.checkpoint,
          },
        }
        : current;
    case "resume.completed":
      if (phase._tag !== "Resuming" || phase.resumeId !== event.resumeId) return current;
      return phase.continuation._tag === "Wake"
        ? { data, phase: { _tag: "Ready", checkpoint: phase.checkpoint } }
        : {
          data,
          phase: {
            _tag: "StartingRun",
            runId: phase.continuation.runId,
            purpose: "prompt",
            checkpoint: phase.checkpoint,
          },
        };
    case "resume.failed":
    case "resume.interrupted":
      return phase._tag === "Resuming" && phase.resumeId === event.resumeId
        ? { data, phase: { _tag: "Stopped", checkpoint: phase.checkpoint } }
        : current;
    case "checkpoint.started":
      return phase._tag === "Ready"
        ? {
          data,
          phase: {
            _tag: "Checkpointing",
            file: event.file,
            ...retainedCheckpoint(phase),
          },
        }
        : current;
    case "checkpoint.published":
      return phase._tag === "Checkpointing" && phase.file === event.checkpoint.file
        ? { data, phase: { _tag: "Stopped", checkpoint: event.checkpoint } }
        : current;
    case "checkpoint.failed":
      if (phase._tag !== "Checkpointing" || phase.file !== event.file) return current;
      return {
        data,
        phase: {
          _tag: event.consumed ? "Failed" : "Ready",
          ...retainedCheckpoint(phase),
        },
      };
    case "checkpoint.interrupted":
      return phase._tag === "Checkpointing" && phase.file === event.file
        ? { data, phase: { _tag: "Failed", ...retainedCheckpoint(phase) } }
        : current;
    case "checkpoint.invalidated":
      return phase.checkpoint?.file === event.file ? { data, phase: { _tag: "Failed" } } : current;
  }
}

function retainedCheckpoint(
  phase: SessionPhase,
): CheckpointRetainingPhase {
  return phase.checkpoint === undefined ? {} : { checkpoint: phase.checkpoint };
}

function finishRun(
  data: SessionData,
  phase: Extract<SessionPhase, { readonly _tag: "StartingRun" | "Running" }>,
  failed: boolean,
): SessionState {
  return {
    data,
    phase: {
      _tag: failed ? "Failed" : "Ready",
      ...retainedCheckpoint(phase),
    },
  };
}

function matchesFollowUp(
  phase: SessionPhase,
  event: { readonly runId: RunId; readonly followUpId: string },
): phase is Extract<SessionPhase, { readonly _tag: "Running" }> {
  return phase._tag === "Running" && phase.runId === event.runId &&
    phase.followUp._tag === "Delivering" && phase.followUp.followUpId === event.followUpId;
}
