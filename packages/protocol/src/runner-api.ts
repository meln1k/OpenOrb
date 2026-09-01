import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AbortRejected,
  AbortSessionAccepted,
  AbortSessionPayload,
  CapacityExceeded,
  DeleteFailed,
  DeleteRejected,
  DeleteSessionAccepted,
  DeleteSessionPayload,
  GitFileUpdateAccepted,
  GitFileUpdateRejected,
  GitSnapshotReadError,
  HistoryReadError,
  PromptRejected,
  PromptSessionAccepted,
  PromptSessionPayload,
  ProvisionRejected,
  ProvisionSessionPayload,
  ProvisionSessionSuccess,
  ReadSessionGitSnapshotPayload,
  RunnerIdentity,
  RunnerIdentityError,
  RunnerStateEvent,
  RunnerWatchError,
  SessionConflict,
  SessionCorrupt,
  SessionGitSnapshot,
  SessionNotFound,
  StopRejected,
  StopSessionAccepted,
  StopSessionPayload,
  UpdateSessionGitFilePayload,
  WakeRejected,
  WakeSessionAccepted,
  WakeSessionPayload,
  WatchSessionEvent,
  WatchSessionPayload,
} from "./runner-api-schemas.ts";

export * from "./runner-api-schemas.ts";
export * from "./runner-api-session-events.ts";

export class IdentifyRunner extends Rpc.make("runner.identify", {
  success: RunnerIdentity,
  error: RunnerIdentityError,
}) {}

export class WatchRunner extends Rpc.make("runner.watch", {
  success: RunnerStateEvent,
  error: RunnerWatchError,
  stream: true,
}) {}

export class ProvisionSession extends Rpc.make("session.provision", {
  payload: ProvisionSessionPayload,
  success: ProvisionSessionSuccess,
  error: Schema.Union([CapacityExceeded, SessionConflict, ProvisionRejected]),
}) {}

export class PromptSession extends Rpc.make("session.prompt", {
  payload: PromptSessionPayload,
  success: PromptSessionAccepted,
  error: Schema.Union([SessionNotFound, PromptRejected]),
}) {}

export class WakeSession extends Rpc.make("session.wake", {
  payload: WakeSessionPayload,
  success: WakeSessionAccepted,
  error: Schema.Union([SessionNotFound, WakeRejected]),
}) {}

export class AbortSession extends Rpc.make("session.abort", {
  payload: AbortSessionPayload,
  success: AbortSessionAccepted,
  error: Schema.Union([SessionNotFound, AbortRejected]),
}) {}

export class StopSession extends Rpc.make("session.stop", {
  payload: StopSessionPayload,
  success: StopSessionAccepted,
  error: Schema.Union([SessionNotFound, StopRejected]),
}) {}

export class DeleteSession extends Rpc.make("session.delete", {
  payload: DeleteSessionPayload,
  success: DeleteSessionAccepted,
  error: Schema.Union([DeleteRejected, DeleteFailed]),
}) {}

export class WatchSession extends Rpc.make("session.watch", {
  payload: WatchSessionPayload,
  success: WatchSessionEvent,
  error: Schema.Union([SessionNotFound, SessionCorrupt, HistoryReadError]),
  stream: true,
}) {}

export class ReadSessionGitSnapshot extends Rpc.make("session.git-snapshot.read", {
  payload: ReadSessionGitSnapshotPayload,
  success: SessionGitSnapshot,
  error: Schema.Union([SessionNotFound, GitSnapshotReadError]),
}) {}

export class UpdateSessionGitFile extends Rpc.make("session.git-file.update", {
  payload: UpdateSessionGitFilePayload,
  success: GitFileUpdateAccepted,
  error: Schema.Union([SessionNotFound, GitFileUpdateRejected]),
}) {}

export const RunnerApi = RpcGroup.make(
  IdentifyRunner,
  WatchRunner,
  ProvisionSession,
  PromptSession,
  WakeSession,
  AbortSession,
  StopSession,
  DeleteSession,
  WatchSession,
  ReadSessionGitSnapshot,
  UpdateSessionGitFile,
);
