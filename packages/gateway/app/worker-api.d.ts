import type { DurableObjectNamespace as WorkerNamespace, Rpc } from "@cloudflare/workers-types";

// Generated bindings need these names without replacing Deno's Web APIs in the runner/tests.
declare global {
  type DurableObjectNamespace<T extends Rpc.DurableObjectBranded> = WorkerNamespace<T>;
  type Fetcher = import("./assets.ts").AssetsBinding;
  const WebSocketPair: typeof import("@cloudflare/workers-types").WebSocketPair;
  type R2Bucket = import("@cloudflare/workers-types").R2Bucket;
  type WorkerLoader = import("@cloudflare/workers-types").WorkerLoader;
  type DurableObjectFacets = import("@cloudflare/workers-types").DurableObjectFacets;
  const WebSocketRequestResponsePair:
    typeof import("@cloudflare/workers-types").WebSocketRequestResponsePair;
  interface ResponseInit {
    webSocket?: import("@cloudflare/workers-types").WebSocket;
  }
}
