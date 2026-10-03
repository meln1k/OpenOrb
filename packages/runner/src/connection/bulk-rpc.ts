import {
  ArtifactReadError,
  GitPatchReadError,
  RunnerBulkApi,
  runnerBulkRpcSerializationLayer,
  SessionArtifactChunk,
  SessionGitPatchChunk,
} from "@openorb/protocol/runner-bulk-api";
import { RunnerIdentity } from "@openorb/protocol/runner-api";
import {
  MAX_RUNNER_BULK_CHUNK_BYTES,
  MAX_RUNNER_BULK_RPC_FRAME_BYTES,
} from "@openorb/protocol/runner-api-limits";
import { Deferred, Effect, Layer, Predicate, Schedule, Stream } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";

import { RunnerSessionStore } from "../session/store.ts";
import { SessionArtifactStore } from "../session/artifact-store.ts";
import { makeOutboundSocketServer, type RunnerRpcStartupError } from "./outbound-socket.ts";
import type { RunnerRpcOptions } from "./rpc.ts";
import { runnerWebSocketLayer } from "./websocket.ts";

export const runRunnerBulkRpc = Effect.fn("runRunnerBulkRpc")(function* (
  options: RunnerRpcOptions,
) {
  const store = yield* RunnerSessionStore;
  const artifacts = yield* SessionArtifactStore;
  const terminal = yield* Deferred.make<never, RunnerRpcStartupError>();
  const identity = new RunnerIdentity({
    token: options.runnerToken,
    runnerId: options.runnerId,
    runnerVersion: options.runnerVersion,
    protocolVersion: options.protocolVersion,
  });
  const handlers = RunnerBulkApi.toLayer(RunnerBulkApi.of({
    "runner.bulk.identify": () => Effect.succeed(identity),
    "runner.bulk.watch": () =>
      Stream.fromEffect(Effect.sync(() => ({ observedAt: Date.now() }))).pipe(
        Stream.repeat(Schedule.spaced("10 seconds")),
      ),
    "session.git-patch.read-chunk": ({ sessionId, snapshotId, section, offset }) =>
      store.readGitSnapshotPatchChunk(
        sessionId,
        snapshotId,
        section,
        offset,
        MAX_RUNNER_BULK_CHUNK_BYTES,
      ).pipe(
        Effect.map((chunk) =>
          new SessionGitPatchChunk({
            snapshotId,
            section,
            offset,
            bytes: chunk.bytes,
            nextOffset: chunk.nextOffset,
            done: chunk.done,
          })
        ),
        Effect.mapError(() =>
          new GitPatchReadError({
            sessionId,
            message: "The cached Git Snapshot patch is unavailable.",
          })
        ),
      ),
    "session.artifact.read-chunk": ({ sessionId, artifactId, offset }) =>
      artifacts.readChunk(
        sessionId,
        artifactId,
        offset,
        MAX_RUNNER_BULK_CHUNK_BYTES,
      ).pipe(
        Effect.map((chunk) =>
          new SessionArtifactChunk({
            artifact: chunk.artifact,
            offset,
            bytes: chunk.bytes,
          })
        ),
        Effect.mapError(() =>
          new ArtifactReadError({
            sessionId,
            message: "The published session media is unavailable.",
          })
        ),
      ),
  }));
  const socketUrl = new URL("/api/runners/connect/bulk", options.gatewayUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socketLayer = runnerWebSocketLayer(socketUrl.toString());
  const serverLayer = Layer.effect(
    SocketServer.SocketServer,
    Effect.map(
      Socket.Socket,
      (socket) => makeOutboundSocketServer(runnerBulkWebSocket(socket), terminal),
    ),
  ).pipe(Layer.provide(socketLayer));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(serverLayer),
    Layer.provide(runnerBulkRpcSerializationLayer),
  );
  const launched = Layer.launch(
    RpcServer.layer(RunnerBulkApi).pipe(
      Layer.provide(handlers),
      Layer.provide(protocol),
    ),
  );
  // SAFETY: the assembled RPC layer supplies every service required by the launched server.
  const runnable = launched as Effect.Effect<never>;
  return yield* Effect.raceFirst(runnable, Deferred.await(terminal)).pipe(
    Effect.annotateLogs({ component: "openorb-runner", runnerId: options.runnerId }),
  );
});

/** Bulk frames are already bounded chunks; unlike control, they need no transport splitting. */
export function runnerBulkWebSocket(socket: Socket.Socket): Socket.Socket {
  const fits = (frame: string | Uint8Array) =>
    (Predicate.isString(frame) ? new TextEncoder().encode(frame).byteLength : frame.byteLength) <=
      MAX_RUNNER_BULK_RPC_FRAME_BYTES;
  return Socket.make({
    reader: Effect.gen(function* () {
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      return {
        ...reader,
        pull: reader.pull.pipe(
          Effect.tap((frames) => frames.every(fits) ? Effect.void : closeOverflow(writer)),
        ),
      };
    }),
    writer: Effect.map(socket.writer, (writer) => ({
      write: (frame) =>
        Socket.isCloseEvent(frame) || fits(frame) ? writer.write(frame) : closeOverflow(writer),
      writeAll: (frames) => frames.every(fits) ? writer.writeAll(frames) : closeOverflow(writer),
    })),
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
