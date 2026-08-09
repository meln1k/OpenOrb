import assert from "node:assert/strict";
import test from "node:test";

import { TokenBucketRateLimiter } from "../app/data/token-bucket-rate-limiter.ts";

test("allows an initial burst and then refills continuously", () => {
  let now = 0;
  const limiter = new TokenBucketRateLimiter({
    tokensPerSecond: 1 / (3 * 60),
    burst: 5,
    now: () => now,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(limiter.allow("client"), true);
  }
  assert.equal(limiter.allow("client"), false);

  now += 3 * 60 * 1000 - 1;
  assert.equal(limiter.allow("client"), false);

  now += 1;
  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), false);
});

test("reset restores a key to a full bucket", () => {
  const limiter = new TokenBucketRateLimiter({
    tokensPerSecond: 1,
    burst: 1,
  });

  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), false);
  limiter.reset("client");
  assert.equal(limiter.allow("client"), true);
});

test("bounds memory by evicting the least recently used bucket", () => {
  const limiter = new TokenBucketRateLimiter({
    tokensPerSecond: 1,
    burst: 1,
    maxBuckets: 2,
    now: () => 0,
  });

  assert.equal(limiter.allow("oldest"), true);
  assert.equal(limiter.allow("recent"), true);
  assert.equal(limiter.allow("oldest"), false);
  assert.equal(limiter.allow("new"), true);

  assert.equal(limiter.allow("recent"), true);
});
