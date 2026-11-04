import { describe, expect, it } from "vitest";
import { GAS_HARD_CAP, GAS_TABLE, gasLimitFor } from "./gas.js";
import type { DriverFn } from "./schedule.js";

const fns = Object.keys(GAS_TABLE) as DriverFn[];

describe("gas table", () => {
  it("is positive, monotonic in seats and under the hard cap for every fn", () => {
    for (const fn of fns) {
      let prev = 0n;
      for (let n = 1; n <= 10; n++) {
        const g = gasLimitFor(fn, n);
        expect(g).toBeGreaterThan(prev);
        expect(g).toBeLessThanOrEqual(BigInt(GAS_HARD_CAP));
        prev = g;
      }
    }
  });
  it("clamps seat counts to 1..10", () => {
    expect(gasLimitFor("resolveRound", 0)).toBe(gasLimitFor("resolveRound", 1));
    expect(gasLimitFor("resolveRound", 99)).toBe(gasLimitFor("resolveRound", 10));
  });
  it("is tight: no 10-seat call exceeds 1.2M gas (Monad bills the limit)", () => {
    for (const fn of fns) expect(gasLimitFor(fn, 10)).toBeLessThanOrEqual(1_200_000n);
  });
  it("resolveRound is the most expensive per-seat call", () => {
    for (const fn of fns) expect(GAS_TABLE.resolveRound.perAlive).toBeGreaterThanOrEqual(GAS_TABLE[fn].perAlive);
  });
});
