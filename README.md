# Penalty

A penalty shootout in the browser (three.js, no build step) with a motion-captured keeper that reads each shot, picks a dive and times it to the ball.

**Royale (default).** Up to 10 real players per room pick a spot on the goal. The picks build a live heat map, a scanner locks onto one point, and the ball is fired there. On a **goal**, everyone inside the blast radius around the strike survives. On a **save**, everyone inside is eliminated and the farthest survive. The radius is fitted so each round keeps 25–75% of the field. Rounds repeat until one player is left. There are no bots: a game starts once 3 players are seated.

**On-chain on Monad.** Entries, picks, cash-outs and payouts are transactions on a Solidity contract (`contracts/`). Randomness comes from Pyth Entropy; the contract derives the target, the goal/save verdict and the survivors, so the browser only animates the result. Entry tiers are in MON, with a 4% fee; seat value = pot ÷ players alive and you can cash out between rounds. A Node backend (`server/`) indexes the chain, drives the round clock, and serves chat, presence, rain and the fairness proofs. There is no simulated wallet, balance, player, chat or win.

**Solo (`?mode=solo`).** You take the kicks: aim with the cursor, hold to power, release to shoot.

## Architecture

```
browser (static, Vercel)  <-- WS/REST -->  server/ (Node 22 + TS: indexer, driver, gateway, API)  <-- RPC -->  Monad
 viem wallet + session key ------------- txs sent straight to the contracts ----------------------------->  SpotkickRoyale, Rain, SessionRegistry
```

| Path | What |
|---|---|
| `contracts/` | Foundry project: `SpotkickRoyale`, `Rain`, `SessionRegistry`, Pyth Entropy adapter, tests, deploy scripts (`DEPLOY.md`) |
| `server/` | indexer → Postgres, round driver, WebSocket gateway, SIWE auth, chat, REST API (`server/README.md`) |
| `packages/shared/` | TypeScript reference of the on-chain derivation + golden test vectors |
| `net/` | browser modules: wallet (EIP-6963), chain calls, session key, WebSocket, auth |
| `tools/calibrate/` | measures the keeper's save rate per target cell → contract save table |
| `infra/`, `docs/` | docker-compose, Dockerfile, fly.toml, runbooks, `INTERFACES.md` (the spec all parts share) |

The Solidity maths is checked against the TypeScript reference with 300 shared vectors (`contracts/test/Golden.t.sol`).

## Run

Any static file server works:

```bash
python3 serve.py 8765   # static server with caching disabled
# open http://localhost:8765
```

URL options:

| Param | Effect |
|---|---|
| `mode=solo` | play the original 10-kick solo mode |
| `q=low` | fewer grass blades and smaller shadow maps (default on touch devices) |
| `keeper=<url>` | load a different keeper GLB |
| `rot=<deg>` | rotate the keeper model if it faces the wrong way |
| `debug` | exposes `window.__penalty` (game state, `step(n)` to fast-forward) |
| `perfectkeeper` | keeper always reads the shot (for testing saves) |

## Files

- `main.js`: scene, lighting, turf, goal/net, ball physics, camera, HUD, game loop
- `casino.js` / `casino.css`: casino frame (top bar, wallet, balance, deposit, chat + SOL rain, wins ticker, toasts, modals). All simulated.
- `royale.js` / `royale.css`: crowd mode with bots, pick feed, holographic goal overlay (heat map, scanner, blast radius), elimination rules and HUD
- `keeper.js`: keeper drivers. `AnimatedKeeper` plays the Mixamo clips. For each shot it searches every clip, side and frame for the glove/body path that best meets the ball, then times that frame to the ball's arrival. Saves are tested against the real bones, and catch clips hold the ball. `StaticKeeper` is the fallback for an unrigged mesh.
- `assets/goalkeeper_rigged.glb`: rigged keeper with 7 clips (idle, sidestep, dive_mid, dive_low, jump_high, catch_high, catch_mid), meshopt + WebP compressed
- `assets/goalkeeper.glb`: unrigged fallback
- `mixamo/`: pipeline that rebuilds the rigged GLB
- `audio.js`: Web Audio engine (preloaded one-shots, ducked crowd bed, mute toggle saved in localStorage)
- `assets/sfx/`: 23 trimmed, peak-normalised sounds; `sfx/build_sfx.sh` rebuilds them from the raw downloads

## Rebuilding the keeper

1. Upload the keeper mesh to [Mixamo](https://www.mixamo.com) and auto-rig it.
2. Download clips as **FBX Binary, With Skin, 30 fps, In Place off** into `mixamo/` using these names: `idle`, `sidestep`, `dive_mid`, `dive_low`, `jump_high`, `catch_high`, `catch_mid` (`.fbx`).
3. Run `mixamo/build_keeper.sh` (needs Blender and Node). It merges the clips into one GLB and compresses it into `assets/goalkeeper_rigged.glb`.

The FBX files are gitignored (about 8 MB each).

## Credits

- Goalkeeper model: ["Goal keeper"](https://sketchfab.com/3d-models/goal-keeper-cea7e331825240bea906d40f8dc52d17) by sandesh_bhat, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Animations: [Mixamo](https://www.mixamo.com) (Adobe)
- Sound effects: [Pixabay](https://pixabay.com/sound-effects/) and [Mixkit](https://mixkit.co/free-sound-effects/) (free licences), plus ElevenLabs-generated crowd gasp and post clang
- Rendering: [three.js](https://threejs.org) r170 (MIT)
