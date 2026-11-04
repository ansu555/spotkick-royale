# INTERFACES — single source of truth (contracts ⇄ server ⇄ client)

Plan: `~/.claude/plans/ok-listen-i-dont-eventual-axolotl.md`. Solidity API: `contracts/src/ISpotkickRoyale.sol`.
**No simulation anywhere**: no bots, no fake players/chat/wallet/balance/wins/online count. Max **10 seats**.

## 1. Constants (contract `Config`; mirrored in `packages/shared/src/constants.ts`)
| Name | Value | Notes |
|---|---|---|
| MAX_SEATS | 10 | |
| MIN_PLAYERS | 1 | countdown starts when this many seated; a solo game plays one round and returns the pot (entry minus fee) |
| LOBBY_COUNTDOWN_SECS | 15 | |
| PICK_SECS | 7 | |
| BETWEEN_SECS | 9 | cash-out window after a resolve; covers client animations |
| REPICK_CAP | 5 | max picks per seat per round (first pick + 4 moves) |
| FEE_BPS | 400 | taken from each entry at `enter`, accrues to treasury |
| STALL_TIMEOUT_SECS | 600 | `refundStalled` allowed this long after a missed deadline |
| ENTROPY_TIMEOUT_SECS | 120 | seed not delivered → treat as stalled |
| GOAL_W_MM / GOAL_H_MM | 7320 / 2440 | |
| PICK_X_MAX / PICK_Y_MIN / PICK_Y_MAX | 3500 / 140 / 2300 | picks outside → revert `BadPick` |
| TARGET_X_MAX / TARGET_Y_MIN / TARGET_Y_MAX | 3300 / 250 / 2150 | |
| BLAST_R_MM | 1500 | nominal radius for the 25–75% fit |
| SAVE_GRID | 12 cols × 4 rows | `saveBps[48]`, row 0 = top |
Tiers (wei) are set by owner (`setTier`); default testnet tiers: 3, 5, 10, 25 MON (placeholder).

## 2. Randomness derivation (MUST match bit-for-bit in Solidity and `packages/shared/src/royale-math.ts`)
`seed` = bytes32 from the entropy provider for the round.
`rand(i) = uint256(keccak256(abi.encode(seed, uint256(i))))`  (i is a uint256).
`alive[]` = alive seat indices ascending. `n = alive.length`.

1. **Auto-picks (applied first, in `resolveRound`)**: for each alive seat with no pick this round, `r = rand(32 + seat)`;
   `x = -3500 + int(r % 7001)`; `y = 140 + int((r >> 128) % 2161)`. Emit `AutoPicked`.
2. **Target**:
   - `anchored = rand(0) % 10000 < 6000`
   - if anchored: `base = pick of alive[ rand(1) % n ]` (post-auto-pick positions)
   - else: `base.x = -3300 + int(rand(2) % 6601)`, `base.y = 250 + int(rand(3) % 1901)`
   - noise from `r = rand(4)` (x) and `r = rand(5)` (y): four 16-bit chunks `c0..c3 = (r >> (16*k)) & 0xFFFF`; `s = c0+c1+c2+c3 - 131070` (range ±131070);
     `noiseX = s_x * 350 / 37837`, `noiseY = s_y * 250 / 37837` (signed integer division, truncating toward zero). 37837 ≈ 65535·√(1/3).
   - `target = clamp(base + noise)`: x ∈ [-3300,3300], y ∈ [250,2150].
3. **Outcome**: `col = clamp(((x + 3660) * 12) / 7320, 0, 11)`, `row = clamp(((2440 - y) * 4) / 2440, 0, 3)`;
   `saveBps = table[row*12 + col]`; `Saved` iff `rand(6) % 10000 < saveBps`, else `Goal`.
4. **Blast** (spec = `royale.js` `resolve()`, with squared integer distances, tie-break by lower seat index):
   - `d2[i] = (px-tx)² + (py-ty)²` (mm², fits uint64); sort alive by (d2, seat).
   - `inside = count(d2 <= 1500²)`; `lo = max(1, ceil(n/4))`; `hi = max(1, min(n-1, floor(3n/4)))`; `k = clamp(inside, lo, hi)`.
   - `Goal` → the k closest survive; `Saved` → the other `n-k` survive.
   - `radiusMm` (display only) = `k < n ? (isqrt(d2[k-1]) + isqrt(d2[k])) / 2 : isqrt(d2[n-1]) + 200`.
5. Winner: when `survivors == 1` → `GameFinished`; prize = entire pot. Dust (pot % alive) stays in pot → goes to winner.
6. `cashOut` value = `pot / alive`; then `pot -= value`, alive −1. Allowed only in `Picking` (round ≥ 2) or `Between`, and only if alive ≥ 2.
   Blocked in `Locked`/`Resolved`-before-`Between`. Pays `player` (never `msg.sender`); push with 30k-gas cap, else credit `claimable`.
7. `lockPicks` entropy `userRandomness = keccak256(abi.encode(gameId, round, picksHash))`; `picksHash = keccak256(abi.encode(xs, ys, picked, aliveMask))`.

Phase deadlines: Lobby (`phaseEndsAt` = countdown end, 0 until MIN_PLAYERS) → Picking (`pickDeadline = start + PICK_SECS`) →
Locked (until seed) → Resolved (instant state, `resolveRound` sets Between) → Between (`nextPhaseAt = resolve time + BETWEEN_SECS`) → Picking.

## 3. Server REST (base `/api`, JSON, bigints as decimal strings, addresses lowercase)
- `GET /config` → `{chainId, contracts:{royale,rain,sessions}, tiers:[{tier,valueWei}], constants, saveTable:number[48], monUsd:number|null}`
- `GET /rooms` → `[{tier, valueWei, gameId, phase, seatsFilled, phaseEndsAt}]`
- `GET /games/:id` → full game replay `{game, seats, rounds:[{round, picks:[{seat,x,y,auto}], result}], cashouts, winner}`
- `GET /fair/:id` → per round `{round, picksHash, entropyRequestId, seed, userRandomness, target, outcome, saveBps, txHashes}` + `verifierVersion`
- `GET /players/:addr` → `{wagered, won, games, cashouts, bestMultiple}`; `GET /leaderboard?window=7d|all`; `GET /wins?limit=` ; `GET /health`
- Auth: `GET /auth/nonce?address=` → `{nonce, message}`; `POST /auth/verify {address, signature}` → `{token, expiresAt}` (SIWE-style EIP-4361 message, EIP-191 sig).
- Chat history: `GET /chat?limit=50`.

## 4. WebSocket (`/ws`, optional `?token=`; anonymous = read-only spectator). JSON frames `{t: type, ...}`
Server → client:
- `hello {chainId, serverTime, contracts}`
- `rooms [...]` (same as /rooms), `game {…GameView + seats + picks for current round}` (sent on subscribe and on every phase change)
- `seat {gameId, seat, player, left?:true}`  `countdown {gameId, startsAt}`
- `pick {gameId, round, seat, x, y, pickCount, speculative:boolean}`
- `locked {gameId, round, picksHash}`  `seed {gameId, round}`  (no seed bytes needed beyond /fair)
- `resolved {gameId, round, targetX, targetY, outcome, survivorMask, radiusMm, saveBps, nextPhaseAt, autoPicks:[{seat,x,y}]}`
- `cashout {gameId, round, seat, player, amount}`  `finished {gameId, seat, winner, prize, rounds}`  `refunded {gameId, perSeat}`
- `chat {id, ts, user, text, level?}`  `sys {ts, kind:'entry'|'cashout'|'winner'|'kickoff', html}`
- `presence {count}`  `ticker {user, amount, mult, gameId}`  `rain {rainId, amount, joined, endsAt, settled?}`
Client → server: `sub {channels:string[]}` (`rooms`, `game:<id>`, `chat`, `rain`, `presence`), `chat {text}` (needs token), `ping`.
Additions (realtime worker): server frames `{t:'error', code, message}` and `{t:'pong'}`; client frame `{t:'unsub', channels}`.
Bad/expired `?token=` → socket accepted then closed with code **4401** (browsers can't read a 401 on handshake) → client re-auths.
**Chat text arrives HTML-escaped** (`&lt;` etc.): insert with `innerHTML` into a text-only element WITHOUT escaping again, or unescape then use `textContent`. `expiresAt` from /auth/verify is unix ms.
`serverTime`/`chainTime` in unix **ms**; clients compute `offset = serverTime - Date.now()` and drive timers from chain deadlines.

## 5. Chain notes (Monad)
Chain id: mainnet 143, testnet 10143 (verify). Gas is charged on the **limit** → set explicit tight gas limits per call (see `server/src/driver/gas.ts`).
Use `monadLogs` (speculative, ~400ms) for display only, finalized `logs` for money state. `eth_getLogs` ≤ 1000-block range.
Pyth Entropy testnet: `0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320`; mainnet address must be verified at docs.pyth.network/entropy/contract-addresses.
`block.timestamp` is 1 s granularity.

## 6. Ownership (parallel workers; do not edit outside your area)
| Area | Paths |
|---|---|
| contracts | `contracts/**` (not `ISpotkickRoyale.sol`) |
| server-core | `server/src/{db,indexer,driver,api,config}/**`, `server/drizzle/**` |
| server-realtime | `server/src/{gateway,chat,auth,rain,presence}/**` |
| shared | `packages/shared/**` |
| client | `index.html`, `main.js`, `royale.js`, `casino.js`, `keeper.js`, `*.css`, `net/**` |
| tools/infra | `tools/**`, `infra/**`, `.vercelignore`, `docs/RUNBOOKS.md` |
