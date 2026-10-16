import { Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  CapacityExceeded,
  DeleteFailed,
  RunnerIdentity,
  RunnerIdentityError,
  RunnerStateEvent,
  RunnerWatchError,
  SessionConflict,
} from "./runner-api-schemas.ts";

import {
  ControlEnvironmentPayload,
  CreateEnvironmentPayload,
  DeleteEnvironmentPayload,
  EnvironmentControlled,
  EnvironmentCreated,
  EnvironmentDeleted,
  EnvironmentNotFound,
  EnvironmentRejected,
} from "./runner-api-environment.ts";

export * from "./runner-api-schemas.ts";
export * from "./runner-api-environment.ts";

export class IdentifyRunner extends Rpc.make("runner.identify", {
  success: RunnerIdentity,
  error: RunnerIdentityError,
}) {}

export class WatchRunner extends Rpc.make("runner.watch", {
  success: RunnerStateEvent,
  error: RunnerWatchError,
  stream: true,
}) {}

export class CreateEnvironment extends Rpc.make("environment.create", {
  payload: CreateEnvironmentPayload,
  success: EnvironmentCreated,
  error: Schema.Union([CapacityExceeded, SessionConflict, EnvironmentRejected]),
}) {}

export class ControlEnvironment extends Rpc.make("environment.control", {
  payload: ControlEnvironmentPayload,
  success: EnvironmentControlled,
  error: Schema.Union([EnvironmentNotFound, EnvironmentRejected]),
}) {}

export class DeleteEnvironment extends Rpc.make("environment.delete", {
  payload: DeleteEnvironmentPayload,
  success: EnvironmentDeleted,
  error: Schema.Union([EnvironmentRejected, DeleteFailed]),
}) {}

export const RunnerApi = RpcGroup.make(
  IdentifyRunner,
  WatchRunner,
  CreateEnvironment,
  ControlEnvironment,
  DeleteEnvironment,
);
