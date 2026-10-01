import { Deferred, Duration, Effect, Predicate, Schedule, Schema } from "effect";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import type * as SocketServer from "effect/socket/SocketServer";
import { MAX_RUNNER_RPC_FRAME_BYTES } from "@openorb/protocol/runner-api-limits";

export const PERMANENT_REJECTION_CLOSE_CODE = 4401;
const ABNORMAL_CLOSE_CODE = 1006;

export class RunnerRpcStartupError
  extends Schema.TaggedError<RunnerRpcStartupError>()("RunnerRpcStartupError", {
    code: Schema.Int,
    message: Schema.String,
  }) {}

class PermanentRejection
  extends Schema.TaggedError<PermanentRejection>()("PermanentRejection", { code: Schema.Int }) {}
class TransientDisconnect
  extends Schema.TaggedError<TransientDisconnect>()("TransientDisconnect", { code: Schema.Int }) {}

interface OutboundSocketServerShape {
  address: NetAddress.SocketAddress;
  run: (
    handler: (socket: Socket.Socket) => Effect.Effect<unknown, unknown, unknown>,
  ) => Effect.Effect<never, PermanentRejection | TransientDisconnect, unknown>;
}

export function makeOutboundSocketServer(
  socket: Socket.Socket,
  terminal: Deferred.Deferred<never, RunnerRpcStartupError>,
  frameLimit = MAX_RUNNER_RPC_FRAME_BYTES,
): SocketServer.SocketServer["Service"] {
  const server = {
    // Synthetic metadata: this adapter uses an outbound connection, not a listener.
    address: NetAddress.socketAddressFromInputUnsafe({ address: "127.0.0.1", port: 0 }),
    run: (handler: (socket: Socket.Socket) => Effect.Effect<unknown, unknown, unknown>) =>
      Effect.suspend(() => {
        let attempt = 0;
        return Effect.gen(function* () {
          attempt++;
          yield* Effect.logInfo("connection.connecting").pipe(
            Effect.annotateLogs({ component: "openorb-runner", attempt }),
          );
          const closeCode = yield* Deferred.make<number>();
          const decorated = observeCloseCode(
            limitSocket(socket, frameLimit),
            closeCode,
          );
          yield* handler(decorated).pipe(
            Effect.ensuring(Deferred.succeed(closeCode, ABNORMAL_CLOSE_CODE)),
            Effect.exit,
          );
          const code = yield* Deferred.await(closeCode);
          yield* Effect.logWarning("connection.disconnected").pipe(
            Effect.annotateLogs({ component: "openorb-runner", attempt, closeCode: code }),
          );
          if (code === PERMANENT_REJECTION_CLOSE_CODE) {
            yield* Effect.logError("connection.auth-rejected").pipe(
              Effect.annotateLogs({ component: "openorb-runner", attempt, closeCode: code }),
            );
            yield* Deferred.fail(
              terminal,
              new RunnerRpcStartupError({
                code,
                message: "Gateway permanently rejected the runner RPC connection.",
              }),
            );
            return yield* new PermanentRejection({ code });
          }
          return yield* new TransientDisconnect({ code });
        }).pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(30)))
              ),
              Schedule.jittered,
              Schedule.modifyDelay(({ duration, input }) =>
                (Predicate.hasProperty(input, "_tag") && input._tag === "TransientDisconnect"
                  ? Effect.logInfo("connection.reconnect-scheduled")
                  : Effect.void).pipe(
                    Effect.annotateLogs({
                      component: "openorb-runner",
                      attempt: attempt + 1,
                      delayMs: Duration.toMillis(duration),
                    }),
                    Effect.as(duration),
                  )
              ),
            ),
            while: (error) =>
              Predicate.hasProperty(error, "_tag") && error._tag === "TransientDisconnect",
          }),
          Effect.andThen(Effect.never),
        );
      }),
  };
  return socketServerService(server);
}

function socketServerService(
  value: OutboundSocketServerShape,
): SocketServer.SocketServer["Service"] {
  // SAFETY: The outbound adapter implements SocketServer's address and polymorphic run contract;
  // its private reconnect errors are intentionally hidden behind the service boundary.
  return eraseOutboundSocketServer(value) as SocketServer.SocketServer["Service"];
}

// deno-lint-ignore openorb/no-unknown-returns -- private leaf erasure for Effect's polymorphic service contract
function eraseOutboundSocketServer(value: OutboundSocketServerShape): unknown {
  return value;
}

function observeCloseCode(
  socket: Socket.Socket,
  closeCode: Deferred.Deferred<number>,
): Socket.Socket {
  const observe = <A, E, R>(effect: Effect.Effect<A, Socket.SocketError | E, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Socket.isSocketError(error) && error.reason._tag === "SocketCloseError"
          ? Deferred.succeed(closeCode, error.reason.code)
          : Effect.void
      ),
    );
  return Socket.make({
    reader: observe(Effect.gen(function* () {
      const reader = yield* socket.reader;
      yield* Effect.logInfo("connection.connected").pipe(
        Effect.annotateLogs({ component: "openorb-runner" }),
      );
      return { ...reader, pull: observe(reader.pull) };
    })),
    writer: socket.writer,
  });
}

function limitSocket(socket: Socket.Socket, limit: number): Socket.Socket {
  const byteLength = (frame: string | Uint8Array) =>
    Predicate.isString(frame) ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
  return Socket.make({
    reader: Effect.gen(function* () {
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      return {
        ...reader,
        pull: reader.pull.pipe(
          Effect.tap((frames) =>
            frames.every((frame) => byteLength(frame) <= limit)
              ? Effect.void
              : closeOverflow(writer)
          ),
        ),
      };
    }),
    writer: Effect.map(
      socket.writer,
      (writer) => ({
        write: (frame) =>
          Socket.isCloseEvent(frame) || byteLength(frame) <= limit
            ? writer.write(frame)
            : writer.write(new Socket.CloseEvent(4400, "Frame limit exceeded")),
        writeAll: (frames) =>
          frames.every((frame) => byteLength(frame) <= limit)
            ? writer.writeAll(frames)
            : writer.write(new Socket.CloseEvent(4400, "Frame limit exceeded")),
      }),
    ),
  });
}

function closeOverflow(writer: Socket.Writer): Effect.Effect<never, Socket.SocketError> {
  return writer.write(new Socket.CloseEvent(4400, "Frame limit exceeded")).pipe(
    Effect.andThen(Effect.fail(
      new Socket.SocketError({
        reason: new Socket.SocketCloseError({ code: 4400, closeReason: "Frame limit exceeded" }),
      }),
    )),
  );
}
