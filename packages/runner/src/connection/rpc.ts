import { runnerWebSocketLayer } from "./websocket.ts";
import { Deferred, Effect, Layer, Stream } from "effect";
import {
  EnvironmentAttachAccepted,
  EnvironmentCreated,
  EnvironmentDeleted,
  RunnerApi,
  type RunnerCapacity,
  type RunnerId,
  RunnerIdentity,
} from "@openorb/protocol/runner-api";
import {
  runnerControlRpcSerializationLayer,
  runnerControlWebSocket,
} from "@openorb/protocol/runner-control-transport";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";

import { EnvironmentSupervisor } from "../environment/session/supervisor.ts";
import { makeOutboundSocketServer, type RunnerRpcStartupError } from "./outbound-socket.ts";
import { watchRunner } from "./runner-watch.ts";

export {
  makeOutboundSocketServer,
  PERMANENT_REJECTION_CLOSE_CODE,
  RunnerRpcStartupError,
} from "./outbound-socket.ts";

export interface RunnerRpcOptions {
  gatewayUrl: string;
  runnerId: RunnerId;
  runnerToken: string;
  runnerVersion: string;
  protocolVersion: number;
  getCapacity: () => Promise<RunnerCapacity>;
}

export const runRunnerRpc = Effect.fn("runRunnerRpc")(function* (options: RunnerRpcOptions) {
  const environments = yield* EnvironmentSupervisor;
  const terminal = yield* Deferred.make<never, RunnerRpcStartupError>();
  const logRejection =
    (operation: string, sessionId: string) => (error: { readonly _tag: string }) =>
      Effect.logWarning(`${operation}.rejected`).pipe(
        Effect.annotateLogs({
          component: "openorb-runner",
          runnerId: options.runnerId,
          sessionId,
          reason: error._tag,
        }),
      );
  const handlers = RunnerApi.toLayer(RunnerApi.of({
    "runner.identify": () =>
      Effect.succeed(
        new RunnerIdentity({
          token: options.runnerToken,
          runnerId: options.runnerId,
          runnerVersion: options.runnerVersion,
          protocolVersion: options.protocolVersion,
        }),
      ),
    "runner.watch": () =>
      watchRunner(options.getCapacity).pipe(
        Stream.provideService(EnvironmentSupervisor, environments),
        Stream.rechunk(1),
      ),
    "environment.create": (payload) =>
      environments.create(payload).pipe(
        Effect.map((environment) => new EnvironmentCreated({ environment })),
        Effect.tapError(logRejection("environment.create", payload.sessionId)),
      ),
    "environment.control": (payload) =>
      environments.control(payload).pipe(
        Effect.tapError(logRejection("environment.control", payload.sessionId)),
      ),
    "environment.attach": (payload) =>
      environments.attach(payload.sessionId, payload.nonce).pipe(
        Effect.as(new EnvironmentAttachAccepted({})),
        Effect.tapError(logRejection("environment.attach", payload.sessionId)),
      ),
    "environment.delete": (payload) =>
      environments.delete(payload.sessionId).pipe(
        Effect.as(new EnvironmentDeleted({})),
        Effect.tapError(logRejection("environment.delete", payload.sessionId)),
      ),
  }));
  const socketUrl = new URL("/api/runners/connect", options.gatewayUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socketLayer = runnerWebSocketLayer(socketUrl.toString());
  const serverLayer = Layer.effect(
    SocketServer.SocketServer,
    Effect.map(
      Socket.Socket,
      (socket) => makeOutboundSocketServer(runnerControlWebSocket(socket), terminal),
    ),
  ).pipe(Layer.provide(socketLayer));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(serverLayer),
    Layer.provide(runnerControlRpcSerializationLayer),
  );
  const launched = Layer.launch(
    RpcServer.layer(RunnerApi).pipe(
      Layer.provide(handlers),
      Layer.provide(protocol),
    ),
  );
  // SAFETY: The assembled RPC layer supplies every service required by the launched server.
  const runnable = launched as Effect.Effect<never>;
  return yield* Effect.raceFirst(runnable, Deferred.await(terminal)).pipe(
    Effect.annotateLogs({ component: "openorb-runner", runnerId: options.runnerId }),
  );
});
