import { assert, assertEquals, assertThrows } from "@std/assert";
import { Effect, Exit, Schema, Stream } from "effect";
import * as SchemaBinary from "effect/unstable/encoding/SchemaBinary";
import { Rpc } from "effect/unstable/rpc";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";

import {
  ReadSessionGitPatchChunk,
  ReadSessionGitPatchChunkPayload,
  RunnerBulkApi,
  runnerBulkRpcSerializationLayer,
  SessionGitPatchChunk,
  SessionGitSnapshotId,
} from "@/src/runner-bulk-api.ts";
import {
  RUNNER_PROTOCOL_VERSION,
  RunnerId,
  RunnerIdentity,
  SessionId,
} from "@/src/runner-api-schemas.ts";
import {
  MAX_RUNNER_BULK_CHUNK_BYTES,
  MAX_RUNNER_BULK_RPC_FRAME_BYTES,
  MAX_SESSION_GIT_SNAPSHOT_FULL_PATCH_BYTES,
} from "@/src/runner-api-limits.ts";

const RUNNER_ID = Schema.decodeUnknownSync(RunnerId)(
  "018f47f2-39b1-7b30-8000-000000000001",
);
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "018f47f2-39b1-7b30-8000-000000000011",
);
const SNAPSHOT_ID = Schema.decodeUnknownSync(SessionGitSnapshotId)("a".repeat(64));

Deno.test("bulk patch chunks remain independently frame-bounded", () => {
  const valid = new SessionGitPatchChunk({
    snapshotId: SNAPSHOT_ID,
    section: "unstaged",
    offset: MAX_SESSION_GIT_SNAPSHOT_FULL_PATCH_BYTES - MAX_RUNNER_BULK_CHUNK_BYTES,
    bytes: new Uint8Array(MAX_RUNNER_BULK_CHUNK_BYTES),
    nextOffset: MAX_SESSION_GIT_SNAPSHOT_FULL_PATCH_BYTES,
    done: true,
  });
  assertEquals(
    Schema.decodeUnknownSync(SessionGitPatchChunk)(valid).bytes.length,
    MAX_RUNNER_BULK_CHUNK_BYTES,
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(SessionGitPatchChunk)({
      ...valid,
      bytes: new Uint8Array(MAX_RUNNER_BULK_CHUNK_BYTES + 1),
    })
  );

  const exit = Schema.encodeSync(
    SchemaBinary.toCodec(Rpc.exitSchema(ReadSessionGitPatchChunk)),
  )(Exit.succeed(valid));
  const frame = SchemaBinary.encoder(RpcMessage.EncodedSchema, {
    fingerprint: true,
    dictionary: false,
  }).encode({
    _tag: "Exit",
    requestId: Number.MAX_SAFE_INTEGER,
    exit,
  });
  assert(frame.byteLength <= MAX_RUNNER_BULK_RPC_FRAME_BYTES);
});

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
        tag: "session.git-patch.read-chunk",
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
  }).pipe(Effect.provide(runnerBulkRpcSerializationLayer));
  // SAFETY: the serialization layer supplies the only service used by this test program.
  await Effect.runPromise(program as Effect.Effect<void>);
});

Deno.test("RunnerBulkApi grants one patch chunk per request", async () => {
  const identity = new RunnerIdentity({
    token: "openorb_runner_test-token",
    runnerId: RUNNER_ID,
    runnerVersion: "0.0.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  });
  let reads = 0;
  const handlers = RunnerBulkApi.toLayer({
    "runner.bulk.identify": () => Effect.succeed(identity),
    "runner.bulk.watch": () => Stream.make({ observedAt: 1 }),
    "session.git-patch.read-chunk": (request) => {
      reads++;
      return Effect.succeed(
        new SessionGitPatchChunk({
          ...request,
          bytes: new TextEncoder().encode("chunk"),
          nextOffset: request.offset + 5,
          done: true,
        }),
      );
    },
  });
  const program = Effect.scoped(Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(RunnerBulkApi).pipe(Effect.provide(handlers));
    assertEquals((yield* client["runner.bulk.identify"]()).runnerId, RUNNER_ID);
    assertEquals(
      Array.from(yield* client["runner.bulk.watch"]().pipe(Stream.runCollect))[0]?.observedAt,
      1,
    );
    const chunk = yield* client["session.git-patch.read-chunk"](
      new ReadSessionGitPatchChunkPayload({
        sessionId: SESSION_ID,
        snapshotId: SNAPSHOT_ID,
        section: "unstaged",
        offset: 0,
      }),
    );
    assertEquals(new TextDecoder().decode(chunk.bytes), "chunk");
    assertEquals(reads, 1);
  }));
  // SAFETY: RpcTest supplies the complete in-memory client protocol and all handlers above.
  await Effect.runPromise(program as Effect.Effect<void>);
});
