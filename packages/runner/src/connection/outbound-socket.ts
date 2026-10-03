import { Deferred, Duration, Effect, Schedule, Schema } from "effect";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import type * as SocketServer from "effect/socket/SocketServer";

export const PERMANENT_REJECTION_CLOSE_CODE = 4401;
const ABNORMAL_CLOSE_CODE = 1006;

export class RunnerRpcStartupError
  extends Schema.TaggedError<RunnerRpcStartupError>()("RunnerRpcStartupError", {
    code: Schema.Int,
    message: Schema.String,
  }) {}

export function makeOutboundSocketServer(
  socket: Socket.Socket,
  terminal: Deferred.Deferred<never, RunnerRpcStartupError>,
): SocketServer.SocketServer["Service"] {
  return {
    // Synthetic metadata: this adapter uses an outbound connection, not a listener.
    address: NetAddress.socketAddressFromInputUnsafe({ address: "127.0.0.1", port: 0 }),
    run: (handler) =>
      Effect.suspend(() => {
        let attempt = 0;
        return Effect.gen(function* () {
          attempt++;
          yield* Effect.logInfo("connection.connecting").pipe(
            Effect.annotateLogs({ component: "openorb-runner", attempt }),
          );
          const closeCode = yield* Deferred.make<number>();
          const decorated = observeCloseCode(socket, closeCode);
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
            // The owner races terminal against the server and cancels this connection loop.
            return yield* Effect.never;
          }
        }).pipe(
          Effect.repeat(
            Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(30)))
              ),
              Schedule.jittered,
              Schedule.modifyDelay(({ duration }) =>
                Effect.logInfo("connection.reconnect-scheduled").pipe(
                  Effect.annotateLogs({
                    component: "openorb-runner",
                    attempt: attempt + 1,
                    delayMs: Duration.toMillis(duration),
                  }),
                  Effect.as(duration),
                )
              ),
            ),
          ),
          Effect.andThen(Effect.never),
        );
      }),
  };
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
