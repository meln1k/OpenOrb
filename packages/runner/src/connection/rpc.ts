import * as DenoSocket from "@effect/platform-deno/DenoSocket";
import { Deferred, Effect, Layer } from "effect";
import {
  RunnerApi,
  type RunnerCapacity,
  type RunnerId,
  RunnerIdentity,
} from "@openorb/protocol/runner-api";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";

import type { SessionEvents } from "../session/events.ts";
import type { RunnerSessionStore } from "../session/store.ts";
import type { SessionSupervisor } from "../session/supervisor.ts";
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
