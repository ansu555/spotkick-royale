#!/usr/bin/env node
/**
 * Build-time calibration for the penalty game.
 *
 * Measures the goalkeeper's save probability per target cell over the goal mouth and
 * writes a 48-integer basis-point lookup table that a smart contract can store and read
 * instead of simulating the keeper.
 *
 * Grid: 12 columns x 4 rows over the 7.32 m x 2.44 m goal mouth.
 *   x in [-3.66, 3.66] m, y in [0, 2.44] m, row 0 = top.
 *
 * For each cell it fires N shots aimed exactly at the cell centre at a fixed power via the
 * debug hook `window.__penalty.shoot(x, y, power)` -> "goal" | "saved" | "miss"
 * (see NEEDS_HOOK.md), and aggregates P(saved) = saves / N in basis points (0-10000).
 *
 * Usage:
 *   node calibrate.mjs --url http://localhost:8765/?debug&mode=solo --n 300 [--power 0.85] [--headed]
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");

// ---- grid constants (metres) ----
const COLS = 12;
const ROWS = 4;
const GOAL_W = 7.32; // goal mouth width
const GOAL_H = 2.44; // goal mouth height

// cell centre in metres; row 0 = top (largest y)
const cellCenter = (col, row) => ({
  x: -GOAL_W / 2 + (col + 0.5) * (GOAL_W / COLS),
  y: GOAL_H - (row + 0.5) * (GOAL_H / ROWS),
});

// ---- simple CLI parsing ----
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const hasArg = (name) => process.argv.includes(name);

const url = arg("--url", "http://localhost:8765/?debug&mode=solo");
const n = Math.round(Number(arg("--n", "300")));
const power = Number(arg("--power", "0.85"));
const headed = hasArg("--headed");

async function main() {
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n must be a positive integer (got "${arg("--n", "300")}")`);
  if (!Number.isFinite(power) || power < 0 || power > 2) throw new Error(`--power must be in [0, 2] (got "${arg("--power", "0.85")}")`);

  console.log(`calibrate: ${COLS}x${ROWS} grid, ${n} shots/cell, power ${power}`);
  console.log(`url: ${url}`);

  const browser = await chromium.launch({
    headless: !headed,
    args: ["--enable-unsafe-swiftshader"], // allow software WebGL in headless
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.waitForFunction(() => Boolean(window.__penalty), { timeout: 30_000 });
    console.log(`debug hook window.__penalty found`);

    const keeper = await page.evaluate(() => ({
      animated: !!window.__penalty.keeper?.animated,
    }));
    if (!keeper.animated) {
      console.warn("warning: keeper model not loaded yet (static fallback). results may not reflect the rigged animated keeper — check the GLB is served.");
    }

    const hasShoot = await page.evaluate(() => typeof window.__penalty.shoot === "function");
    if (!hasShoot) {
      throw new Error(
        "missing hook: window.__penalty.shoot(x, y, power) is not defined.\n" +
        "The game only exposes { game, ball, keeper, royale, sfx, step } under ?debug (step(n) cannot start a shot).\n" +
        "Add the hook described in tools/calibrate/NEEDS_HOOK.md to main.js, then re-run."
      );
    }

    const table = []; // { col, row, x, y, n, saved, goal, miss, bp } row-major
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const { x, y } = cellCenter(col, row);
        const counts = await page.evaluate(
          ({ x, y, n, power }) => {
            let saved = 0, goal = 0, miss = 0, other = 0;
            for (let i = 0; i < n; i++) {
              const o = window.__penalty.shoot(x, y, power);
              if (o === "saved") saved++;
              else if (o === "goal") goal++;
              else if (o === "miss") miss++;
              else other++;
            }
            return { saved, goal, miss, other };
          },
          { x, y, n, power }
        );
        if (counts.other) console.warn(`\n  (${counts.other} undecided outcomes at c${col} r${row})`);
        const bp = Math.round((counts.saved / n) * 10000);
        table.push({ col, row, x, y, n, saved: counts.saved, goal: counts.goal, miss: counts.miss, bp });
        process.stdout.write(`\rrow ${row}/${ROWS} · col ${col + 1}/${COLS} · P(save) ${(bp / 100).toFixed(1)}%      `);
      }
    }
    console.log("\n");

    writeOutputs(table);
    printHeat(table);
  } finally {
    await browser.close();
  }
}

function writeOutputs(table) {
  mkdirSync(OUT_DIR, { recursive: true });

  const bp = table.map((c) => c.bp); // already row-major
  writeFileSync(join(OUT_DIR, "save-table.json"), JSON.stringify(bp, null, 2) + "\n");

  const csv = [
    "row,col,x_m,y_m,n,saved,goal,miss,p_saved_bp",
    ...table.map((c) =>
      [c.row, c.col, c.x.toFixed(3), c.y.toFixed(3), c.n, c.saved, c.goal, c.miss, c.bp].join(",")
    ),
  ].join("\n") + "\n";
  writeFileSync(join(OUT_DIR, "report.csv"), csv);

  console.log(`wrote ${join(OUT_DIR, "save-table.json")}`);
  console.log(`wrote ${join(OUT_DIR, "report.csv")}`);
  console.log(`human step: review, then copy out/save-table.json -> packages/shared/save-table.json`);
}

function printHeat(table) {
  const shade = (bp) => {
    const p = bp / 100;
    if (p >= 80) return "█";
    if (p >= 60) return "▓";
    if (p >= 40) return "▒";
    if (p >= 20) return "░";
    return "·";
  };
  const num = (bp) => (bp / 100).toFixed(1).padStart(5);
  const colHead = " ".repeat(6) + Array.from({ length: COLS }, (_, c) => `c${c}`.padStart(5)).join("");

  console.log("P(save) % per cell (row 0 = top):");
  console.log(colHead);
  for (let row = 0; row < ROWS; row++) {
    const cells = table.slice(row * COLS, (row + 1) * COLS);
    console.log(`r${row}  ` + cells.map((c) => num(c.bp)).join(""));
  }

  console.log("heat (each cell = 2 block chars):");
  for (let row = 0; row < ROWS; row++) {
    const cells = table.slice(row * COLS, (row + 1) * COLS);
    console.log("  " + cells.map((c) => shade(c.bp) + shade(c.bp)).join(""));
  }
}

main().catch((err) => {
  console.error("\ncalibrate failed: " + (err?.message ?? err));
  process.exitCode = 1;
});