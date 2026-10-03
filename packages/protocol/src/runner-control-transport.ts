import { Effect, Layer, Predicate, Schema } from "effect";
import * as SchemaBinary from "effect/encoding/SchemaBinary";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { MAX_RUNNER_RPC_FRAME_BYTES } from "./runner-api-limits.ts";

// Match Effect's default logical-frame bound; transport chunks remain at most 1 MiB.
export const MAX_RUNNER_RPC_MESSAGE_BYTES = 16 * 1024 * 1024;
export const runnerControlRpcSerializationLayer = Layer.succeed(RpcSerialization.RpcSerialization, {
  contentType: "application/vnd.openorb.rpc+json-framed",
  includesFraming: true,
  codecFor: RpcSerialization.json.codecFor,
  makeUnsafe() {
    const parser = SchemaBinary.parser(Schema.Uint8Array, {
      maxFrameSize: MAX_RUNNER_RPC_MESSAGE_BYTES,
    });
    const encoder = SchemaBinary.encoder(Schema.Uint8Array);
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder("utf-8", { fatal: true });
    return {
      decode(data) {
        if (Predicate.isString(data)) throw new TypeError("Expected binary control data");
        // deno-lint-ignore openorb/no-unknown-returns -- RpcSerialization requires unvalidated values; RPC/schema validation follows decoding.
        return parser.feedSync(data).map((bytes): unknown => JSON.parse(textDecoder.decode(bytes)));
      },
      encode(response) {
        const messages = Array.isArray(response) ? response : [response];
        return messages.length === 0 ? undefined : encoder.encodeMany(
          messages.map((message) => textEncoder.encode(JSON.stringify(message))),
        );
      },
    };
  },
});

/** WebSocket-only: SchemaBinary reassembles these byte chunks before RPC/schema decoding. */
export function runnerControlWebSocket(socket: Socket.Socket): Socket.Socket {
  return Socket.make({
    reader: Effect.gen(function* () {
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      return {
        ...reader,
        pull: reader.pull.pipe(
          Effect.tap((frames) =>
            frames.every((frame) =>
                frame instanceof Uint8Array && frame.byteLength <= MAX_RUNNER_RPC_FRAME_BYTES
              )
              ? Effect.void
              : reject(writer, "Invalid control chunk")
          ),
        ),
      };
    }),
    writer: Effect.map(socket.writer, (writer) => {
      const writeAll: Socket.Writer["writeAll"] = (frames) =>
        Effect.suspend(() => {
          const chunks: Uint8Array[] = [];
          for (const frame of frames) {
            if (!(frame instanceof Uint8Array) || frame.byteLength > MAX_RUNNER_RPC_MESSAGE_BYTES) {
              return reject(writer, "Control message limit exceeded");
            }
            chunks.push(frame.subarray(0, MAX_RUNNER_RPC_FRAME_BYTES));
            for (
              let offset = MAX_RUNNER_RPC_FRAME_BYTES;
              offset < frame.byteLength;
              offset += MAX_RUNNER_RPC_FRAME_BYTES
            ) {
              chunks.push(frame.subarray(offset, offset + MAX_RUNNER_RPC_FRAME_BYTES));
            }
          }
          // Effect's WebSocket writeAll sends synchronously on one captured connection. A loop
          // of effectful writes would allow interleaving, cancellation, or a reconnect mid-frame.
          // SAFETY: frames is nonempty and each frame contributes at least one chunk.
          return writer.writeAll(chunks as [Uint8Array, ...Uint8Array[]]).pipe(
            Effect.tapError(() =>
              writer.write(new Socket.CloseEvent(1011, "Control write failed")).pipe(Effect.ignore)
            ),
          );
        });
      return {
        write: (frame) => Socket.isCloseEvent(frame) ? writer.write(frame) : writeAll([frame]),
        writeAll,
      };
    }),
  });
}

function reject(writer: Socket.Writer, reason: string): Effect.Effect<never, Socket.SocketError> {
  return writer.write(new Socket.CloseEvent(4400, reason)).pipe(
    Effect.andThen(Effect.fail(
      new Socket.SocketError({
        reason: new Socket.SocketCloseError({ code: 4400, closeReason: reason }),
      }),
    )),
  );
}
