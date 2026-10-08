import type { Rpc } from "@cloudflare/workers-types";

// Deno has no Workers runtime. Bundles externalize this import and use celld's real base class.
export abstract class DurableObject<Environment> implements Rpc.DurableObjectBranded {
  declare readonly __DURABLE_OBJECT_BRAND: never;
  constructor(protected ctx: unknown, protected env: Environment) {}
}
