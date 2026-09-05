import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Layer } from "effect";
import * as Socket from "effect/unstable/socket/Socket";

export const runnerWebSocketLayer = (url: string) =>
  Socket.layerWebSocket(url, { closeCodeIsError: () => true }).pipe(
    // Force ws, not the global/native Deno WebSocket: ws enables TCP_NODELAY on setup.
    Layer.provide(NodeSocket.layerWebSocketConstructorWS),
  );
