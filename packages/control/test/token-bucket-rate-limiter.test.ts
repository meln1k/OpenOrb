import { assertEquals } from "@std/assert";

import { TokenBucketRateLimiter } from "../app/data/token-bucket-rate-limiter.ts";

Deno.test("allows an initial burst and then refills continuously", () => {
  let now = 0;
  const limiter = new TokenBucketRateLimiter({
    tokensPerSecond: 1 / (3 * 60),
    burst: 5,
    now: () => now,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assertEquals(limiter.allow("client"), true);
  }
  assertEquals(limiter.allow("client"), false);

  now += 3 * 60 * 1000 - 1;
  assertEquals(limiter.allow("client"), false);

  now += 1;
  assertEquals(limiter.allow("client"), true);
  assertEquals(limiter.allow("client"), false);
});

Deno.test("reset restores a key to a full bucket", () => {
  const limiter = new TokenBucketRateLimiter({
    tokensPerSecond: 1,
    burst: 1,
  });

  assertEquals(limiter.allow("client"), true);
  assertEquals(limiter.allow("client"), false);
  limiter.reset("client");
  assertEquals(limiter.allow("client"), true);
});

Deno.test("bounds memory by evicting the least recently used bucket", () => {
  const limiter = new TokenBucketRateLimiter({
    tokensPerSecond: 1,
    burst: 1,
    maxBuckets: 2,
    now: () => 0,
  });

  assertEquals(limiter.allow("oldest"), true);
  assertEquals(limiter.allow("recent"), true);
  assertEquals(limiter.allow("oldest"), false);
  assertEquals(limiter.allow("new"), true);

  assertEquals(limiter.allow("recent"), true);
});
