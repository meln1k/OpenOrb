import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import { RunnerIdentity } from "./runner-api-schemas.ts";
import { MAX_RUNNER_BULK_RPC_FRAME_BYTES } from "./runner-api-limits.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class IdentifyBulkRunner extends Rpc.make("runner.bulk.identify", {
  success: RunnerIdentity,
}) {}

export class WatchBulkRunner extends Rpc.make("runner.bulk.watch", {
  success: Schema.Struct({ observedAt: NonNegativeInt }),
  stream: true,
}) {}

/**
 * Authentication and heartbeat only. The connection is kept for terminal and preview tunnels;
 * Git patches and media now come from the Session Durable Object (ADRs 0005 and 0006).
 */
export const RunnerBulkApi = RpcGroup.make(IdentifyBulkRunner, WatchBulkRunner);

export const runnerBulkRpcSerializationLayer = RpcSerialization.layerSchemaBinary({
  maxFrameSize: MAX_RUNNER_BULK_RPC_FRAME_BYTES,
});
