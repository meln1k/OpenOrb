import {
  RunId,
  RunnerCheckoutState,
  RunnerId,
  RunnerSessionCreatedAt,
  SessionGitHead,
  SessionId,
  SessionIssue,
  SessionIssues,
} from "@openorb/protocol/runner-api";
import { Schema } from "effect";

import { RunnerSessionDefinition } from "../definition.ts";

const operationIdSchema = Schema.String.check(Schema.isUUID());
const persistedRestorationContinuationSchema = Schema.Union([
  Schema.TaggedStruct("Wake", {}),
  Schema.TaggedStruct("Prompt", { runId: RunId }),
]);

export type PersistedRestorationContinuation = typeof persistedRestorationContinuationSchema.Type;

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
  issue: SessionIssue,
});
const provisioningFailedEventSchema = Schema.Struct({
  type: Schema.Literal("provisioning.failed"),
  issue: SessionIssue,
});
const restoreFailedEventSchema = Schema.Struct({
  type: Schema.Literal("restore.failed"),
  issue: SessionIssue,
});
const actorCrashedEventSchema = Schema.Struct({
  type: Schema.Literal("actor.crashed"),
  issue: SessionIssue,
});
const issueRecordedEventSchema = Schema.Struct({
  type: Schema.Literal("issue.recorded"),
  issue: SessionIssue,
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
  issue: SessionIssue,
});
const wakeInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("wake.interrupted"),
  wakeId: operationIdSchema,
  issue: SessionIssue,
});
const runRequestedEventSchema = Schema.Struct({
  type: Schema.Literal("run.requested"),
  runId: RunId,
  issues: SessionIssues,
});
const runStartedEventSchema = Schema.Struct({
  type: Schema.Literal("run.started"),
  runId: RunId,
  acceptedAt: RunnerSessionCreatedAt,
});
const runStartFailedEventSchema = Schema.Struct({
  type: Schema.Literal("run.start-failed"),
  runId: RunId,
  issue: SessionIssue,
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
  issue: SessionIssue,
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
  issue: SessionIssue,
});
const runInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("run.interrupted"),
  runId: RunId,
  issue: SessionIssue,
});
const restorationStartedEventSchema = Schema.Struct({
  type: Schema.Literal("restoration.started"),
  restorationId: operationIdSchema,
  continuation: persistedRestorationContinuationSchema,
});
const restorationCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("restoration.completed"),
  restorationId: operationIdSchema,
  issues: SessionIssues,
});
const restorationFailedEventSchema = Schema.Struct({
  type: Schema.Literal("restoration.failed"),
  restorationId: operationIdSchema,
  issue: SessionIssue,
});
const restorationInterruptedEventSchema = Schema.Struct({
  type: Schema.Literal("restoration.interrupted"),
  restorationId: operationIdSchema,
  issue: SessionIssue,
});
const stopStartedEventSchema = Schema.Struct({
  type: Schema.Literal("stop.started"),
  stopId: operationIdSchema,
});
const stopCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("stop.completed"),
  stopId: operationIdSchema,
});
const stopFailedEventSchema = Schema.Struct({
  type: Schema.Literal("stop.failed"),
  stopId: operationIdSchema,
  environmentUsable: Schema.Boolean,
  issue: SessionIssue,
});
export const SessionEvent = Schema.Union([
  sessionProvisioningStartedEventSchema,
  provisioningRetriedEventSchema,
  provisioningInterruptedEventSchema,
  provisioningFailedEventSchema,
  restoreFailedEventSchema,
  actorCrashedEventSchema,
  issueRecordedEventSchema,
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
  restorationStartedEventSchema,
  restorationCompletedEventSchema,
  restorationFailedEventSchema,
  restorationInterruptedEventSchema,
  stopStartedEventSchema,
  stopCompletedEventSchema,
  stopFailedEventSchema,
]);
export type SessionEvent = typeof SessionEvent.Type;
