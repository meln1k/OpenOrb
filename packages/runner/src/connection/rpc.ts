import { runnerWebSocketLayer } from "./websocket.ts";
import { Deferred, Effect, Layer, Stream } from "effect";
import {
  AbortRejected,
  AbortSessionAccepted,
  DeleteFailed,
  DeleteRejected,
  DeleteSessionAccepted,
  type DeleteSessionPayload,
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
  StopRejected,
  StopSessionAccepted,
  WakeRejected,
  WakeSessionAccepted,
} from "@openorb/protocol/runner-api";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";

import { SessionEvents } from "../session/events.ts";
import { RunnerSessionStore } from "../session/store.ts";
import { SessionSupervisor } from "../session/supervisor.ts";
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
  const store = yield* RunnerSessionStore;
  const supervisor = yield* SessionSupervisor;
  const events = yield* SessionEvents;
  const terminal = yield* Deferred.make<never, RunnerRpcStartupError>();
  const deleteSession = (payload: DeleteSessionPayload) =>
    supervisor.deleteSession(payload.sessionId).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(
          `Runner session ${payload.sessionId} cleanup failed and remains retryable: ${error.message}`,
        )
      ),
      Effect.mapError(() =>
        new DeleteFailed({
          sessionId: payload.sessionId,
          message: "Runner session storage cleanup failed and can be retried.",
        })
      ),
      Effect.flatMap((acceptance) =>
        acceptance.ok
          ? events.publishRemoved(payload.sessionId).pipe(
            Effect.as(new DeleteSessionAccepted({})),
          )
          : new DeleteRejected({ sessionId: payload.sessionId, message: acceptance.message })
      ),
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
        Stream.provideService(RunnerSessionStore, store),
        Stream.provideService(SessionSupervisor, supervisor),
        Stream.provideService(SessionEvents, events),
      ),
    "session.provision": (payload) => supervisor.provision(payload),
    "session.wake": (payload) =>
      store.readMetadata(payload.sessionId).pipe(
        Effect.mapError(() =>
          new SessionNotFound({
            sessionId: payload.sessionId,
            message: "The session does not exist on this runner.",
          })
        ),
        Effect.flatMap((metadata) =>
          metadata.definition.model !== payload.modelRuntime.model
            ? new WakeRejected({
              sessionId: payload.sessionId,
              message: "The session model cannot change during restoration.",
            })
            : supervisor.findOrRestoreActor(payload.sessionId).pipe(
              Effect.flatMap((actor) =>
                actor ? actor.wake(payload) : Effect.succeed(
                  {
                    ok: false,
                    message: "The session environment could not be restored.",
                  } as const,
                )
              ),
              Effect.flatMap((result) =>
                result.ok ? Effect.succeed(new WakeSessionAccepted({})) : new WakeRejected({
                  sessionId: payload.sessionId,
                  message: result.message,
                })
              ),
            )
        ),
      ),
    "session.prompt": (payload) =>
      supervisor.findOrRestoreActor(payload.sessionId).pipe(
        Effect.flatMap((actor) =>
          actor ? actor.prompt(payload) : Effect.succeed(
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
      const actor = supervisor.findActor(payload.sessionId);
      if (!actor) {
        return new AbortRejected({
          sessionId: payload.sessionId,
          runId: payload.runId,
          message: "That Pi run is no longer active.",
        });
      }
      return actor.abort(payload).pipe(
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
    "session.stop": (payload) =>
      supervisor.findOrRestoreActor(payload.sessionId).pipe(
        Effect.flatMap((actor) =>
          actor ? actor.stop(payload) : Effect.succeed(
            {
              ok: false,
              message: "The session is not ready and idle.",
            } as const,
          )
        ),
        Effect.flatMap((result) =>
          result.ok ? Effect.succeed(new StopSessionAccepted({})) : new StopRejected({
            sessionId: payload.sessionId,
            message: result.message,
          })
        ),
      ),
    "session.delete": deleteSession,
    "session.git-snapshot.read": ({ sessionId }) =>
      store.readMetadata(sessionId).pipe(
        Effect.mapError(() =>
          new SessionNotFound({ sessionId, message: "The session does not exist on this runner." })
        ),
        Effect.andThen(
          store.readGitSnapshot(sessionId).pipe(
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
      store.readMetadata(payload.sessionId).pipe(
        Effect.mapError(() =>
          new SessionNotFound({
            sessionId: payload.sessionId,
            message: "The session does not exist on this runner.",
          })
        ),
        Effect.andThen(
          supervisor.findOrRestoreActor(payload.sessionId).pipe(
            Effect.flatMap((actor) =>
              actor ? actor.updateGitFile(payload) : Effect.succeed(
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
    "session.watch": ({ sessionId, afterCursor }) => events.watch(sessionId, afterCursor),
  }));
  const socketUrl = new URL("/api/runners/connect", options.gatewayUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socketLayer = runnerWebSocketLayer(socketUrl.toString());
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
