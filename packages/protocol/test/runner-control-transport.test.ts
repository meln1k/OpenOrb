import { assert, assertEquals, assertThrows } from "@std/assert";
import { Effect, Exit, Schema } from "effect";
import * as SchemaBinary from "effect/encoding/SchemaBinary";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { MAX_RUNNER_RPC_FRAME_BYTES } from "../src/runner-api-limits.ts";
import {
  MAX_RUNNER_RPC_MESSAGE_BYTES,
  runnerControlRpcSerializationLayer,
  runnerControlWebSocket,
} from "../src/runner-control-transport.ts";

Deno.test("control JSON frames round-trip numeric payloads across arbitrary byte boundaries", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const payload = {
        timestamp: 1790938800000,
        counters: [
          2 ** 32 - 1,
          2 ** 32,
          Number.MAX_SAFE_INTEGER,
          Number.MIN_SAFE_INTEGER,
          2 ** 53,
          1e20,
          -1e20,
          Number.MAX_VALUE,
          -1790938800000,
          -0.5,
        ],
        serial: 9007199254740993n,
        text: 'before 🌍漢字 after\n"quoted" \\ lone surrogate: \ud800',
      };
      const codec = serialization.codecFor(Schema.Struct({
        timestamp: Schema.Number,
        counters: Schema.Array(Schema.Number),
        serial: Schema.BigInt,
        text: Schema.String,
      }));
      const message = {
        _tag: "Request",
        id: "42",
        payload: Schema.encodeSync(codec)(payload),
      };
      const sender = serialization.makeUnsafe();
      const wire = sender.encode([message, { _tag: "Ping" }]);
      assert(wire instanceof Uint8Array);
      // Confirm each frame holds a JSON document, independently of our receiver.
      const bodies = SchemaBinary.parser(Schema.Uint8Array).feedSync(wire);
      assertEquals(bodies.length, 2);
      assertEquals(new TextDecoder().decode(bodies[1]!), '{"_tag":"Ping"}');
      const receiver = serialization.makeUnsafe();
      const received = Array.from(wire).flatMap((byte) => receiver.decode(Uint8Array.of(byte)));
      assertEquals(received, [message, { _tag: "Ping" }]);
      assertEquals(Schema.decodeUnknownSync(codec)(message.payload), payload);
      assertEquals(sender.encode([]), undefined);
    }).pipe(Effect.provide(runnerControlRpcSerializationLayer)),
  ));

Deno.test("control framing rejects malformed and oversized input and drops partial reconnect state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const encoder = SchemaBinary.encoder(Schema.Uint8Array);
      assertThrows(() => serialization.makeUnsafe().decode("old JSON protocol"), TypeError);
      assertThrows(() =>
        serialization.makeUnsafe().decode(encoder.encode(new TextEncoder().encode('{"_tag":')))
      );
      // Invalid UTF-8 inside otherwise valid JSON must not silently become a replacement character.
      assertThrows(() =>
        serialization.makeUnsafe().decode(encoder.encode(Uint8Array.of(0x22, 0xff, 0x22)))
      );
      // A CBOR tagged bignum is not accepted as a legacy wire format.
      assertThrows(() =>
        serialization.makeUnsafe().decode(encoder.encode(Uint8Array.of(0xc2, 0x41, 1)))
      );
      const oversized = encoder.encode(new Uint8Array(MAX_RUNNER_RPC_MESSAGE_BYTES));
      // Reject its declared body length as soon as the header arrives, without buffering the body.
      assertThrows(() => serialization.makeUnsafe().decode(oversized.subarray(0, 8)));
      const wire = serialization.makeUnsafe().encode({ _tag: "Ping" });
      assert(wire instanceof Uint8Array);
      const disconnected = serialization.makeUnsafe();
      assertEquals(disconnected.decode(wire.subarray(0, -1)), []);
      const reconnected = serialization.makeUnsafe();
      assertEquals(reconnected.decode(wire), [{ _tag: "Ping" }]);
    }).pipe(Effect.provide(runnerControlRpcSerializationLayer)),
  ));

Deno.test("control socket chunks complete writes atomically and enforces binary size limits", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const limit = MAX_RUNNER_RPC_FRAME_BYTES;
    let incoming: [string | Uint8Array, ...(string | Uint8Array)[]] = [new Uint8Array(limit)];
    const batches: (string | Uint8Array)[][] = [];
    const closes: Socket.CloseEvent[] = [];
    let failWrite = false;
    const socket = runnerControlWebSocket(Socket.make({
      reader: Effect.succeed({ pull: Effect.sync(() => incoming), upgrade: () => Effect.void }),
      writer: Effect.succeed({
        write: (frame) =>
          Effect.sync(() => {
            assert(Socket.isCloseEvent(frame), "data must use one writeAll per logical write");
            closes.push(frame);
          }),
        writeAll: (batch) =>
          Effect.suspend(() => {
            batches.push([...batch]);
            return failWrite
              ? Effect.fail(
                new Socket.SocketError({
                  reason: new Socket.SocketCloseError({ code: 1006 }),
                }),
              )
              : Effect.void;
          }),
      }),
    }));
    const writer = yield* socket.writer;
    for (const size of [limit - 1, limit, limit + 1, 2 * limit + 17]) {
      const frame = Uint8Array.from({ length: size }, (_, index) => index % 251);
      yield* writer.write(frame);
      const batch = batches.at(-1)!;
      assertEquals(batch.length, Math.ceil(size / limit));
      const reconstructed = new Uint8Array(size);
      let offset = 0;
      for (const chunk of batch) {
        assert(chunk instanceof Uint8Array && chunk.byteLength <= limit);
        reconstructed.set(chunk, offset);
        offset += chunk.byteLength;
      }
      assertEquals(reconstructed, frame);
    }
    const first = new Uint8Array(limit + 7).fill(21);
    const second = new Uint8Array(limit + 3).fill(42);
    batches.length = 0;
    yield* Effect.all([writer.write(first), writer.write(second)], { concurrency: "unbounded" });
    assertEquals(batches, [
      [first.subarray(0, limit), first.subarray(limit)],
      [second.subarray(0, limit), second.subarray(limit)],
    ]);
    batches.length = 0;
    assert(Exit.isFailure(
      yield* Effect.exit(writer.writeAll([
        new Uint8Array(1),
        new Uint8Array(MAX_RUNNER_RPC_MESSAGE_BYTES + 1),
      ])),
    ));
    assertEquals(batches, [], "reject the entire batch before sending any prefix");
    const reader = yield* socket.reader;
    assertEquals(yield* reader.pull, incoming);
    incoming = [new Uint8Array(1), new Uint8Array(limit + 1)];
    assert(Exit.isFailure(yield* Effect.exit(reader.pull)));
    incoming = ["text"];
    assert(Exit.isFailure(yield* Effect.exit(reader.pull)));
    assertEquals(closes.map((close) => close.code), [4400, 4400, 4400]);
    failWrite = true;
    assert(Exit.isFailure(yield* Effect.exit(writer.write(first))));
    assertEquals(
      closes.at(-1)?.code,
      1011,
      "failed writes close rather than continue partial frames",
    );
    const close = new Socket.CloseEvent(4401, "rejected");
    yield* writer.write(close);
    assertEquals(closes.at(-1), close);
  }))));
