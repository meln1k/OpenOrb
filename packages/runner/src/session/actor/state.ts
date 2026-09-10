import type {
  RunId,
  RunnerCheckoutState,
  RunnerId,
  RunnerSessionCreatedAt,
  RunnerSessionState,
  SessionGitHead,
  SessionId,
  SessionIssue,
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
  type PersistedRestorationContinuation,
  SessionEvent,
  type SessionEvent as SessionEventType,
} from "./events.ts";
import { appendSessionIssues, clearFailureIssues, clearIssueCategories } from "./issues.ts";

const strictSchemaOptions = { onExcessProperty: "error" } as const;

export interface SessionData {
  readonly id: typeof SessionId.Type;
  readonly definition: RunnerSessionDefinition;
  readonly runnerId: typeof RunnerId.Type;
  readonly createdAt: typeof RunnerSessionCreatedAt.Type;
  readonly checkoutState: RunnerCheckoutState;
  readonly issues: readonly SessionIssue[];
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

type RestoringPhase = {
  readonly _tag: "Restoring";
  readonly restorationId: string;
  readonly continuation: PersistedRestorationContinuation;
};

export type SessionPhase =
  | { readonly _tag: "Provisioning" }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Waking"; readonly wakeId: string }
  | {
    readonly _tag: "StartingRun";
    readonly runId: RunId;
  }
  | {
    readonly _tag: "Running";
    readonly runId: RunId;
    readonly followUp: FollowUpPhase;
    readonly abort: AbortPhase;
  }
  | RestoringPhase
  | { readonly _tag: "Stopping"; readonly stopId: string }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Failed" };

export interface SessionState {
  readonly data: SessionData;
  readonly phase: SessionPhase;
}

export type RunnerSessionMetadata = SessionData & {
  readonly state: RunnerSessionState;
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
  return {
    ...state.data,
    state: publicSessionState(state.phase),
  };
}

export function publicSessionState(phase: SessionPhase): RunnerSessionState {
  switch (phase._tag) {
    case "Provisioning":
      return "provisioning";
    case "StartingRun":
      return "ready";
    case "Running":
      return "running";
    case "Ready":
    case "Waking":
    case "Stopping":
      return "ready";
    case "Restoring":
      return "stopped";
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
        issues: [],
      },
      phase: { _tag: "Provisioning" },
    };
  }
  if (current === undefined) return undefined;

  const { data, phase } = current;
  switch (event.type) {
    case "provisioning.retried":
      return phase._tag === "Failed"
        ? {
          data: { ...data, issues: clearFailureIssues(data.issues) },
          phase: { _tag: "Provisioning" },
        }
        : current;
    case "provisioning.interrupted":
    case "provisioning.failed":
      return phase._tag === "Provisioning"
        ? {
          data: withIssues(data, [event.issue]),
          phase: { _tag: "Failed" },
        }
        : current;
    case "restore.failed":
      return phase._tag === "Ready"
        ? {
          data: withIssues(data, [event.issue]),
          phase: { _tag: "Failed" },
        }
        : current;
    case "actor.crashed":
      return phase._tag === "Ready"
        ? {
          data: withIssues(data, [event.issue]),
          phase: { _tag: "Failed" },
        }
        : { data: withIssues(data, [event.issue]), phase };
    case "issue.recorded":
      return { data: withIssues(data, [event.issue]), phase };
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
          phase: { _tag: "Waking", wakeId: event.wakeId },
        }
        : current;
    case "wake.completed":
    case "wake.failed":
      return phase._tag === "Waking" && phase.wakeId === event.wakeId
        ? {
          data: event.type === "wake.failed" ? withIssues(data, [event.issue]) : data,
          phase: { _tag: "Ready" },
        }
        : current;
    case "wake.interrupted":
      return phase._tag === "Waking" && phase.wakeId === event.wakeId
        ? {
          data: withIssues(data, [event.issue]),
          phase: { _tag: "Failed" },
        }
        : current;
    case "run.requested": {
      const allowed = phase._tag === "Provisioning" || phase._tag === "Ready";
      return allowed
        ? {
          data: withIssues(data, event.issues),
          phase: {
            _tag: "StartingRun",
            runId: event.runId,
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
            followUp: { _tag: "Idle" },
            abort: { _tag: "Idle" },
          },
        }
        : current;
    case "run.start-failed":
      return phase._tag === "StartingRun" && phase.runId === event.runId
        ? finishRun(withIssues(data, [event.issue]))
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
      return matchesFollowUp(phase, event)
        ? {
          data: withIssues(data, [event.issue]),
          phase: { ...phase, followUp: { _tag: "Idle" } },
        }
        : current;
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
        ? finishRun(
          {
            ...data,
            issues: clearIssueCategories(data.issues, ["model", "operation-uncertain"]),
          },
        )
        : current;
    case "run.failed":
      return phase._tag === "Running" && phase.runId === event.runId
        ? finishRun(withIssues(data, [event.issue]))
        : current;
    case "run.interrupted":
      return (phase._tag === "StartingRun" || phase._tag === "Running") &&
          phase.runId === event.runId
        ? {
          data: withIssues(data, [event.issue]),
          phase: { _tag: "Failed" },
        }
        : current;
    case "restoration.started":
      return phase._tag === "Stopped" || phase._tag === "Failed"
        ? {
          data,
          phase: {
            _tag: "Restoring",
            restorationId: event.restorationId,
            continuation: event.continuation,
          },
        }
        : current;
    case "restoration.completed": {
      if (phase._tag !== "Restoring" || phase.restorationId !== event.restorationId) {
        return current;
      }
      const restoredData = withIssues(
        { ...data, issues: clearFailureIssues(data.issues) },
        event.issues,
      );
      return phase.continuation._tag === "Wake"
        ? { data: restoredData, phase: { _tag: "Ready" } }
        : {
          data: restoredData,
          phase: {
            _tag: "StartingRun",
            runId: phase.continuation.runId,
          },
        };
    }
    case "restoration.failed":
    case "restoration.interrupted":
      return phase._tag === "Restoring" && phase.restorationId === event.restorationId
        ? {
          data: withIssues(data, [event.issue]),
          phase: { _tag: "Failed" },
        }
        : current;
    case "stop.started":
      return phase._tag === "Ready"
        ? {
          data: {
            ...data,
            issues: clearIssueCategories(data.issues, ["vm-stop"]),
          },
          phase: { _tag: "Stopping", stopId: event.stopId },
        }
        : current;
    case "stop.completed":
      return phase._tag === "Stopping" && phase.stopId === event.stopId
        ? { data, phase: { _tag: "Stopped" } }
        : current;
    case "stop.failed":
      if (phase._tag !== "Stopping" || phase.stopId !== event.stopId) return current;
      return {
        data: withIssues(data, [event.issue]),
        phase: { _tag: event.environmentUsable ? "Ready" : "Failed" },
      };
  }
}

function withIssues(data: SessionData, issues: readonly SessionIssue[]): SessionData {
  return issues.length === 0 ? data : { ...data, issues: appendSessionIssues(data.issues, issues) };
}

function finishRun(data: SessionData): SessionState {
  return {
    data,
    phase: { _tag: "Ready" },
  };
}

function matchesFollowUp(
  phase: SessionPhase,
  event: { readonly runId: RunId; readonly followUpId: string },
): phase is Extract<SessionPhase, { readonly _tag: "Running" }> {
  return phase._tag === "Running" && phase.runId === event.runId &&
    phase.followUp._tag === "Delivering" && phase.followUp.followUpId === event.followUpId;
}
