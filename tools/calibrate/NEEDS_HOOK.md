# Calibration hook — implemented

`calibrate.mjs` drives the game through the browser, so it needs a way to **fire** a shot
programmatically. That hook is now implemented in `main.js`.

## What `window.__penalty` exposes today

`main.js` (near the end) builds this when the URL has `?debug`:

```js
window.__penalty = { game, ball, keeper, royale, sfx, net,
  step: (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) simulate(dt); },
  shoot: (x, y, power) => { ... } };
```

- `step(n)` can fast-forward an **already firing** shot, but it cannot start one.
- `shootAt(target, power)` and `resetShot()` are module-scope functions in `main.js` and are
  **not** reachable from `window.__penalty` directly. (They are handed to `createRoyale({ shootAt, resetShot })`,
  but the royale controller only returns `{ update, onOutcome, pointerDown, phase, players }`, so
  `__penalty.royale` does not re-expose them either — verified in `royale.js`.)

## Hook (now in `main.js`)

`__penalty.shoot(x, y, power)` — aims the ball at the goal-plane point `(x, y)` (metres, z = 0),
fires it at `power`, steps the simulation until the shot is decided, and returns the outcome string
(`"goal" | "saved" | "miss"`). Physics decides the outcome — the hook passes **no** `forced` verdict
(`shootAt(target, power)` with `forcedOutcome` undefined), so the keeper and ball behave exactly as in
solo play.

```js
if (params.has("debug")) window.__penalty = {
  game, ball, keeper, royale, sfx, net,
  step: (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) simulate(dt); },

  // calibration hook ---------------------------------------------------------
  // Aim at goal-plane point (x, y), fire at `power`, run to a decision, return
  // the outcome string: "goal" | "saved" | "miss". Physics decides (forced = undefined).
  shoot: (x, y, power) => {
    game.results.length = 0;                 // keep solo mode off its 10-kick "over" path
    resetShot();
    shootAt(new THREE.Vector3(x, y, 0), power);
    let guard = 0;
    while (!game.decided && guard++ < 5000) simulate(1 / 60);
    return game.outcome;
  },
};
```

`game`, `resetShot`, `shootAt`, `simulate` and `THREE` are all in scope at that point.

`calibrate.mjs` checks for this hook on startup and exits with a clear error (pointing here)
if it is missing, so the script is safe to run before the hook is present.