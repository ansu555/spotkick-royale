// Guards the /fair re-derivation path: apply a real lifecycle whose RoundResolved values are the
// bit-exact output of the shared reference for the same seed/picks/alive-mask, then assert getFair
// recomputes them and marks the round `verified === true`. Also asserts a mismatch is not verified.
import { describe, expect, it, beforeEach } from "vitest";
import { applyBatch } from "../db/apply.js";
import type { DB } from "../db/client.js";
import { getFair } from "../db/queries.js";
import { createTestDb } from "../db/test-db.js";
import { ev, P1, P2, P3 } from "../indexer/test-events.js";
import type { Bytes32 } from "../../../packages/shared/src/royale-math.js";
import { resolveRound as refResolve } from "../../../packages/shared/src/royale-math.js";

const E3 = 3_000_000_000_000_000_000n;
const SEED = ("0x" + "ab".repeat(32)) as Bytes32;
const ALIVE = 0b111; // seats 0,1,2
const PICKS = [
  { seat: 0, x: 100, y: 500, picked: true },
  { seat: 1, x: 200, y: 600, picked: true },
  // seat 2 has no explicit pick -> auto-picked from the seed by both contract and reference
];

let db: DB;
beforeEach(async () => {
  ({ db } = await createTestDb());
});

function lifecycle(targetX: number, targetY: number, outcomeCode: number, survivorMask: number, radiusMm: number, saveBps: number) {
  const pickDeadline = 1026n;
  return [
    ev("GameOpened", { gameId: 1n, tier: 0, entry: E3 }, 100n, 0, 1000n, 1),
    ev("SeatTaken", { gameId: 1n, seat: 0, player: P1 }, 101n, 0, 1001n, 2),
    ev("SeatTaken", { gameId: 1n, seat: 1, player: P2 }, 102n, 0, 1002n, 3),
    ev("SeatTaken", { gameId: 1n, seat: 2, player: P3 }, 103n, 0, 1003n, 4),
    ev("GameStarted", { gameId: 1n, players: 3, pot: 3n * E3 }, 120n, 0, 1019n, 5),
    ev("RoundStarted", { gameId: 1n, round: 1, pickDeadline, aliveMask: ALIVE }, 120n, 1, 1019n, 5),
    ev("PickPlaced", { gameId: 1n, round: 1, seat: 0, x: 100, y: 500, pickCount: 1 }, 121n, 0, 1020n, 6),
    ev("PickPlaced", { gameId: 1n, round: 1, seat: 1, x: 200, y: 600, pickCount: 1 }, 122n, 0, 1021n, 7),
    ev("RoundLocked", { gameId: 1n, round: 1, picksHash: "0x" + "22".repeat(32), entropyRequestId: 5n }, 130n, 0, 1027n, 8),
    ev("SeedReceived", { gameId: 1n, round: 1, seed: SEED }, 131n, 0, 1028n, 9),
    ev("AutoPicked", { gameId: 1n, round: 1, seat: 2, x: 0, y: 0 }, 132n, 0, 1029n, 10), // values irrelevant to recompute
    ev("RoundResolved", { gameId: 1n, round: 1, targetX, targetY, outcome: outcomeCode, survivorMask, radiusMm, saveBps, nextPhaseAt: 1038n }, 132n, 1, 1029n, 10),
  ];
}

describe("getFair verification", () => {
  it("recomputes a real round and verifies it (verified === true)", async () => {
    const expected = refResolve(SEED, PICKS, ALIVE);
    await applyBatch(db, lifecycle(expected.targetX, expected.targetY, expected.outcome === "goal" ? 1 : 2, expected.survivorMask, expected.radiusMm, expected.saveBps), {
      blockNumber: 132n,
      blockHash: null,
    });
    const fair = await getFair(db, 1n);
    expect(fair).not.toBeNull();
    const r = fair![0]!;
    expect(r.verified).toBe(true);
    expect(r.recomputed).toMatchObject({
      target: { x: expected.targetX, y: expected.targetY },
      outcome: expected.outcome,
      saveBps: expected.saveBps,
      survivorMask: expected.survivorMask,
    });
    expect(r.recomputed?.survivorSeats).toEqual(expected.survivorSeats);
    expect(r.seed).toBe(SEED);
    expect(r.userRandomness).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("flags a tampered on-chain result (verified === false)", async () => {
    const expected = refResolve(SEED, PICKS, ALIVE);
    const bogus = { x: expected.targetX, y: expected.targetY + 1 }; // off by one
    await applyBatch(db, lifecycle(bogus.x, bogus.y, expected.outcome === "goal" ? 1 : 2, expected.survivorMask, expected.radiusMm, expected.saveBps), {
      blockNumber: 132n,
      blockHash: null,
    });
    const r = (await getFair(db, 1n))![0]!;
    expect(r.verified).toBe(false);
    expect(r.recomputed).not.toBeNull();
  });
});