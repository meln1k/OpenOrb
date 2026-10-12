import { Schema } from "effect";

import { EnvironmentState, SessionEnvironmentRecoveryMode } from "./runner-api-session-events.ts";
import {
  GitAuthor,
  OrbSize,
  RunnerEnvironmentSnapshot,
  SessionEnvironmentSecrets,
  SessionId,
  SessionRepositoryUrl,
  WorkspaceId,
} from "./runner-api-schemas.ts";

// Environment procedures serve Agent Environment Providers (ADR 0006): the runner supplies compute,
// lifecycle, persistence, and Environment Links, but no agent or project behaviour.

const SafeMessage = Schema.String.check(
  Schema.isMinLength(1, { message: "Error messages must not be empty." }),
  Schema.isMaxLength(1_000, { message: "Error messages must contain at most 1000 characters." }),
);
const Secret = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
);

/** A one-time Environment Link attach nonce: 32 random bytes as unpadded base64url. */
export const EnvironmentAttachNonce = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/, {
    message: "Environment attach nonces must be 43 base64url characters.",
  }),
).pipe(Schema.brand("EnvironmentAttachNonce"));
export type EnvironmentAttachNonce = typeof EnvironmentAttachNonce.Type;

export const EnvironmentAction = Schema.Literals(["start", "stop", "restart"]);
export type EnvironmentAction = typeof EnvironmentAction.Type;

/**
 * A project's repository as a runner sees it: it scopes GitHub credential mediation and sets the
 * guest's Git identity. The Session Durable Object performs the clone.
 */
export const SessionRepository = Schema.Struct({
  url: SessionRepositoryUrl,
  gitAuthor: GitAuthor,
});
export type SessionRepository = typeof SessionRepository.Type;

export class CreateEnvironmentPayload extends Schema.Class<CreateEnvironmentPayload>(
  "CreateEnvironmentPayload",
)({
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  orbSize: OrbSize,
  /** Absent for a Session without a project, whose guest gets no GitHub mediation. */
  repository: Schema.optionalKey(SessionRepository),
}) {}

export class ControlEnvironmentPayload extends Schema.Class<ControlEnvironmentPayload>(
  "ControlEnvironmentPayload",
)({
  sessionId: SessionId,
  action: EnvironmentAction,
  /** Transient credentials for egress mediation of the VM this action starts. */
  githubToken: Schema.optionalKey(Secret),
  environmentSecrets: Schema.optionalKey(SessionEnvironmentSecrets),
  recovery: Schema.optionalKey(SessionEnvironmentRecoveryMode),
}) {}

export class EnvironmentControlled extends Schema.Class<EnvironmentControlled>(
  "EnvironmentControlled",
)({
  state: EnvironmentState,
  /** Whether stopping had to force termination and may have lost unsynced writes. */
  forced: Schema.Boolean,
}) {}

export class AttachEnvironmentPayload extends Schema.Class<AttachEnvironmentPayload>(
  "AttachEnvironmentPayload",
)({
  sessionId: SessionId,
  nonce: EnvironmentAttachNonce,
}) {}

export class EnvironmentAttachAccepted extends Schema.Class<EnvironmentAttachAccepted>(
  "EnvironmentAttachAccepted",
)({}) {}

export class DeleteEnvironmentPayload extends Schema.Class<DeleteEnvironmentPayload>(
  "DeleteEnvironmentPayload",
)({
  sessionId: SessionId,
}) {}

export class EnvironmentCreated extends Schema.Class<EnvironmentCreated>("EnvironmentCreated")({
  environment: RunnerEnvironmentSnapshot,
}) {}

export class EnvironmentDeleted
  extends Schema.Class<EnvironmentDeleted>("EnvironmentDeleted")({}) {}

export class EnvironmentNotFound extends Schema.TaggedError<EnvironmentNotFound>()(
  "EnvironmentNotFound",
  { sessionId: SessionId, message: SafeMessage },
) {}

export class EnvironmentRejected extends Schema.TaggedError<EnvironmentRejected>()(
  "EnvironmentRejected",
  { sessionId: SessionId, message: SafeMessage },
) {}
