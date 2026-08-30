import {
  RunId,
  type RunnerCheckoutState,
  RunnerCheckoutState as RunnerCheckoutStateSchema,
  RunnerId,
  RunnerSessionCreatedAt,
  type RunnerSessionState,
  RunnerSessionState as RunnerSessionStateSchema,
  SessionGitHead,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Data, Effect, Schema } from "effect";

import { RunnerSessionDefinition } from "./definition.ts";

export const CHECKPOINT_FILE_PATTERN = /^checkpoint-[0-9a-f-]{36}\.qcow2$/;

const checkpointFileSchema = Schema.String.check(
  Schema.isPattern(CHECKPOINT_FILE_PATTERN),
);
const checkpointBackendSchema = Schema.Literals(["qemu", "krun"]);
export const checkpointMetadataSchema = Schema.Struct({
  file: checkpointFileSchema,
  guestAssetBuildId: Schema.String.check(Schema.isUUID()),
  createdWithVmm: Schema.optionalKey(checkpointBackendSchema),
  compatibleVmm: Schema.Array(checkpointBackendSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
  ),
});
const checkpointCandidateSchema = Schema.Struct({ file: checkpointFileSchema });

export const legacyMetadataSchema = Schema.Struct({
  version: Schema.Literal(2),
  id: SessionId,
  definition: RunnerSessionDefinition,
  runnerId: RunnerId,
  createdAt: RunnerSessionCreatedAt,
  state: RunnerSessionStateSchema,
  checkoutState: RunnerCheckoutStateSchema,
  baseCommit: Schema.optionalKey(SessionGitHead),
});
export const metadataSchema = Schema.Struct({
  version: Schema.Literal(3),
  id: SessionId,
  definition: RunnerSessionDefinition,
  runnerId: RunnerId,
  createdAt: RunnerSessionCreatedAt,
  state: RunnerSessionStateSchema,
  checkoutState: RunnerCheckoutStateSchema,
  baseCommit: Schema.optionalKey(SessionGitHead),
  lastAcceptedUserMessageAt: Schema.optionalKey(RunnerSessionCreatedAt),
  checkpoint: Schema.optionalKey(checkpointMetadataSchema),
  checkpointCandidate: Schema.optionalKey(checkpointCandidateSchema),
});

export type RunnerSessionMetadata = typeof metadataSchema.Type;
export type RunnerSessionCheckpointMetadata = typeof checkpointMetadataSchema.Type;

const sessionCreatedEventSchema = Schema.Struct({
  type: Schema.Literal("session.created"),
  id: SessionId,
  definition: RunnerSessionDefinition,
  runnerId: RunnerId,
  createdAt: RunnerSessionCreatedAt,
});
const sessionImportedEventSchema = Schema.Struct({
  type: Schema.Literal("session.imported"),
  metadata: metadataSchema,
});
const provisioningUpdatedEventSchema = Schema.Struct({
  type: Schema.Literal("provisioning.updated"),
  state: RunnerSessionStateSchema,
  checkoutState: RunnerCheckoutStateSchema,
  baseCommit: Schema.optionalKey(SessionGitHead),
});
const sessionStateChangedEventSchema = Schema.Struct({
  type: Schema.Literal("session.state-changed"),
  state: RunnerSessionStateSchema,
});
const runStartedEventSchema = Schema.Struct({
  type: Schema.Literal("run.started"),
  runId: RunId,
  acceptedAt: RunnerSessionCreatedAt,
});
const followUpAcceptedEventSchema = Schema.Struct({
  type: Schema.Literal("follow-up.accepted"),
  runId: RunId,
  acceptedAt: RunnerSessionCreatedAt,
});
const runSettledEventSchema = Schema.Struct({
  type: Schema.Literal("run.settled"),
  runId: RunId,
  startedBy: Schema.Int.check(Schema.isGreaterThan(0)),
});
const runInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("run.interrupted"),
  runId: RunId,
  startedBy: Schema.Int.check(Schema.isGreaterThan(0)),
});
const resumeStartedEventSchema = Schema.Struct({
  type: Schema.Literal("resume.started"),
});
const resumeCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("resume.completed"),
  startedBy: Schema.Int.check(Schema.isGreaterThan(0)),
});
const resumeFailedEventSchema = Schema.Struct({
  type: Schema.Literal("resume.failed"),
  startedBy: Schema.Int.check(Schema.isGreaterThan(0)),
});
const checkpointStartedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.started"),
  file: checkpointFileSchema,
});
const checkpointPublishedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.published"),
  startedBy: Schema.Int.check(Schema.isGreaterThan(0)),
  checkpoint: checkpointMetadataSchema,
});
const checkpointFailedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.failed"),
  startedBy: Schema.Int.check(Schema.isGreaterThan(0)),
  consumed: Schema.Boolean,
});
const checkpointInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.interrupted"),
  startedBy: Schema.Int.check(Schema.isGreaterThan(0)),
});
const checkpointInvalidatedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.invalidated"),
  file: checkpointFileSchema,
});

export const SessionLifecycleEvent = Schema.Union([
  sessionCreatedEventSchema,
  sessionImportedEventSchema,
  provisioningUpdatedEventSchema,
  sessionStateChangedEventSchema,
  runStartedEventSchema,
  followUpAcceptedEventSchema,
  runSettledEventSchema,
  runInterruptedEventSchema,
  resumeStartedEventSchema,
  resumeCompletedEventSchema,
  resumeFailedEventSchema,
  checkpointStartedEventSchema,
  checkpointPublishedEventSchema,
  checkpointFailedEventSchema,
  checkpointInterruptedEventSchema,
  checkpointInvalidatedEventSchema,
]);
export type SessionLifecycleEvent = typeof SessionLifecycleEvent.Type;

export const SessionLifecycleEventEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  event: SessionLifecycleEvent,
});
export type SessionLifecycleEventEnvelope = typeof SessionLifecycleEventEnvelope.Type;

export interface SessionLifecycleProjection {
  readonly sequence: number;
  readonly metadata: RunnerSessionMetadata;
  readonly activeRun?: { readonly runId: RunId; readonly startedBy: number };
  readonly resumeStartedBy?: number;
  readonly checkpointStartedBy?: number;
}

export class SessionLifecycleProjectionError extends Data.TaggedError(
  "SessionLifecycleProjectionError",
)<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

export function projectSessionLifecycle(
  events: readonly SessionLifecycleEventEnvelope[],
): Effect.Effect<SessionLifecycleProjection, SessionLifecycleProjectionError> {
  return Effect.gen(function* () {
    let projection: SessionLifecycleProjection | undefined;
    for (let index = 0; index < events.length; index++) {
      const envelope = events[index]!;
      const expectedSequence = index + 1;
      if (envelope.sequence !== expectedSequence) {
        return yield* new SessionLifecycleProjectionError(
          `Expected lifecycle event sequence ${expectedSequence}, received ${envelope.sequence}.`,
        );
      }
      projection = yield* applyLifecycleEvent(projection, envelope);
    }
    if (projection === undefined) {
      return yield* new SessionLifecycleProjectionError(
        "The session lifecycle log must contain a creation event.",
      );
    }
    return projection;
  });
}

export function applyLifecycleEvent(
  current: SessionLifecycleProjection | undefined,
  envelope: SessionLifecycleEventEnvelope,
): Effect.Effect<SessionLifecycleProjection, SessionLifecycleProjectionError> {
  const event = envelope.event;
  const expectedSequence = (current?.sequence ?? 0) + 1;
  if (envelope.sequence !== expectedSequence) {
    return new SessionLifecycleProjectionError(
      `Expected lifecycle event sequence ${expectedSequence}, received ${envelope.sequence}.`,
    );
  }
  if (event.type === "session.created") {
    if (current !== undefined || envelope.sequence !== 1) {
      return new SessionLifecycleProjectionError(
        "session.created must be the first lifecycle event.",
      );
    }
    return Effect.succeed({
      sequence: envelope.sequence,
      metadata: {
        version: 3,
        id: event.id,
        definition: event.definition,
        runnerId: event.runnerId,
        createdAt: event.createdAt,
        state: "created",
        checkoutState: "pending",
      },
    });
  }
  if (event.type === "session.imported") {
    if (current !== undefined || envelope.sequence !== 1) {
      return new SessionLifecycleProjectionError(
        "session.imported must be the first lifecycle event.",
      );
    }
    return Effect.succeed({
      sequence: envelope.sequence,
      metadata: event.metadata,
      ...(event.metadata.checkpointCandidate === undefined
        ? {}
        : { checkpointStartedBy: envelope.sequence }),
    });
  }
  if (current === undefined) {
    return new SessionLifecycleProjectionError(
      `${event.type} cannot precede session creation.`,
    );
  }

  const metadata = current.metadata;
  switch (event.type) {
    case "provisioning.updated":
      if (
        current.resumeStartedBy !== undefined || current.checkpointStartedBy !== undefined ||
        (current.activeRun !== undefined && event.state !== "running")
      ) {
        return new SessionLifecycleProjectionError(
          "Provisioning cannot replace the state of an active lifecycle operation.",
        );
      }
      return Effect.succeed({
        ...current,
        sequence: envelope.sequence,
        metadata: {
          ...metadata,
          state: event.state,
          checkoutState: event.checkoutState,
          ...(event.baseCommit === undefined ? {} : { baseCommit: event.baseCommit }),
        },
      });
    case "session.state-changed":
      if (
        current.activeRun !== undefined || current.resumeStartedBy !== undefined ||
        current.checkpointStartedBy !== undefined
      ) {
        return new SessionLifecycleProjectionError(
          "A generic state change cannot settle an active lifecycle operation.",
        );
      }
      return Effect.succeed({
        ...current,
        sequence: envelope.sequence,
        metadata: { ...metadata, state: event.state },
      });
    case "run.started":
      if (
        current.activeRun !== undefined || current.resumeStartedBy !== undefined ||
        current.checkpointStartedBy !== undefined
      ) {
        return new SessionLifecycleProjectionError(
          "A run cannot start while another lifecycle operation is active.",
        );
      }
      if (metadata.state !== "ready" && metadata.state !== "provisioning") {
        return new SessionLifecycleProjectionError(
          `A run cannot start while the session is ${metadata.state}.`,
        );
      }
      return Effect.succeed({
        ...current,
        sequence: envelope.sequence,
        activeRun: { runId: event.runId, startedBy: envelope.sequence },
        metadata: {
          ...metadata,
          state: "running",
          lastAcceptedUserMessageAt: event.acceptedAt,
        },
      });
    case "follow-up.accepted":
      if (current.activeRun?.runId !== event.runId) {
        return new SessionLifecycleProjectionError(
          "follow-up.accepted does not match the active run.",
        );
      }
      return Effect.succeed({
        ...current,
        sequence: envelope.sequence,
        metadata: { ...metadata, lastAcceptedUserMessageAt: event.acceptedAt },
      });
    case "run.settled":
    case "run.interrupted":
      if (
        current.activeRun?.runId !== event.runId ||
        current.activeRun.startedBy !== event.startedBy
      ) {
        return new SessionLifecycleProjectionError(
          `${event.type} does not match the active run.`,
        );
      }
      return Effect.succeed({
        ...withoutActiveRun(current),
        sequence: envelope.sequence,
        metadata: { ...metadata, state: "ready" },
      });
    case "resume.started":
      if (
        current.activeRun !== undefined || current.resumeStartedBy !== undefined ||
        current.checkpointStartedBy !== undefined || metadata.checkpointCandidate !== undefined ||
        metadata.state !== "stopped" ||
        metadata.checkpoint === undefined
      ) {
        return new SessionLifecycleProjectionError(
          "A resume can start only from a stopped session with a checkpoint.",
        );
      }
      return Effect.succeed({
        ...current,
        sequence: envelope.sequence,
        resumeStartedBy: envelope.sequence,
      });
    case "resume.completed":
      if (current.resumeStartedBy !== event.startedBy) {
        return new SessionLifecycleProjectionError(
          "resume.completed does not match the active resume operation.",
        );
      }
      return Effect.succeed({
        ...withoutResume(current),
        sequence: envelope.sequence,
        metadata: { ...metadata, state: "ready" },
      });
    case "resume.failed":
      if (current.resumeStartedBy !== event.startedBy) {
        return new SessionLifecycleProjectionError(
          "resume.failed does not match the active resume operation.",
        );
      }
      return Effect.succeed({
        ...withoutResume(current),
        sequence: envelope.sequence,
      });
    case "checkpoint.started":
      if (
        current.resumeStartedBy !== undefined || current.checkpointStartedBy !== undefined ||
        metadata.checkpointCandidate !== undefined
      ) {
        return new SessionLifecycleProjectionError(
          "A checkpoint cannot start while another checkpoint candidate exists.",
        );
      }
      if (current.activeRun !== undefined || metadata.state !== "ready") {
        return new SessionLifecycleProjectionError(
          "A checkpoint can start only while the session is ready and idle.",
        );
      }
      return Effect.succeed({
        sequence: envelope.sequence,
        checkpointStartedBy: envelope.sequence,
        metadata: { ...metadata, checkpointCandidate: { file: event.file } },
      });
    case "checkpoint.published":
      if (
        current.checkpointStartedBy !== event.startedBy ||
        metadata.checkpointCandidate?.file !== event.checkpoint.file
      ) {
        return new SessionLifecycleProjectionError(
          "checkpoint.published does not match the active checkpoint operation.",
        );
      }
      return Effect.succeed({
        sequence: envelope.sequence,
        metadata: {
          ...omitCheckpointCandidate(metadata),
          state: "stopped",
          checkpoint: event.checkpoint,
        },
      });
    case "checkpoint.failed":
      if (current.checkpointStartedBy !== event.startedBy) {
        return new SessionLifecycleProjectionError(
          "checkpoint.failed does not match the active checkpoint operation.",
        );
      }
      return Effect.succeed({
        sequence: envelope.sequence,
        metadata: {
          ...omitCheckpointCandidate(metadata),
          state: event.consumed ? "error" : metadata.state,
        },
      });
    case "checkpoint.interrupted":
      if (current.checkpointStartedBy !== event.startedBy) {
        return new SessionLifecycleProjectionError(
          "checkpoint.interrupted does not match the active checkpoint operation.",
        );
      }
      return Effect.succeed({
        sequence: envelope.sequence,
        metadata: { ...omitCheckpointCandidate(metadata), state: "error" },
      });
    case "checkpoint.invalidated":
      if (metadata.checkpoint?.file !== event.file) {
        return new SessionLifecycleProjectionError(
          "checkpoint.invalidated does not match the current checkpoint.",
        );
      }
      return Effect.succeed({
        ...current,
        sequence: envelope.sequence,
        metadata: { ...omitCheckpoint(metadata), state: "error" },
      });
  }
}

export function provisioningUpdated(
  state: RunnerSessionState,
  checkoutState: RunnerCheckoutState,
  baseCommit?: string,
): SessionLifecycleEvent {
  return {
    type: "provisioning.updated",
    state,
    checkoutState,
    ...(baseCommit === undefined ? {} : { baseCommit }),
  };
}

function omitCheckpointCandidate(
  metadata: RunnerSessionMetadata,
): Omit<RunnerSessionMetadata, "checkpointCandidate"> {
  const { checkpointCandidate: _, ...rest } = metadata;
  return rest;
}

function omitCheckpoint(
  metadata: RunnerSessionMetadata,
): Omit<RunnerSessionMetadata, "checkpoint"> {
  const { checkpoint: _, ...rest } = metadata;
  return rest;
}

function withoutActiveRun(
  projection: SessionLifecycleProjection,
): Omit<SessionLifecycleProjection, "activeRun"> {
  const { activeRun: _, ...rest } = projection;
  return rest;
}

function withoutResume(
  projection: SessionLifecycleProjection,
): Omit<SessionLifecycleProjection, "resumeStartedBy"> {
  const { resumeStartedBy: _, ...rest } = projection;
  return rest;
}
