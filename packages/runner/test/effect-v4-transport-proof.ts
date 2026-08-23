import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import * as DenoSocket from "@effect/platform-deno/DenoSocket";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";

const BoundedString = Schema.String.pipe(Schema.check(Schema.isMaxLength(256)));

export class ProofRunnerIdentity extends Schema.Class<ProofRunnerIdentity>("ProofRunnerIdentity")({
  token: BoundedString,
  runnerId: BoundedString,
  runnerVersion: BoundedString,
  protocolVersion: Schema.Int,
  capabilities: Schema.Array(BoundedString),
}) {}

class IdentifyRunner extends Rpc.make("runner.identify", {
  success: ProofRunnerIdentity,
}) {}

class Echo extends Rpc.make("proof.echo", {
  payload: { value: Schema.String },
  success: Schema.String,
}) {}

class Hang extends Rpc.make("proof.hang", {
  success: Schema.String,
}) {}

class WatchRunner extends Rpc.make("runner.watch", {
  success: Schema.Int,
  stream: true,
}) {}

export const ProofRunnerApi = RpcGroup.make(IdentifyRunner, Echo, Hang, WatchRunner);

class MismatchedEcho extends Rpc.make("proof.echo", {
  payload: { value: Schema.String },
  success: Schema.Int,
}) {}

const MismatchedApi = RpcGroup.make(MismatchedEcho);

export type ProofRunnerClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof ProofRunnerApi>,
  RpcClientError
>;

type MismatchedClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof MismatchedApi>,
  RpcClientError
>;

export const FRAME_LIMIT_CLOSE_CODE = 4400;
export const PERMANENT_REJECTION_CLOSE_CODE = 4401;
export const BOOTSTRAP_TIMEOUT_CLOSE_CODE = 4408;
export const DEFAULT_PROOF_FRAME_LIMIT = 1_024;
export const PERMANENT_REJECTION_REASON = "Runner connection rejected";
export const BOOTSTRAP_TIMEOUT_REASON = "Runner identification timed out";

const FRAME_LIMIT_REASON = "Frame limit exceeded";
const ABNORMAL_CLOSE_CODE = 1006;

export interface RunnerProbe {
  readonly identity: ProofRunnerIdentity;
  readonly calls: {
    identify: number;
    echo: number;
    hang: number;
    watch: number;
  };
  readonly identifyResponded: Deferred.Deferred<void>;
  readonly hangStarted: Queue.Queue<void>;
  readonly watchFinalized: Queue.Queue<void>;
}

export const makeRunnerProbe = Effect.fn("makeRunnerProbe")(
  function* (identity: ProofRunnerIdentity) {
    return {
      identity,
      calls: { identify: 0, echo: 0, hang: 0, watch: 0 },
      identifyResponded: yield* Deferred.make<void>(),
      hangStarted: yield* Queue.unbounded<void>(),
      watchFinalized: yield* Queue.unbounded<void>(),
    } satisfies RunnerProbe;
  },
);

export interface AdmissionPolicy {
  readonly expectedToken: string;
  readonly expectedRunnerId: string;
  readonly expectedProtocolVersion: number;
  readonly timeout: number;
  readonly authenticationGate?: Deferred.Deferred<void>;
}

export interface AdmissionOutcome {
  readonly status: "admitted" | "rejected" | "timeout";
  readonly closeCode?: number;
}

export interface GatewayConnection {
  readonly identity: ProofRunnerIdentity;
  readonly client: ProofRunnerClient;
  readonly mismatchedClient: MismatchedClient;
  readonly close: (code: number, reason?: string) => Effect.Effect<void, Socket.SocketError>;
}

export interface ProofGateway {
  readonly socketUrl: string;
  readonly policies: Queue.Queue<AdmissionPolicy>;
  readonly connections: Queue.Queue<GatewayConnection>;
  readonly outcomes: Queue.Queue<AdmissionOutcome>;
}

export const makeProofGateway = Effect.fn("makeProofGateway")(
  function* (frameLimit = DEFAULT_PROOF_FRAME_LIMIT) {
    const policies = yield* Queue.unbounded<AdmissionPolicy>();
    const connections = yield* Queue.unbounded<GatewayConnection>();
    const outcomes = yield* Queue.unbounded<AdmissionOutcome>();

    const candidateApp = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const baseSocket = yield* request.upgrade;
      const socketClosed = yield* Deferred.make<number>();
      const socket = limitSocket(observeCloseCode(baseSocket, socketClosed), frameLimit);
      const policy = yield* Queue.take(policies);
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryPolicy: Schedule.recurs(0),
      }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerJson),
      );
      const client = yield* RpcClient.make(ProofRunnerApi).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
      const mismatchedClient = yield* RpcClient.make(MismatchedApi).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
      const write = yield* socket.writer;

      const identity = yield* Effect.gen(function* () {
        const identity = yield* client["runner.identify"]();
        if (policy.authenticationGate) {
          yield* Deferred.await(policy.authenticationGate);
        }
        return identity;
      }).pipe(Effect.timeoutOption(policy.timeout));

      if (Option.isNone(identity)) {
        yield* Queue.offer(outcomes, {
          status: "timeout",
          closeCode: BOOTSTRAP_TIMEOUT_CLOSE_CODE,
        });
        yield* write(
          new Socket.CloseEvent(
            BOOTSTRAP_TIMEOUT_CLOSE_CODE,
            BOOTSTRAP_TIMEOUT_REASON,
          ),
        );
        return HttpServerResponse.empty();
      }

      if (
        identity.value.token !== policy.expectedToken ||
        identity.value.runnerId !== policy.expectedRunnerId ||
        identity.value.protocolVersion !== policy.expectedProtocolVersion
      ) {
        yield* Queue.offer(outcomes, {
          status: "rejected",
          closeCode: PERMANENT_REJECTION_CLOSE_CODE,
        });
        yield* write(
          new Socket.CloseEvent(
            PERMANENT_REJECTION_CLOSE_CODE,
            PERMANENT_REJECTION_REASON,
          ),
        );
        return HttpServerResponse.empty();
      }

      yield* Queue.offer(outcomes, { status: "admitted" });
      yield* Queue.offer(connections, {
        identity: identity.value,
        client,
        mismatchedClient,
        close: (code, reason) => write(new Socket.CloseEvent(code, reason)),
      });
      yield* Deferred.await(socketClosed);
      return HttpServerResponse.empty();
    }).pipe(
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty())),
    );

    const denoHttpLayer = DenoHttpServer.layer({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    });
    const live = HttpServer.serve(candidateApp).pipe(
      Layer.provideMerge(denoHttpLayer),
    );
    const context = yield* Layer.build(live);
    const server = Context.get(context, HttpServer.HttpServer);
    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.die("The transport proof requires a TCP test server.");
    }

    return {
      socketUrl: `ws://127.0.0.1:${server.address.port}/api/runners/connect`,
      policies,
      connections,
      outcomes,
    } satisfies ProofGateway;
  },
);

class PermanentRejection extends Schema.TaggedError<PermanentRejection>()("PermanentRejection", {
  code: Schema.Int,
}) {}

class TransientDisconnect extends Schema.TaggedError<TransientDisconnect>()("TransientDisconnect", {
  code: Schema.Int,
}) {}

export interface RunnerLoopResult {
  readonly status: "permanent-rejection" | "retries-exhausted";
  readonly closeCode: number;
  readonly attempts: number;
}

export const maintainProofRunner = Effect.fn("maintainProofRunner")(
  function* (options: {
    readonly socketUrl: string;
    readonly probe: RunnerProbe;
    readonly maxReconnects: number;
    readonly frameLimit?: number;
  }): Effect.fn.Return<RunnerLoopResult> {
    const result = yield* Deferred.make<RunnerLoopResult>();
    const baseSocketLayer = DenoSocket.layerWebSocket(options.socketUrl, {
      closeCodeIsError: () => true,
    });
    const outboundSocketServerLayer = Layer.effect(
      SocketServer.SocketServer,
      Effect.map(
        Socket.Socket,
        (socket) =>
          makeOutboundSocketServer({
            socket,
            result,
            maxReconnects: options.maxReconnects,
            frameLimit: options.frameLimit ?? DEFAULT_PROOF_FRAME_LIMIT,
          }),
      ),
    ).pipe(Layer.provide(baseSocketLayer));
    const protocolLayer = RpcServer.layerProtocolSocketServer.pipe(
      Layer.provide(outboundSocketServerLayer),
      Layer.provide(RpcSerialization.layerJson),
    );
    const rpcServerLayer = RpcServer.layer(ProofRunnerApi).pipe(
      Layer.provide(makeRunnerHandlers(options.probe)),
      Layer.provide(protocolLayer),
    );

    yield* Layer.launch(rpcServerLayer).pipe(Effect.forkChild);
    return yield* Deferred.await(result);
  },
  Effect.scoped,
);

const makeRunnerHandlers = (probe: RunnerProbe) =>
  ProofRunnerApi.toLayer(ProofRunnerApi.of({
    "runner.identify": () =>
      Effect.gen(function* () {
        probe.calls.identify++;
        yield* Deferred.succeed(probe.identifyResponded, undefined);
        return probe.identity;
      }),
    "proof.echo": ({ value }) =>
      Effect.sync(() => {
        probe.calls.echo++;
        return value;
      }),
    "proof.hang": () =>
      Effect.gen(function* () {
        probe.calls.hang++;
        yield* Queue.offer(probe.hangStarted, undefined);
        return yield* Effect.never;
      }),
    "runner.watch": () => {
      probe.calls.watch++;
      return Stream.make(1).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(Queue.offer(probe.watchFinalized, undefined)),
      );
    },
  }));

function makeOutboundSocketServer(
  options: {
    readonly socket: Socket.Socket;
    readonly result: Deferred.Deferred<RunnerLoopResult>;
    readonly maxReconnects: number;
    readonly frameLimit: number;
  },
): SocketServer.SocketServer["Service"] {
  let attempts = 0;

  return {
    address: { _tag: "TcpAddress", hostname: "outbound-websocket", port: 0 },
    run: (handler) => {
      const attempt = Effect.gen(function* () {
        attempts++;
        const closeCode = yield* Deferred.make<number>();
        const socket = limitSocket(
          observeCloseCode(options.socket, closeCode),
          options.frameLimit,
        );
        yield* handler(socket).pipe(
          Effect.ensuring(Deferred.succeed(closeCode, ABNORMAL_CLOSE_CODE)),
          Effect.exit,
        );
        const code = yield* Deferred.await(closeCode);
        if (code === PERMANENT_REJECTION_CLOSE_CODE) {
          return yield* new PermanentRejection({ code });
        }
        return yield* new TransientDisconnect({ code });
      });

      return attempt.pipe(
        Effect.retry({
          schedule: Schedule.recurs(options.maxReconnects),
          while: (error) => error._tag === "TransientDisconnect",
        }),
        Effect.catch((error) => {
          const result: RunnerLoopResult = {
            status: error._tag === "PermanentRejection"
              ? "permanent-rejection"
              : "retries-exhausted",
            closeCode: error.code,
            attempts,
          };
          return Deferred.succeed(options.result, result);
        }),
        Effect.andThen(Effect.never),
      );
    },
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
    runRaw: (handler, options) => observe(socket.runRaw(handler, options)),
    run: (handler, options) => observe(socket.run(handler, options)),
    runString: (handler, options) => observe(socket.runString(handler, options)),
    writer: socket.writer,
  });
}

function limitSocket(socket: Socket.Socket, maximumBytes: number): Socket.Socket {
  const byteLength = (frame: string | Uint8Array) =>
    Predicate.isString(frame) ? new TextEncoder().encode(frame).byteLength : frame.byteLength;

  const runRaw: Socket.Socket["runRaw"] = (handler, options) =>
    socket.runRaw((frame) => {
      if (byteLength(frame) <= maximumBytes) return handler(frame);
      return socket.writer.pipe(
        Effect.flatMap((write) =>
          write(new Socket.CloseEvent(FRAME_LIMIT_CLOSE_CODE, FRAME_LIMIT_REASON))
        ),
        Effect.scoped,
        Effect.orDie,
        Effect.andThen(Effect.never),
      );
    }, options);

  return Socket.make({
    runRaw,
    writer: Effect.map(socket.writer, (write) => (frame) => {
      if (Socket.isCloseEvent(frame) || byteLength(frame) <= maximumBytes) {
        return write(frame);
      }
      return write(new Socket.CloseEvent(FRAME_LIMIT_CLOSE_CODE, FRAME_LIMIT_REASON)).pipe(
        Effect.andThen(Effect.fail(socketCloseError(FRAME_LIMIT_CLOSE_CODE, FRAME_LIMIT_REASON))),
      );
    }),
  });
}

function socketCloseError(code: number, closeReason: string): Socket.SocketError {
  return new Socket.SocketError({
    reason: new Socket.SocketCloseError({ code, closeReason }),
  });
}
