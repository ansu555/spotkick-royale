import { beforeEach, describe, expect, it } from "vitest";
import { SlidingWindowLimiter, TokenBucket } from "./ratelimit.js";
import { newRedis } from "./testutil.js";

describe("TokenBucket", () => {
  it("allows a burst then refills over time", () => {
    let t = 0;
    const b = new TokenBucket(3, 1, () => t);
    expect([b.tryTake(), b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, true, false]);
    t += 1000;
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    t += 10_000;
    expect([b.tryTake(), b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, true, false]);
  });
});

describe("SlidingWindowLimiter (redis)", () => {
  const redis = newRedis();
  beforeEach(async () => {
    await redis.flushall();
  });

  it("allows `limit` hits per window, rejects the rest with a retry hint, per key", async () => {
    let t = 1_000_000;
    const l = new SlidingWindowLimiter(redis, { prefix: "rl:", limit: 3, windowMs: 6000 }, () => t);
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await l.hit("0xa"));
      t += 100;
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]?.retryAfterMs).toBeGreaterThan(5000);
    expect((await l.hit("0xb")).allowed).toBe(true); // other key unaffected

    t += 6000; // window slides past the first hits
    expect((await l.hit("0xa")).allowed).toBe(true);
  });

  it("a rejected hit does not extend the window", async () => {
    let t = 0;
    const l = new SlidingWindowLimiter(redis, { prefix: "rl2:", limit: 1, windowMs: 1000 }, () => t);
    expect((await l.hit("k")).allowed).toBe(true);
    t = 500;
    expect((await l.hit("k")).allowed).toBe(false);
    t = 1001;
    expect((await l.hit("k")).allowed).toBe(true);
  });
});
