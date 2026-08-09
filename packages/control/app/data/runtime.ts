import { createContextKey, type Middleware } from "remix/router";

import type { Store } from "./store.ts";
import { TokenBucketRateLimiter } from "./token-bucket-rate-limiter.ts";

export interface LoginRateLimiter {
  allow(key: string): boolean;
  reset(key: string): void;
}

export interface ControlRuntime {
  readonly store: Store;
  readonly loginRateLimiter: LoginRateLimiter;
}

export const ControlRuntimeKey = createContextKey<ControlRuntime>();

export function provideControlRuntime(runtime: ControlRuntime): Middleware<{
  key: typeof ControlRuntimeKey;
  value: ControlRuntime;
  property: "controlRuntime";
}> {
  return (context, next) => {
    context.set(ControlRuntimeKey, runtime, { property: "controlRuntime" });
    return next();
  };
}

export function createControlRuntime(store: Store): ControlRuntime {
  return {
    store,
    loginRateLimiter: new TokenBucketRateLimiter({
      tokensPerSecond: 1 / (3 * 60),
      burst: 5,
      maxBuckets: 4096,
    }),
  };
}

export function requestRateLimitKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return request.headers.get("cf-connecting-ip") ?? forwarded ?? "unknown";
}
