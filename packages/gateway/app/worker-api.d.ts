import type { DurableObjectNamespace as WorkerNamespace, Rpc } from "@cloudflare/workers-types";

// Generated bindings need these names without replacing Deno's Web APIs in the runner/tests.
declare global {
  type DurableObjectNamespace<T extends Rpc.DurableObjectBranded> = WorkerNamespace<T>;
  type Fetcher = import("./assets.ts").AssetsBinding;
  const WebSocketPair: typeof import("@cloudflare/workers-types").WebSocketPair;
  interface ResponseInit {
    webSocket?: import("@cloudflare/workers-types").WebSocket;
  }
}
