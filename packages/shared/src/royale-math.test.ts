import { describe, expect, it } from "vitest";

import { MAX_SEATS } from "./constants";
import {
  Outcome,
  Pick,
  Pos,
  resolveBlast,
  resolveRound,
  SeatPos,
} from "./royale-math";

// ---------------------------------------------------------------------------
// deterministic PRNG (xorshift32) so the "random" cases below are reproducible
// ---------------------------------------------------------------------------
function xorshift32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

function randomSeed(next: () => number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 32n) | BigInt(next());
  return v;
}

function randomSeats(next: () => number): number[] {
  const n = 2 + (next() % 9); // 2..10
  const idx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).sort((a, b) => a - b);
}

function maskOf(seats: number[]): number {
  let m = 0;
  for (const s of seats) m |= 1 << s;
  return m;
}

function popcount(m: number): number {
  let c = 0;
  for (let s = 0; s < MAX_SEATS; s++) if ((m >> s) & 1) c++;
  return c;
}

function seatList(m: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < MAX_SEATS; s++) if ((m >> s) & 1) out.push(s);
  return out;
}

function randomPicks(next: () => number, alive: number[]): Pick[] {
  return alive.map((seat) => {
    if ((next() & 3) === 0) {
      return { seat, x: 0, y: 0, picked: false };
    }
    return {
      seat,
      x: -3500 + (next() % 7001),
      y: 140 + (next() % 2161),
      picked: true,
    };
  });
}

// ---------------------------------------------------------------------------
// float reference port of royale.js resolve() (lines ~487-500), operating in metres
// ---------------------------------------------------------------------------
const FLOAT_BLAST_R = 1.5;

interface FloatPlayer {
  seat: number;
  x: number;
  y: number;
  d: number;
  verdict: "safe" | "out";
}

function floatResolve(
  alive: { seat: number; x: number; y: number }[],
  target: Pos,
  outcome: Outcome,
): number[] {
  const a: FloatPlayer[] = alive.map((p) => ({ ...p, d: 0, verdict: "out" }));
  for (const p of a) p.d = Math.hypot(p.x - target.x, p.y - target.y);
  a.sort((p, q) => p.d - q.d);
  const n = a.length;
  const inside = a.filter((p) => p.d <= FLOAT_BLAST_R).length;
  const lo = Math.max(1, Math.ceil(n * 0.25));
  const hi = Math.max(1, Math.min(n - 1, Math.floor(n * 0.75)));
  const k = Math.min(Math.max(inside, lo), hi);
  a.forEach((p, i) => (p.verdict = (i < k) === (outcome === "goal") ? "safe" : "out"));
  return a
    .filter((p) => p.verdict === "safe")
    .map((p) => p.seat)
    .sort((x, y) => x - y);
}

describe("royale-math properties", () => {
  it("survivors are always between 1 and n-1 (n >= 2), and a subset of the alive seats", () => {
    const next = xorshift32(0xc0ffee);
    for (let iter = 0; iter < 500; iter++) {
      const seed = randomSeed(next);
      const alive = randomSeats(next);
      const n = alive.length;
      const picks = randomPicks(next, alive);
      const result = resolveRound(seed, picks, maskOf(alive));

      expect(result.survivorSeats.length).toBeGreaterThanOrEqual(1);
      expect(result.survivorSeats.length).toBeLessThanOrEqual(n - 1);

      const aliveSet = new Set(alive);
      for (const s of result.survivorSeats) expect(aliveSet.has(s)).toBe(true);

      // no duplicates
      expect(new Set(result.survivorSeats).size).toBe(result.survivorSeats.length);
    }
  });

  it("auto-pick fills exactly the alive seats that had no pick", () => {
    const next = xorshift32(0xdeadbeef);
    for (let iter = 0; iter < 100; iter++) {
      const seed = randomSeed(next);
      const alive = randomSeats(next);
      const picks = randomPicks(next, alive);
      const unpickedInput = new Set(
        picks.filter((p) => !p.picked).map((p) => p.seat),
      );
      const result = resolveRound(seed, picks, maskOf(alive));
      const autoSeats = result.autoPicks.map((p) => p.seat);
      expect(new Set(autoSeats)).toEqual(unpickedInput);
      // auto-picks lie within pick bounds
      for (const p of result.autoPicks) {
        expect(p.x).toBeGreaterThanOrEqual(-3500);
        expect(p.x).toBeLessThanOrEqual(3500);
        expect(p.y).toBeGreaterThanOrEqual(140);
        expect(p.y).toBeLessThanOrEqual(2300);
      }
    }
  });

  it("the lo/hi clamp bounds k for n = 2..10", () => {
    for (let n = 2; n <= 10; n++) {
      const lo = Math.max(1, Math.ceil(n / 4));
      const hi = Math.max(1, Math.min(n - 1, Math.floor((3 * n) / 4)));

      // all seeds far → inside = 0 → k = lo
      const far: SeatPos[] = Array.from({ length: n }, (_, i) => ({
        seat: i,
        x: 100000 + i,
        y: 100000 + i,
      }));
      const farResult = resolveBlast(far, { x: 0, y: 0 }, "goal");
      expect(farResult.inside).toBe(0);
      expect(farResult.k).toBe(lo);
      expect(farResult.survivorSeats.length).toBe(lo);

      // all seeds inside → k = hi
      const near: SeatPos[] = Array.from({ length: n }, (_, i) => ({
        seat: i,
        x: i,
        y: i,
      }));
      const nearResult = resolveBlast(near, { x: 0, y: 0 }, "goal");
      expect(nearResult.inside).toBe(n);
      expect(nearResult.k).toBe(hi);
      expect(nearResult.survivorSeats.length).toBe(hi);

      // a Saved round keeps the complement
      const savedResult = resolveBlast(near, { x: 0, y: 0 }, "saved");
      expect(savedResult.survivorSeats.length).toBe(n - hi);
    }
  });
});

describe("royale-math vs float reference (royale.js resolve)", () => {
  it("agrees on survivor sets when no squared-distance ties exist", () => {
    const next = xorshift32(0x1234abcd);
    let checked = 0;
    for (let iter = 0; iter < 1000 && checked < 300; iter++) {
      const alive = randomSeats(next);
      const mmPicks: SeatPos[] = alive.map((seat) => ({
        seat,
        x: -3500 + (next() % 7001),
        y: 140 + (next() % 2161),
      }));
      const target: Pos = {
        x: -3300 + (next() % 6601),
        y: 250 + (next() % 1901),
      };
      const outcome: Outcome = (next() & 1) === 0 ? "goal" : "saved";

      // skip when two squared distances tie (ordering would be ambiguous)
      const d2 = mmPicks.map((p) => {
        const dx = BigInt(p.x - target.x);
        const dy = BigInt(p.y - target.y);
        return dx * dx + dy * dy;
      });
      if (new Set(d2.map(String)).size !== d2.length) continue;

      const intSurvivors = resolveBlast(mmPicks, target, outcome).survivorSeats; // mm
      const floatSurvivors = floatResolve(
        mmPicks.map((p) => ({ seat: p.seat, x: p.x / 1000, y: p.y / 1000 })),
        { x: target.x / 1000, y: target.y / 1000 },
        outcome,
      );

      expect(intSurvivors).toEqual(floatSurvivors);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});