import { createContextKey, type Middleware } from "remix/router";

import type { Store } from "@/app/data/store.ts";
import { TokenBucketRateLimiter } from "@/app/utils/token-bucket-rate-limiter.ts";

export interface LoginRateLimiter {
  allow(key: string): boolean;
  reset(key: string): void;
}

export interface AppServices {
  readonly store: Store;
  readonly loginRateLimiter: LoginRateLimiter;
  readonly runnerEnrollmentRateLimiter: LoginRateLimiter;
}

export const AppServicesKey = createContextKey<AppServices>();

export function provideAppServices(services: AppServices): Middleware<{
  key: typeof AppServicesKey;
  value: AppServices;
  property: "services";
}> {
  return (context, next) => {
    context.set(AppServicesKey, services, { property: "services" });
    return next();
  };
}

export function createAppServices(store: Store): AppServices {
  return {
    store,
    loginRateLimiter: new TokenBucketRateLimiter({
      tokensPerSecond: 1 / (3 * 60),
      burst: 5,
      maxBuckets: 4096,
    }),
    runnerEnrollmentRateLimiter: new TokenBucketRateLimiter({
      tokensPerSecond: 1 / 60,
      burst: 5,
      maxBuckets: 4096,
    }),
  };
}

export function requestRateLimitKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return request.headers.get("cf-connecting-ip") ?? forwarded ?? "unknown";
}
