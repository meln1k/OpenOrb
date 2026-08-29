import { createContextKey, type Middleware } from "remix/router";

import type { Store } from "@/app/data/store.ts";
import type { RunnerRegistryService } from "@/app/runner-registry.ts";
import { TokenBucketRateLimiter } from "@/app/utils/token-bucket-rate-limiter.ts";
import { Effect, Stream } from "effect";

export interface LoginRateLimiter {
  allow(key: string): boolean;
  reset(key: string): void;
}

export interface AppServices {
  readonly store: Store;
  readonly runnerConnections: RunnerRegistryService;
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
  runnerConnections: RunnerRegistryService = disconnectedRunnerRegistry,
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

const disconnectedRunnerRegistry: RunnerRegistryService = {
  getRunnerLiveState: () => Effect.succeed(null),
  getSessionRunner: () => Effect.succeed(null),
  getSessionSnapshot: () => Effect.succeed(null),
  getSessionGitSnapshot: () =>
    Effect.succeed({ status: "unavailable", message: "Runner connections are unavailable." }),
  updateSessionGitFile: () =>
    Effect.succeed({ status: "unavailable", message: "Runner connections are unavailable." }),
  provisionSession: () =>
    Effect.succeed({ status: "unavailable", message: "Runner connections are unavailable." }),
  wakeSession: () =>
    Effect.succeed({ status: "unavailable", message: "Runner connections are unavailable." }),
  promptSession: () =>
    Effect.succeed({ status: "unavailable", message: "Runner connections are unavailable." }),
  abortSession: () =>
    Effect.succeed({ status: "unavailable", message: "Runner connections are unavailable." }),
  watchSession: () => Stream.fail(new Error("Runner connections are unavailable.")),
  disconnectRunner: () => Effect.succeed(false),
};

export function requestRateLimitKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return request.headers.get("cf-connecting-ip") ?? forwarded ?? "unknown";
}
