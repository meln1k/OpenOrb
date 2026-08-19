import { createContextKey, type Middleware } from "remix/router";

import type { Store } from "@/app/data/store.ts";
import type { RunnerConnectionRegistry } from "@/app/runner-connection-gateway.ts";
import { TokenBucketRateLimiter } from "@/app/utils/token-bucket-rate-limiter.ts";

export interface LoginRateLimiter {
  allow(key: string): boolean;
  reset(key: string): void;
}

export interface AppServices {
  readonly store: Store;
  readonly runnerConnections: RunnerConnectionRegistry;
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

export function createAppServices(
  store: Store,
  runnerConnections: RunnerConnectionRegistry = disconnectedRunnerRegistry,
): AppServices {
  return {
    store,
    runnerConnections,
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

const disconnectedRunnerRegistry: RunnerConnectionRegistry = {
  getRunnerLiveState: () => null,
  getSessionRunner: () => null,
  getSessionSnapshot: () => null,
  provisionSession: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  subscribeToSessionEvents: () => ({ events: [], unsubscribe() {} }),
  disconnectRunner: () => false,
};

export function requestRateLimitKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return request.headers.get("cf-connecting-ip") ?? forwarded ?? "unknown";
}
