// Monad charges gas on the LIMIT, not on gas used, so every driver call carries an explicit tight limit.
// Numbers are the measured-in-fork upper bounds + ~25% headroom; the pre-send simulation runs with this very
// limit, so an under-sized entry fails loudly in simulation instead of burning gas on-chain.
// Re-measure against the deployed contract (forge test --gas-report / Surfpool-style fork) when it changes.
import type { DriverFn } from "./schedule.js";

export interface GasSpec {
  /** fixed part */
  base: number;
  /** extra per alive seat (storage writes, events, payouts) */
  perAlive: number;
}

export const GAS_TABLE: Readonly<Record<DriverFn, GasSpec>> = {
  startGame: { base: 260_000, perAlive: 12_000 },
  // lockPicks: hashes picks, calls the entropy provider (external call + request storage)
  lockPicks: { base: 420_000, perAlive: 6_000 },
  // resolveRound: auto-picks (event + SSTORE per seat), sort, survivor mask, result storage, maybe finish + 30k-capped push
  resolveRound: { base: 300_000, perAlive: 75_000 },
  advance: { base: 120_000, perAlive: 4_000 },
  // refundStalled: pushes (30k-capped) or credits claimable per seat
  refundStalled: { base: 150_000, perAlive: 60_000 },
};

/** Hard ceiling for any driver tx; a table result above this is a bug. */
export const GAS_HARD_CAP = 3_000_000;

/** `alive` is the number of seats involved (clamped to 1..10). */
export function gasLimitFor(fn: DriverFn, alive: number): bigint {
  const spec = GAS_TABLE[fn];
  const n = Math.min(10, Math.max(1, Math.trunc(alive)));
  const g = spec.base + spec.perAlive * n;
  if (g > GAS_HARD_CAP) throw new RangeError(`gas table entry for ${fn} exceeds hard cap: ${g}`);
  return BigInt(g);
}
