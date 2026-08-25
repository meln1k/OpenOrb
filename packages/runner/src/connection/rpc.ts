import * as DenoSocket from "@effect/platform-deno/DenoSocket";
import { Deferred, Duration, Effect, Layer, Predicate, Schedule, Schema, Stream } from "effect";
import type { RunnerCapacity as LegacyRunnerCapacity } from "@openorb/protocol";
import {
  type RunId,
  RunnerApi,
  RunnerCapacity,
  type RunnerId,
  RunnerIdentity,
  RunnerSessionSnapshot,
  RunnerWatchError,
} from "@openorb/protocol/runner-api";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";

import type { SessionEvents } from "../session/events.ts";
import type { RunnerSessionStore } from "../session/store.ts";
import type { SessionSupervisor } from "../session/supervisor.ts";

export const PERMANENT_REJECTION_CLOSE_CODE = 4401;
const ABNORMAL_CLOSE_CODE = 1006;
const FRAME_LIMIT = 1024 * 1024;
const WATCH_HANDOFF_BUFFER_CAPACITY = "unbounded";

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

export interface RunnerRpcOptions {
  gatewayUrl: string;
  runnerId: RunnerId;
  runnerToken: string;
  runnerVersion: string;
  protocolVersion: number;
  // Capacity's legacy structural type is decoded by the RPC schema at this boundary.
  getCapacity: () => Promise<LegacyRunnerCapacity>;
  store: RunnerSessionStore;
  supervisor: SessionSupervisor;
  events: SessionEvents;
}

export const runRunnerRpc = Effect.fn("runRunnerRpc")(function* (options: RunnerRpcOptions) {
  const terminal = yield* Deferred.make<never, RunnerRpcStartupError>();
  const handlers = RunnerApi.toLayer(RunnerApi.of({
    "runner.identify": () =>
      Effect.succeed(
        new RunnerIdentity({
          token: options.runnerToken,
          runnerId: options.runnerId,
          runnerVersion: options.runnerVersion,
          protocolVersion: options.protocolVersion,
          capabilities: ["session-rpc", "session-events"],
        }),
      ),
    "runner.watch": () => watchRunner(options),
    "session.provision": (payload) => options.supervisor.provision(payload),
    "session.prompt": (payload) => options.supervisor.prompt(payload),
    "session.abort": (payload) => options.supervisor.abort(payload),
    "session.watch": ({ sessionId, afterCursor }) => options.events.watch(sessionId, afterCursor),
  }));
  const socketUrl = new URL("/api/runners/connect", options.gatewayUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socketLayer = DenoSocket.layerWebSocket(socketUrl.toString(), {
    closeCodeIsError: () => true,
  });
  const serverLayer = Layer.effect(
    SocketServer.SocketServer,
    Effect.map(Socket.Socket, (socket) => makeOutboundSocketServer(socket, terminal)),
  ).pipe(Layer.provide(socketLayer));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(serverLayer),
    Layer.provide(RpcSerialization.layerJson),
  );
  const launched = Layer.launch(
    RpcServer.layer(RunnerApi).pipe(
      Layer.provide(handlers),
      Layer.provide(protocol),
    ),
  );
  // SAFETY: The assembled RPC layer supplies every service required by the launched server.
  const runnable = launched as Effect.Effect<never>;
  return yield* Effect.raceFirst(runnable, Deferred.await(terminal));
});

function watchRunner(options: RunnerRpcOptions) {
  return Stream.unwrap(Effect.gen(function* () {
    let revision = 0;
    // Start consuming state notifications before any manifest I/O. The unbounded handoff queue
    // cannot silently slide/drop notifications while the initial snapshot is being assembled.
    const stateChanges = yield* options.events.watchStateChanges().pipe(
      Stream.toQueue({ capacity: WATCH_HANDOFF_BUFFER_CAPACITY }),
    );
    // toQueue runs the source in a child fiber; let it acquire its upstream subscription before
    // manifest loading can expose the handoff point to concurrent publishers.
    yield* Effect.yieldNow;
    const manifest = yield* options.store.loadSessionManifest().pipe(
      Effect.mapError(() =>
        new RunnerWatchError({ message: "Runner manifest could not be read." })
      ),
    );
    const legacyCapacity = yield* readCapacity(options);
    const capacity = yield* Schema.decodeUnknownEffect(RunnerCapacity)(legacyCapacity).pipe(
      Effect.catch(() => new RunnerWatchError({ message: "Runner capacity was invalid." })),
    );
    const sessions = manifest.sessions.map((session) => {
      const activeRunId = options.supervisor.getActiveRunId(session.id);
      return {
        type: "snapshot.session" as const,
        session: withActiveRun(session, activeRunId),
      };
    });
    const snapshot = Stream.fromIterable([...sessions, {
      type: "snapshot.complete" as const,
      revision,
      sessionCount: sessions.length,
      observedAt: Date.now(),
      capacity,
    }]);
    const lastSessionValues = new Map(
      sessions.map(({ session }) => [session.id, JSON.stringify(session)]),
    );
    const observed = Stream.fromEffect(readCapacity(options)).pipe(
      Stream.repeat(Schedule.spaced("10 seconds")),
      Stream.mapEffect((capacity) =>
        Schema.decodeUnknownEffect(RunnerCapacity)(capacity).pipe(
          Effect.catch(() => new RunnerWatchError({ message: "Runner capacity was invalid." })),
        )
      ),
      Stream.map((capacity) => ({
        type: "runner.observed" as const,
        revision: ++revision,
        observedAt: Date.now(),
        capacity,
      })),
    );
    // The same queue first drains notifications buffered during the snapshot and then remains the
    // live source, so there is no second subscription boundary where an update can disappear.
    const sessionUpdates = Stream.fromQueue(stateChanges).pipe(
      Stream.mapEffect((sessionId) =>
        options.store.getSessionSnapshot(sessionId).pipe(
          Effect.mapError(() =>
            new RunnerWatchError({ message: "Runner session state could not be read." })
          ),
          Effect.map((session) => {
            const activeRunId = options.supervisor.getActiveRunId(session.id);
            const current = withActiveRun(session, activeRunId);
            const encoded = JSON.stringify(current);
            if (lastSessionValues.get(current.id) === encoded) return null;
            lastSessionValues.set(current.id, encoded);
            return current;
          }),
        )
      ),
      Stream.filter(Predicate.isNotNull),
      Stream.map((session) => ({
        type: "session.updated" as const,
        revision: ++revision,
        session,
      })),
    );
    return Stream.concat(snapshot, Stream.merge(observed, sessionUpdates));
  }));
}

function withActiveRun(
  session: RunnerSessionSnapshot,
  activeRunId: string | undefined,
): RunnerSessionSnapshot {
  if (session.state !== "running" || activeRunId === undefined) return session;
  // SAFETY: Active Pi run identifiers are generated UUIDs and satisfy the RunId brand.
  const runId = activeRunId as RunId;
  return new RunnerSessionSnapshot({ ...session, activeRunId: runId });
}

function readCapacity(options: RunnerRpcOptions) {
  return Effect.callback<LegacyRunnerCapacity, RunnerWatchError>((resume) => {
    options.getCapacity().then(
      (capacity) => resume(Effect.succeed(capacity)),
      () => resume(capacityReadFailure()),
    );
  });
}

function capacityReadFailure(): Effect.Effect<never, RunnerWatchError> {
  return new RunnerWatchError({ message: "Runner capacity could not be read." });
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
