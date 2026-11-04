import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

/** In-memory token bucket (per socket). */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  tryTake(): boolean {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface HitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export class RedisRateLimitError extends Error {
  constructor(detail: string) {
    super(`rate limiter redis failure: ${detail}`);
    this.name = "RedisRateLimitError";
  }
}

/**
 * Multi-node sliding-window limiter on a Redis sorted set (no Lua).
 * Allows `limit` hits per `windowMs`; a rejected hit is removed so it does not extend the window.
 * Concurrent over-limit hits may be rejected conservatively (fails safe).
 */
export class SlidingWindowLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly opts: { prefix: string; limit: number; windowMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  async hit(key: string): Promise<HitResult> {
    const k = `${this.opts.prefix}${key}`;
    const t = this.now();
    const member = `${t}:${randomUUID()}`;
    const res = await this.redis
      .multi()
      .zremrangebyscore(k, 0, t - this.opts.windowMs)
      .zadd(k, t, member)
      .zcard(k)
      .pexpire(k, this.opts.windowMs)
      .exec();
    if (!res) throw new RedisRateLimitError("transaction aborted");
    for (const [err] of res) if (err) throw new RedisRateLimitError(err.message);
    const count = Number(res[2]?.[1] ?? 0);
    if (count <= this.opts.limit) return { allowed: true, retryAfterMs: 0 };

    await this.redis.zrem(k, member);
    const oldest = await this.redis.zrange(k, 0, 0, "WITHSCORES");
    const oldestScore = Number(oldest[1] ?? t);
    return { allowed: false, retryAfterMs: Math.max(0, oldestScore + this.opts.windowMs - t) };
  }
}
