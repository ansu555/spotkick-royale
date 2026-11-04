// Server-side re-derivation of round fairness against the bit-exact TypeScript reference
// (packages/shared/src/royale-math.ts). Used by GET /api/fair/:id to recompute each resolved
// round's target/outcome/survivors from the stored seed + picks + alive mask, then compare them
// to the values the contract emitted on-chain. This is the server half of the "can anyone verify
// the dice roll" guarantee; the shared math is the single source of truth.
import { resolveRound, SAVE_TABLE, type Outcome } from "../../../packages/shared/src/royale-math.js";

export const VERIFIER_VERSION = "royale-math.v1";

export interface RecomputedRound {
  target: { x: number; y: number };
  outcome: Outcome;
  saveBps: number;
  survivorMask: number;
  survivorSeats: number[];
}

export interface RecomputeInput {
  /** bytes32 entropy for the round (hex 0x…), null before SeedReceived */
  seed: string | null;
  /** alive mask at the start of the round (RoundStarted) */
  aliveMask: number | null;
  /** final explicit (non-auto) pick per seat for the round */
  picks: { seat: number; x: number; y: number }[];
}

/**
 * Recomputes a round's resolution. Returns null when the round was never resolved with entropy
 * (no seed, or no recorded alive mask) — those rounds simply cannot be re-derived.
 *
 * Auto-picks for alive seats with no explicit pick are re-derived from the seed by the shared
 * reference, matching the contract's own `resolveRound`. The input `aliveMask` is the mask at
 * `RoundStarted`; a seat that cashed out mid-picking (round ≥ 2) is not re-added here, which is
 * both rare and exactly the kind of divergence `verified === false` exists to expose.
 */
export function recomputeRound(input: RecomputeInput): RecomputedRound | null {
  if (input.seed === null || input.aliveMask === null) return null;
  const result = resolveRound(
    input.seed as `0x${string}`,
    input.picks.map((p) => ({ seat: p.seat, x: p.x, y: p.y, picked: true })),
    input.aliveMask,
    SAVE_TABLE,
  );
  return {
    target: { x: result.targetX, y: result.targetY },
    outcome: result.outcome,
    saveBps: result.saveBps,
    survivorMask: result.survivorMask,
    survivorSeats: result.survivorSeats,
  };
}