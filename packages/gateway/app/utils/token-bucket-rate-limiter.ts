export interface TokenBucketRateLimiterOptions {
  readonly tokensPerSecond: number;
  readonly burst: number;
  readonly maxBuckets?: number;
  readonly now?: () => number;
}

type Bucket = {
  tokens: number;
  lastRefillAt: number;
};

/**
 * In-memory keyed token buckets. Each bucket starts full, consumes one token
 * per allowed event, and refills continuously at tokensPerSecond.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly tokensPerSecond: number;
  private readonly burst: number;
  private readonly maxBuckets: number;
  private readonly now: () => number;

  constructor(options: TokenBucketRateLimiterOptions) {
    if (!Number.isFinite(options.tokensPerSecond) || options.tokensPerSecond <= 0) {
      throw new RangeError("tokensPerSecond must be greater than zero.");
    }
    if (!Number.isInteger(options.burst) || options.burst <= 0) {
      throw new RangeError("burst must be a positive integer.");
    }

    const maxBuckets = options.maxBuckets ?? 4096;
    if (!Number.isInteger(maxBuckets) || maxBuckets <= 0) {
      throw new RangeError("maxBuckets must be a positive integer.");
    }

    this.tokensPerSecond = options.tokensPerSecond;
    this.burst = options.burst;
    this.maxBuckets = maxBuckets;
    this.now = options.now ?? (() => performance.now());
  }

  allow(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);

    if (bucket) {
      const elapsedSeconds = Math.max(0, now - bucket.lastRefillAt) / 1000;
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSeconds * this.tokensPerSecond);
      bucket.lastRefillAt = now;
      this.touch(key, bucket);
    } else {
      this.evictIfFull();
      bucket = { tokens: this.burst, lastRefillAt: now };
      this.buckets.set(key, bucket);
    }

    if (bucket.tokens < 1) {
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private touch(key: string, bucket: Bucket): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
  }

  private evictIfFull(): void {
    while (this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.buckets.delete(oldestKey);
    }
  }
}
