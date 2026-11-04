# Goalkeeper save-probability calibration

Build-time measurement of the goalkeeper's save probability per target cell over the goal
mouth, so a smart contract can use a static lookup table instead of simulating goalkeeping.

## Grid

- Goal mouth: **7.32 m** wide (x from **-3.66** to **+3.66**) × **2.44 m** high.
- Grid: **12 columns × 4 rows** (48 cells), cell centre in metres.
- Row 0 = top, row 3 = bottom. Row-major ordering in all outputs.

For each cell the script fires N shots aimed exactly at the cell centre at the given power and
records the keeper's outcome (`goal` | `saved` | `miss`). `P(saved) = saves / N` is stored as
basis points (0–10000).

## Prerequisites

1. The debug hook `window.__penalty.shoot(x, y, power)` must exist — see [`NEEDS_HOOK.md`](./NEEDS_HOOK.md).
   The game ships only with `window.__penalty = { game, ball, keeper, royale, sfx, step }`;
   `step(n)` can't start a shot, so the hook is required.
2. Node 18+.

## Install

```bash
cd tools/calibrate
npm install                 # installs playwright
npx playwright install chromium   # one-time browser download (if not already present)
```

## Run

Serve the game from the repo root (any static server, caching disabled — `serve.py` is already set up):

```bash
# from the repo root (/Users/anik/Desktop/penalty)
python3 serve.py 8765
```

Then, in another terminal:

```bash
cd tools/calibrate
node calibrate.mjs --url http://localhost:8765/?debug&mode=solo --n 300
# short form: npm run calibrate
```

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `http://localhost:8765/?debug&mode=solo` | Game URL. Must include `debug` (and `mode=solo` for solo keeper logic). |
| `--n` | `300` | Shots per cell (total = 48 × n). |
| `--power` | `0.85` | Shot power (0–1.25; keeper reads weaker shots more easily). |
| `--headed` | off | Run Chromium headed for debugging instead of headless. |

## Outputs (written to `tools/calibrate/out/`)

- `save-table.json` — 48 integers in basis points (0–10000), row-major (12 per row, row 0 = top).
  This is the lookup table format the contract consumes.
- `report.csv` — per-cell breakdown (`row, col, x_m, y_m, n, saved, goal, miss, p_saved_bp`).
- A console heat table is printed on completion.

## Hand-off

The result is **not** wired into the repo automatically. After review, a human copies
`tools/calibrate/out/save-table.json` to `packages/shared/save-table.json`.