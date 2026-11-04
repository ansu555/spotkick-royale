// Deterministically generates derivation test vectors (bit-exact) into
// packages/shared/vectors/derivation.json. A fixed PRNG seed means the output
// is reproducible across runs. Mirrors the client's data shape in royale.js,
// but resolved with the integer derivation in src/royale-math.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Pick, resolveRound } from "../src/royale-math";

const NUM_CASES = 300;
const SEED = 0x5eedcafe;

// xorshift32 — deterministic, 32-bit unsigned
function xorshift32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

const next = xorshift32(SEED);

function randomSeed(): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 32n) | BigInt(next());
  return v;
}

function randomSeats(): number[] {
  const n = 2 + (next() % 9); // 2..10 alive
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

interface VectorCase {
  seed: string;
  aliveMask: number;
  picks: { seat: number; x: number; y: number; picked: boolean }[];
  saveTable: "default";
  expected: {
    autoPicks: { seat: number; x: number; y: number }[];
    targetX: number;
    targetY: number;
    outcome: "goal" | "saved";
    saveBps: number;
    survivorMask: number;
    radiusMm: number;
  };
}

function randomPicks(alive: number[]): Pick[] {
  return alive.map((seat) => {
    // ~80% of the field gives a pick; the rest exercise auto-pick
    if (next() % 5 === 0) return { seat, x: 0, y: 0, picked: false };
    return {
      seat,
      x: -3500 + (next() % 7001),
      y: 140 + (next() % 2161),
      picked: true,
    };
  });
}

const cases: VectorCase[] = [];
for (let i = 0; i < NUM_CASES; i++) {
  const seedBig = randomSeed();
  const seedHex = "0x" + seedBig.toString(16).padStart(64, "0");
  const alive = randomSeats();
  const aliveMask = maskOf(alive);
  const picks = randomPicks(alive);

  const result = resolveRound(seedBig, picks, aliveMask);

  cases.push({
    seed: seedHex,
    aliveMask,
    picks: picks.map((p) => ({ seat: p.seat, x: p.x, y: p.y, picked: p.picked })),
    saveTable: "default",
    expected: {
      autoPicks: result.autoPicks.map((p) => ({ seat: p.seat, x: p.x, y: p.y })),
      targetX: result.targetX,
      targetY: result.targetY,
      outcome: result.outcome,
      saveBps: result.saveBps,
      survivorMask: result.survivorMask,
      radiusMm: result.radiusMm,
    },
  });
}

const outUrl = new URL("../vectors/derivation.json", import.meta.url);
const outPath = fileURLToPath(outUrl);
mkdirSync(fileURLToPath(new URL("../vectors", import.meta.url)), { recursive: true });
writeFileSync(outPath, JSON.stringify(cases, null, 2) + "\n");

console.log(`wrote ${cases.length} derivation vectors -> ${outPath}`);