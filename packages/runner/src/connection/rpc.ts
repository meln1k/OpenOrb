import * as DenoSocket from "@effect/platform-deno/DenoSocket";
import { Deferred, Effect, Layer } from "effect";
import {
  AbortRejected,
  AbortSessionAccepted,
  GitFileUpdateAccepted,
  GitFileUpdateRejected,
  GitSnapshotReadError,
  PromptRejected,
  PromptSessionAccepted,
  RunnerApi,
  type RunnerCapacity,
  type RunnerId,
  RunnerIdentity,
  SessionNotFound,
  WakeRejected,
  WakeSessionAccepted,
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
        }),
      ),
    "runner.watch": () => watchRunner(options),
    "session.provision": (payload) => options.supervisor.provision(payload),
    "session.wake": (payload) =>
      options.store.readMetadata(payload.sessionId).pipe(
        Effect.mapError(() =>
          new SessionNotFound({
            sessionId: payload.sessionId,
            message: "The session does not exist on this runner.",
          })
        ),
        Effect.flatMap((metadata) =>
          metadata.model !== payload.modelRuntime.model
            ? new WakeRejected({
              sessionId: payload.sessionId,
              message: "The session model cannot change during restoration.",
            })
            : options.supervisor.findOrRestoreWorker(payload.sessionId, payload.modelRuntime).pipe(
              Effect.flatMap((worker) =>
                worker ? Effect.succeed(new WakeSessionAccepted({})) : new WakeRejected({
                  sessionId: payload.sessionId,
                  message: "The session environment could not be restored.",
                })
              ),
            )
        ),
      ),
    "session.prompt": (payload) =>
      options.supervisor.findOrRestoreWorker(payload.sessionId, payload.modelRuntime).pipe(
        Effect.flatMap((worker) =>
          worker ? worker.prompt(payload) : Effect.succeed(
            {
              ok: false,
              message: "The session is not ready and idle.",
            } as const,
          )
        ),
        Effect.flatMap((result) =>
          result.ok
            ? Effect.succeed(
              new PromptSessionAccepted({
                clientRequestId: payload.clientRequestId,
                runId: result.runId,
                mode: result.mode,
              }),
            )
            : new PromptRejected({ sessionId: payload.sessionId, message: result.message })
        ),
      ),
    "session.abort": (payload) => {
      const worker = options.supervisor.findWorker(payload.sessionId);
      if (!worker) {
        return new AbortRejected({
          sessionId: payload.sessionId,
          runId: payload.runId,
          message: "That Pi run is no longer active.",
        });
      }
      return worker.abort(payload).pipe(
        Effect.flatMap((result) =>
          result.ok
            ? Effect.succeed(new AbortSessionAccepted({ runId: payload.runId }))
            : new AbortRejected({
              sessionId: payload.sessionId,
              runId: payload.runId,
              message: result.message,
            })
        ),
      );
    },
    "session.git-snapshot.read": ({ sessionId }) =>
      options.store.readMetadata(sessionId).pipe(
        Effect.mapError(() =>
          new SessionNotFound({ sessionId, message: "The session does not exist on this runner." })
        ),
        Effect.andThen(
          options.store.readGitSnapshot(sessionId).pipe(
            Effect.mapError(() =>
              new GitSnapshotReadError({
                sessionId,
                message: "The cached Git Snapshot is unavailable.",
              })
            ),
          ),
        ),
      ),
    "session.git-file.update": (payload) =>
      options.store.readMetadata(payload.sessionId).pipe(
        Effect.mapError(() =>
          new SessionNotFound({
            sessionId: payload.sessionId,
            message: "The session does not exist on this runner.",
          })
        ),
        Effect.andThen(
          options.supervisor.findOrRestoreWorker(payload.sessionId).pipe(
            Effect.flatMap((worker) =>
              worker ? worker.updateGitFile(payload) : Effect.succeed(
                {
                  ok: false,
                  message: "The session environment is unavailable.",
                } as const,
              )
            ),
            Effect.flatMap((result) =>
              result.ok
                ? Effect.succeed(new GitFileUpdateAccepted({}))
                : new GitFileUpdateRejected({
                  sessionId: payload.sessionId,
                  message: result.message,
                })
            ),
          ),
        ),
      ),
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
