import {
  RunId,
  RunnerCheckoutState,
  RunnerId,
  RunnerSessionCreatedAt,
  SessionGitHead,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Schema } from "effect";

import { RunnerSessionDefinition } from "../definition.ts";

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
const operationIdSchema = Schema.String.check(Schema.isUUID());
const runPurposeSchema = Schema.Literals(["initial", "prompt"]);
const resumeContinuationSchema = Schema.Union([
  Schema.TaggedStruct("Wake", {}),
  Schema.TaggedStruct("Prompt", { runId: RunId }),
]);

export type RunnerSessionCheckpointMetadata = typeof checkpointMetadataSchema.Type;
export type RunPurpose = typeof runPurposeSchema.Type;
export type PersistedResumeContinuation = typeof resumeContinuationSchema.Type;

const sessionProvisioningStartedEventSchema = Schema.Struct({
  type: Schema.Literal("session.provisioning-started"),
  id: SessionId,
  definition: RunnerSessionDefinition,
  runnerId: RunnerId,
  createdAt: RunnerSessionCreatedAt,
});
const provisioningRetriedEventSchema = Schema.Struct({
  type: Schema.Literal("provisioning.retried"),
});
const provisioningInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("provisioning.interrupted"),
});
const provisioningFailedEventSchema = Schema.Struct({
  type: Schema.Literal("provisioning.failed"),
});
const restoreFailedEventSchema = Schema.Struct({
  type: Schema.Literal("restore.failed"),
});
const checkoutUpdatedEventSchema = Schema.Struct({
  type: Schema.Literal("checkout.updated"),
  checkoutState: RunnerCheckoutState,
  baseCommit: Schema.optionalKey(SessionGitHead),
});
const wakeStartedEventSchema = Schema.Struct({
  type: Schema.Literal("wake.started"),
  wakeId: operationIdSchema,
});
const wakeCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("wake.completed"),
  wakeId: operationIdSchema,
});
const wakeFailedEventSchema = Schema.Struct({
  type: Schema.Literal("wake.failed"),
  wakeId: operationIdSchema,
});
const wakeInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("wake.interrupted"),
  wakeId: operationIdSchema,
});
const runRequestedEventSchema = Schema.Struct({
  type: Schema.Literal("run.requested"),
  runId: RunId,
  purpose: runPurposeSchema,
});
const runStartedEventSchema = Schema.Struct({
  type: Schema.Literal("run.started"),
  runId: RunId,
  acceptedAt: RunnerSessionCreatedAt,
});
const runStartFailedEventSchema = Schema.Struct({
  type: Schema.Literal("run.start-failed"),
  runId: RunId,
});
const followUpRequestedEventSchema = Schema.Struct({
  type: Schema.Literal("follow-up.requested"),
  runId: RunId,
  followUpId: operationIdSchema,
});
const followUpAcceptedEventSchema = Schema.Struct({
  type: Schema.Literal("follow-up.accepted"),
  runId: RunId,
  followUpId: operationIdSchema,
  acceptedAt: RunnerSessionCreatedAt,
});
const followUpFailedEventSchema = Schema.Struct({
  type: Schema.Literal("follow-up.failed"),
  runId: RunId,
  followUpId: operationIdSchema,
});
const followUpInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("follow-up.interrupted"),
  runId: RunId,
  followUpId: operationIdSchema,
});
const abortRequestedEventSchema = Schema.Struct({
  type: Schema.Literal("abort.requested"),
  runId: RunId,
});
const abortConfirmedEventSchema = Schema.Struct({
  type: Schema.Literal("abort.confirmed"),
  runId: RunId,
});
const abortFailedEventSchema = Schema.Struct({
  type: Schema.Literal("abort.failed"),
  runId: RunId,
});
const runCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("run.completed"),
  runId: RunId,
});
const runFailedEventSchema = Schema.Struct({
  type: Schema.Literal("run.failed"),
  runId: RunId,
});
const runInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("run.interrupted"),
  runId: RunId,
});
const resumeStartedEventSchema = Schema.Struct({
  type: Schema.Literal("resume.started"),
  resumeId: operationIdSchema,
  continuation: resumeContinuationSchema,
});
const resumeCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("resume.completed"),
  resumeId: operationIdSchema,
});
const resumeFailedEventSchema = Schema.Struct({
  type: Schema.Literal("resume.failed"),
  resumeId: operationIdSchema,
});
const resumeInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("resume.interrupted"),
  resumeId: operationIdSchema,
});
const checkpointStartedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.started"),
  file: checkpointFileSchema,
});
const checkpointPublishedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.published"),
  checkpoint: checkpointMetadataSchema,
});
const checkpointFailedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.failed"),
  file: checkpointFileSchema,
  consumed: Schema.Boolean,
});
const checkpointInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.interrupted"),
  file: checkpointFileSchema,
});
const checkpointInvalidatedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.invalidated"),
  file: checkpointFileSchema,
});

export const SessionEvent = Schema.Union([
  sessionProvisioningStartedEventSchema,
  provisioningRetriedEventSchema,
  provisioningInterruptedEventSchema,
  provisioningFailedEventSchema,
  restoreFailedEventSchema,
  checkoutUpdatedEventSchema,
  wakeStartedEventSchema,
  wakeCompletedEventSchema,
  wakeFailedEventSchema,
  wakeInterruptedEventSchema,
  runRequestedEventSchema,
  runStartedEventSchema,
  runStartFailedEventSchema,
  followUpRequestedEventSchema,
  followUpAcceptedEventSchema,
  followUpFailedEventSchema,
  followUpInterruptedEventSchema,
  abortRequestedEventSchema,
  abortConfirmedEventSchema,
  abortFailedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runInterruptedEventSchema,
  resumeStartedEventSchema,
  resumeCompletedEventSchema,
  resumeFailedEventSchema,
  resumeInterruptedEventSchema,
  checkpointStartedEventSchema,
  checkpointPublishedEventSchema,
  checkpointFailedEventSchema,
  checkpointInterruptedEventSchema,
  checkpointInvalidatedEventSchema,
]);
export type SessionEvent = typeof SessionEvent.Type;
