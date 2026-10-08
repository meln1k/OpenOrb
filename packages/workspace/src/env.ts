import type { DurableObjectNamespace as WorkerNamespace, Rpc } from "@cloudflare/workers-types";

// Generated bindings need this name, but the gateway and runner must keep Deno's Web API types.
declare global {
  type DurableObjectNamespace<T extends Rpc.DurableObjectBranded> = WorkerNamespace<T>;
}

export type Env = Cloudflare.Env;
