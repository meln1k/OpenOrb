import { Deferred, Duration, Effect, Predicate, Schedule, Schema } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import type * as SocketServer from "effect/unstable/socket/SocketServer";

export const PERMANENT_REJECTION_CLOSE_CODE = 4401;
const ABNORMAL_CLOSE_CODE = 1006;
const FRAME_LIMIT = 1024 * 1024;

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
  address: { _tag: string; hostname: string; port: number };
  run: (
    handler: (socket: Socket.Socket) => Effect.Effect<unknown, unknown, unknown>,
  ) => Effect.Effect<never, PermanentRejection | TransientDisconnect, unknown>;
}

export function makeOutboundSocketServer(
  socket: Socket.Socket,
  terminal: Deferred.Deferred<never, RunnerRpcStartupError>,
): SocketServer.SocketServer["Service"] {
  const server = {
    address: { _tag: "TcpAddress", hostname: "outbound-websocket", port: 0 },
    run: (handler: (socket: Socket.Socket) => Effect.Effect<unknown, unknown, unknown>) =>
      Effect.gen(function* () {
        const closeCode = yield* Deferred.make<number>();
        const decorated = observeCloseCode(limitSocket(socket, FRAME_LIMIT), closeCode);
        yield* handler(decorated).pipe(
          Effect.ensuring(Deferred.succeed(closeCode, ABNORMAL_CLOSE_CODE)),
          Effect.exit,
        );
        const code = yield* Deferred.await(closeCode);
        if (code === PERMANENT_REJECTION_CLOSE_CODE) {
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
          ),
          while: (error) =>
            Predicate.hasProperty(error, "_tag") && error._tag === "TransientDisconnect",
        }),
        Effect.andThen(Effect.never),
      ),
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
    runRaw: (handler, options) => observe(socket.runRaw(handler, options)),
    run: (handler, options) => observe(socket.run(handler, options)),
    runString: (handler, options) => observe(socket.runString(handler, options)),
    writer: socket.writer,
  });
}

function limitSocket(socket: Socket.Socket, limit: number): Socket.Socket {
  const byteLength = (frame: string | Uint8Array) =>
    Predicate.isString(frame) ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
  return Socket.make({
    runRaw: (handler, options) =>
      socket.runRaw(
        (frame) => byteLength(frame) <= limit ? handler(frame) : closeOverflow(socket),
        options,
      ),
    writer: Effect.map(
      socket.writer,
      (write) => (frame) =>
        Socket.isCloseEvent(frame) || byteLength(frame) <= limit
          ? write(frame)
          : write(new Socket.CloseEvent(4400, "Frame limit exceeded")),
    ),
  });
}

function closeOverflow(socket: Socket.Socket): Effect.Effect<never> {
  Effect.runFork(
    Effect.scoped(
      Effect.flatMap(
        socket.writer,
        (write) => write(new Socket.CloseEvent(4400, "Frame limit exceeded")),
      ),
    ),
  );
  return Effect.never;
}
