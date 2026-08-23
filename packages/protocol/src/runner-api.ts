import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AbortRejected,
  AbortSessionAccepted,
  AbortSessionPayload,
  CapacityExceeded,
  HistoryReadError,
  PromptRejected,
  PromptSessionAccepted,
  PromptSessionPayload,
  ProvisionRejected,
  ProvisionSessionPayload,
  ProvisionSessionSuccess,
  RunnerIdentity,
  RunnerIdentityError,
  RunnerStateEvent,
  RunnerWatchError,
  SessionConflict,
  SessionCorrupt,
  SessionNotFound,
  WatchSessionEvent,
  WatchSessionPayload,
} from "@/src/runner-api-schemas.ts";

export * from "@/src/runner-api-schemas.ts";
export * from "@/src/runner-api-session-events.ts";

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

export class AbortSession extends Rpc.make("session.abort", {
  payload: AbortSessionPayload,
  success: AbortSessionAccepted,
  error: Schema.Union([SessionNotFound, AbortRejected]),
}) {}

export class WatchSession extends Rpc.make("session.watch", {
  payload: WatchSessionPayload,
  success: WatchSessionEvent,
  error: Schema.Union([SessionNotFound, SessionCorrupt, HistoryReadError]),
  stream: true,
}) {}

export const RunnerApi = RpcGroup.make(
  IdentifyRunner,
  WatchRunner,
  ProvisionSession,
  PromptSession,
  AbortSession,
  WatchSession,
);
