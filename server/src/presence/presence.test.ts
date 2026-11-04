import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRedis, silentLog } from "../gateway/testutil.js";
import { Presence } from "./index.js";

describe("Presence", () => {
  const redis = newRedis();
  beforeEach(async () => {
    await redis.flushall();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (nodeId: string, count: () => number, onChange: (n: number) => void, extra = {}): Presence =>
    new Presence({ redis, nodeId, localCount: count, onChange, log: silentLog, ...extra });

  it("sums open sockets across nodes and notifies only on change", async () => {
    let a = 2;
    const b = 3;
    const seenA: number[] = [];
    const pa = make("A", () => a, (n) => seenA.push(n));
    const pb = make("B", () => b, () => {});

    await pb.tick();
    await pa.tick();
    expect(seenA).toEqual([5]);
    await pa.tick(); // unchanged -> no notification
    expect(seenA).toEqual([5]);
    a = 4;
    await pa.tick();
    expect(seenA).toEqual([5, 7]);
  });

  it("drops a node's count when its key expires (crashed node)", async () => {
    const seen: number[] = [];
    const pa = make("A", () => 1, (n) => seen.push(n), { ttlSec: 15 });
    const pb = make("B", () => 4, () => {});
    await pb.tick();
    await pa.tick();
    expect(seen).toEqual([5]);
    await redis.del("sk:presence:node:B"); // simulate TTL expiry
    await pa.tick();
    expect(seen).toEqual([5, 1]);
    expect(await redis.smembers("sk:presence:nodes")).toEqual(["A"]); // stale id pruned
  });

  it("stop() removes this node immediately", async () => {
    const seen: number[] = [];
    const pa = make("A", () => 1, (n) => seen.push(n));
    const pb = make("B", () => 2, () => {});
    await pa.tick();
    await pb.tick();
    await pa.tick();
    await pb.stop();
    await pa.tick();
    expect(seen).toEqual([1, 3, 1]);
  });

  it("throttles to at most one notification per interval even when the count flaps", async () => {
    vi.useFakeTimers();
    let n = 0;
    const seen: number[] = [];
    const p = make("A", () => n, (v) => seen.push(v), { intervalMs: 1000 });
    p.start();
    await vi.advanceTimersByTimeAsync(0); // initial tick: 0
    expect(seen).toEqual([0]);

    n = 1; n = 2; n = 3; // many changes inside one second
    await vi.advanceTimersByTimeAsync(999);
    expect(seen).toEqual([0]); // nothing before the interval elapses
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([0, 3]); // exactly one broadcast carrying the latest value

    await vi.advanceTimersByTimeAsync(5000); // quiet: no more broadcasts
    expect(seen).toEqual([0, 3]);
    await p.stop();
  });
});
