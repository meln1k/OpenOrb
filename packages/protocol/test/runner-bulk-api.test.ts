import { assert, assertEquals, assertThrows } from "@std/assert";
import { Effect, Schema, Stream } from "effect";
import * as SchemaBinary from "effect/encoding/SchemaBinary";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import { RunnerBulkApi, runnerBulkRpcSerializationLayer } from "@/src/runner-bulk-api.ts";
import { RUNNER_PROTOCOL_VERSION, RunnerId, RunnerIdentity } from "@/src/runner-api-schemas.ts";
import { MAX_RUNNER_BULK_RPC_FRAME_BYTES } from "@/src/runner-api-limits.ts";

const RUNNER_ID = Schema.decodeUnknownSync(RunnerId)(
  "018f47f2-39b1-7b30-8000-000000000001",
);
Deno.test("bulk serialization preserves native bytes across traced RPC frames", async () => {
  const program = Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    const payload = new Uint8Array([0, 1, 2, 255]);
    const sender = serialization.makeUnsafe();
    const receiver = serialization.makeUnsafe();
    for (const id of [1, 2]) {
      const message = {
        _tag: "Request",
        id,
        tag: "runner.bulk.watch",
        payload,
        headers: [["x-openorb-test", "repeated"]],
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        sampled: true,
      };
      const frame = sender.encode(message);
      assert(frame instanceof Uint8Array);
      assertEquals(receiver.decode(frame), [message]);
    }
    const oversized = SchemaBinary.encoder(RpcMessage.EncodedSchema, { fingerprint: true }).encode({
      _tag: "Request",
      id: 3,
      tag: "runner.bulk.watch",
      payload: new Uint8Array(MAX_RUNNER_BULK_RPC_FRAME_BYTES + 1),
      headers: [],
    });
    assertThrows(() => serialization.makeUnsafe().decode(oversized));
  }).pipe(Effect.provide(runnerBulkRpcSerializationLayer));
  // SAFETY: the serialization layer supplies the only service used by this test program.
  await Effect.runPromise(program as Effect.Effect<void>);
});

Deno.test("RunnerBulkApi carries only identification and the heartbeat", async () => {
  const identity = new RunnerIdentity({
    token: "openorb_runner_test-token",
    runnerId: RUNNER_ID,
    runnerVersion: "0.0.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  });
  assertEquals(Array.from(RunnerBulkApi.requests.keys()).sort(), [
    "runner.bulk.identify",
    "runner.bulk.watch",
  ]);
  const handlers = RunnerBulkApi.toLayer({
    "runner.bulk.identify": () => Effect.succeed(identity),
    "runner.bulk.watch": () => Stream.make({ observedAt: 1 }),
  });
  const program = Effect.scoped(Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(RunnerBulkApi).pipe(Effect.provide(handlers));
    assertEquals((yield* client["runner.bulk.identify"]()).runnerId, RUNNER_ID);
    assertEquals(
      Array.from(yield* client["runner.bulk.watch"]().pipe(Stream.runCollect))[0]?.observedAt,
      1,
    );
  }));
  // SAFETY: RpcTest supplies the complete in-memory client protocol and all handlers above.
  await Effect.runPromise(program as Effect.Effect<void>);
});
