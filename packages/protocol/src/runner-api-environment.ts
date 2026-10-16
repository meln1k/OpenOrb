import { Schema } from "effect";

import {
  EnvironmentState,
  GitAuthor,
  OrbSize,
  RunnerEnvironmentSnapshot,
  SessionEnvironmentSecrets,
  SessionId,
  SessionRepositoryUrl,
} from "./runner-api-schemas.ts";

// Environment procedures serve Agent Environment Providers (ADR 0006): the runner supplies compute,
// lifecycle, persistence, and Environment Links, but no agent or project behaviour. A runner dials
// the Session's Environment Link whenever its environment runs.

const SafeMessage = Schema.String.check(
  Schema.isMinLength(1, { message: "Error messages must not be empty." }),
  Schema.isMaxLength(1_000, { message: "Error messages must contain at most 1000 characters." }),
);
const Secret = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
);

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
}) {}

export class EnvironmentControlled extends Schema.Class<EnvironmentControlled>(
  "EnvironmentControlled",
)({
  state: EnvironmentState,
  /** Whether stopping had to force termination and may have lost unsynced writes. */
  forced: Schema.Boolean,
}) {}

export class DeleteEnvironmentPayload extends Schema.Class<DeleteEnvironmentPayload>(
  "DeleteEnvironmentPayload",
)({
  sessionId: SessionId,
}) {}

export class EnvironmentCreated extends Schema.Class<EnvironmentCreated>("EnvironmentCreated")({
  environment: RunnerEnvironmentSnapshot,
}) {}

export class EnvironmentDeleted extends Schema.Class<EnvironmentDeleted>("EnvironmentDeleted")(
  {},
) {}

export class EnvironmentNotFound extends Schema.TaggedError<EnvironmentNotFound>()(
  "EnvironmentNotFound",
  { sessionId: SessionId, message: SafeMessage },
) {}

export class EnvironmentRejected extends Schema.TaggedError<EnvironmentRejected>()(
  "EnvironmentRejected",
  { sessionId: SessionId, message: SafeMessage },
) {}
