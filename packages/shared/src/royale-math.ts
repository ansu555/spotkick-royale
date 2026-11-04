// Bit-exact randomness derivation. MUST match bytes-for-bytes the Solidity
// implementation described in docs/INTERFACES.md section 2. Signed integer
// division truncates toward zero (BigInt `/` already does this).
//
//   rand(i) = uint256(keccak256(abi.encode(seed, uint256(i))))
//
// All positions are integer millimetres. `seed` is the round's bytes32 entropy.

import { encodeAbiParameters, keccak256 } from "viem";
import DEFAULT_SAVE_TABLE from "../save-table.json";

import {
  BLAST_R_MM,
  MAX_SEATS,
  PICK_X_MAX,
  PICK_Y_MIN,
  SAVE_GRID_COLS,
  SAVE_GRID_ROWS,
  TARGET_X_MAX,
  TARGET_X_MIN,
  TARGET_Y_MAX,
  TARGET_Y_MIN,
} from "./constants";

/** Round outcome. Lowercase strings to match client conventions (royale.js). */
export type Outcome = "goal" | "saved";

/** A `bytes32`, passed either as a raw bigint (uint256 view) or a 0x hex string. */
export type Bytes32 = bigint | `0x${string}`;

export interface Pos {
  x: number;
  y: number;
}

/** A seat and its (post auto-pick) position, for the blast computation. */
export interface SeatPos extends Pos {
  seat: number;
}

/** A player pick for the round; `picked: false` means no pick (auto-picked). */
export interface Pick extends SeatPos {
  picked: boolean;
}

export interface OutcomeInfo {
  outcome: Outcome;
  saveBps: number;
  col: number;
  row: number;
}

export interface BlastResult {
  survivorSeats: number[]; // ascending
  radiusMm: number; // display only
  k: number; // number kept by the blast
  inside: number; // picks within BLAST_R_MM before clamping
}

export interface ResolveResult {
  autoPicks: SeatPos[]; // ascending seat order
  targetX: number;
  targetY: number;
  outcome: Outcome;
  saveBps: number;
  survivorSeats: number[]; // ascending
  survivorMask: number;
  radiusMm: number;
  k: number;
  inside: number;
}

const BLAST_R2 = BigInt(BLAST_R_MM) * BigInt(BLAST_R_MM); // 1500² mm²

// ---- helpers ------------------------------------------------------------------

function toBytes32Hex(seed: Bytes32): `0x${string}` {
  if (typeof seed === "bigint") {
    return ("0x" + seed.toString(16).padStart(64, "0")) as `0x${string}`;
  }
  const h = seed.startsWith("0x") ? seed.slice(2) : seed;
  return ("0x" + h.padStart(64, "0")) as `0x${string}`;
}

/** Bounds-checked read: the derivation indexes only with clamped/modulo values, so a miss is a bug. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range (length ${arr.length})`);
  return v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampBig(v: bigint, lo: bigint, hi: bigint): bigint {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Integer square root (floor). */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ---- randomness derivation ------------------------------------------------------

/**
 * rand(i) = uint256(keccak256(abi.encode(seed, uint256(i)))).
 * `i` is a uint256 index into the round's random stream.
 */
export function rand(seed: Bytes32, i: number | bigint): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }],
    [toBytes32Hex(seed), BigInt(i)],
  );
  return BigInt(keccak256(encoded));
}

/** Auto-pick for a seat: r = rand(32 + seat). Returns integer mm position. */
export function autoPick(seed: Bytes32, seat: number): Pos {
  const r = rand(seed, 32 + seat);
  const x = -PICK_X_MAX + Number(r % 7001n);
  const y = PICK_Y_MIN + Number((r >> 128n) % 2161n);
  return { x, y };
}

/**
 * Derive the round target (strike/save point).
 * `picks` is aligned with `aliveSeats` (index i is the position of aliveSeats[i]);
 * both are already updated to post-auto-pick positions.
 */
export function deriveTarget(
  seed: Bytes32,
  picks: readonly Pos[],
  aliveSeats: readonly number[],
): Pos & { anchored: boolean } {
  const n = aliveSeats.length;
  const anchored = rand(seed, 0) % 10000n < 6000n;

  let baseX: bigint;
  let baseY: bigint;
  if (anchored) {
    const idx = Number(rand(seed, 1) % BigInt(n));
    const base = at(picks, idx);
    baseX = BigInt(base.x);
    baseY = BigInt(base.y);
  } else {
    baseX = -3300n + (rand(seed, 2) % 6601n);
    baseY = 250n + (rand(seed, 3) % 1901n);
  }

  // noise: four 16-bit chunks c0..c3 = (r >> 16k) & 0xFFFF, s = sum - 131070
  // (range ±131070). noiseX = s_x * 350 / 37837 (signed div, truncate toward zero).
  const noiseX = (noise(rand(seed, 4)) * 350n) / 37837n;
  const noiseY = (noise(rand(seed, 5)) * 250n) / 37837n;

  const x = clampBig(baseX + noiseX, BigInt(TARGET_X_MIN), BigInt(TARGET_X_MAX));
  const y = clampBig(baseY + noiseY, BigInt(TARGET_Y_MIN), BigInt(TARGET_Y_MAX));

  return { x: Number(x), y: Number(y), anchored };
}

function noise(r: bigint): bigint {
  let s = 0n;
  for (let k = 0; k < 4; k++) s += (r >> BigInt(16 * k)) & 0xffffn;
  return s - 131070n;
}

/** Grid cell, save bps and round outcome for a (clamped) target. */
export function outcomeFor(
  seed: Bytes32,
  target: Pos,
  saveTable: readonly number[] = DEFAULT_SAVE_TABLE,
): OutcomeInfo {
  const col = clampInt(Math.trunc(((target.x + 3660) * SAVE_GRID_COLS) / 7320), 0, SAVE_GRID_COLS - 1);
  const row = clampInt(Math.trunc(((2440 - target.y) * SAVE_GRID_ROWS) / 2440), 0, SAVE_GRID_ROWS - 1);
  const saveBps = at(saveTable, row * SAVE_GRID_COLS + col);
  const saved = rand(seed, 6) % 10000n < BigInt(saveBps);
  return { outcome: saved ? "saved" : "goal", saveBps, col, row };
}

/**
 * Blast resolution (spec = royale.js `resolve()`): sort alive seats by squared
 * integer distance then seat (tie-break lower seat first). `inside` = count within
 * BLAST_R_MM. `k = clamp(inside, lo, hi)` where lo = max(1, ceil(n/4)),
 * hi = max(1, min(n-1, floor(3n/4))). Goal keeps the k closest; Saved keeps the
 * other n-k (farthest) seats.
 */
export function resolveBlast(
  alivePicks: readonly SeatPos[],
  target: Pos,
  outcome: Outcome,
): BlastResult {
  const n = alivePicks.length;
  const items = alivePicks.map((p) => {
    const dx = BigInt(p.x - target.x);
    const dy = BigInt(p.y - target.y);
    return { seat: p.seat, d2: dx * dx + dy * dy };
  });
  items.sort((a, b) => (a.d2 < b.d2 ? -1 : a.d2 > b.d2 ? 1 : a.seat - b.seat));

  const inside = items.reduce((acc, it) => (it.d2 <= BLAST_R2 ? acc + 1 : acc), 0);
  const lo = Math.max(1, Math.ceil(n / 4));
  const hi = Math.max(1, Math.min(n - 1, Math.floor((3 * n) / 4)));
  const k = clampInt(inside, lo, hi);

  const survivorSeats: number[] = [];
  if (outcome === "goal") {
    for (let i = 0; i < k; i++) survivorSeats.push(at(items, i).seat);
  } else {
    for (let i = k; i < n; i++) survivorSeats.push(at(items, i).seat);
  }
  survivorSeats.sort((a, b) => a - b);

  const radiusMm =
    k < n
      ? Number((isqrt(at(items, k - 1).d2) + isqrt(at(items, k).d2)) / 2n)
      : Number(isqrt(at(items, n - 1).d2) + 200n);

  return { survivorSeats, radiusMm, k, inside };
}

/**
 * Compose a full round resolution from a seed:
 *  1. auto-pick every alive seat with no pick (rand(32 + seat)),
 *  2. derive the target from the post-auto-pick positions,
 *  3. determine Goal/Saved and saveBps from the save table,
 *  4. blast resolution over the alive seats.
 */
export function resolveRound(
  seed: Bytes32,
  picks: readonly Pick[],
  aliveMask: number,
  saveTable: readonly number[] = DEFAULT_SAVE_TABLE,
): ResolveResult {
  const aliveSeats: number[] = [];
  for (let s = 0; s < MAX_SEATS; s++) if ((aliveMask >> s) & 1) aliveSeats.push(s);

  const posBySeat = new Map<number, Pos>();
  for (const p of picks) if (p.picked) posBySeat.set(p.seat, { x: p.x, y: p.y });

  const autoPicks: SeatPos[] = [];
  for (const s of aliveSeats) {
    if (!posBySeat.has(s)) {
      const pos = autoPick(seed, s);
      posBySeat.set(s, pos);
      autoPicks.push({ seat: s, x: pos.x, y: pos.y });
    }
  }

  const alivePositions = aliveSeats.map((s) => posBySeat.get(s)!);
  const target = deriveTarget(seed, alivePositions, aliveSeats);
  const info = outcomeFor(seed, target, saveTable);
  const blast = resolveBlast(
    alivePositions.map((p, i) => ({ seat: at(aliveSeats, i), x: p.x, y: p.y })),
    target,
    info.outcome,
  );

  let survivorMask = 0;
  for (const s of blast.survivorSeats) survivorMask |= 1 << s;

  return {
    autoPicks,
    targetX: target.x,
    targetY: target.y,
    outcome: info.outcome,
    saveBps: info.saveBps,
    survivorSeats: blast.survivorSeats,
    survivorMask,
    radiusMm: blast.radiusMm,
    k: blast.k,
    inside: blast.inside,
  };
}

/** Default keeper save model (read from save-table.json, row-major 4×12). */
export const SAVE_TABLE: readonly number[] = DEFAULT_SAVE_TABLE;