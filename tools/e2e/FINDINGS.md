# E2E findings (recorded, NOT fixed)

Status: PARTIAL. Two workers wrote into tools/e2e concurrently (see "Process conflict"); the last full play.mjs run was against a
polluted environment, so only items marked CONFIRMED are reliable.

## CONFIRMED

1. **server/src/driver/schedule.ts:59-61 (+ driver.ts) - driver never calls `resolveRound`.**
   Behaviour: `decide()` only acts on `Phase.Resolved` (4) with fn `resolveRound`. The contract never enters phase 4:
   `SpotkickRoyale.onSeed` stores the seed and leaves the phase at `Locked` (3), and `resolveRound` requires `Locked`.
   In the `Locked` branch the driver just waits for `lockedAt + ENTROPY_TIMEOUT` and then tries `refundStalled`.
   Observed twice in a real 4-player game: seed fulfilled, `driverResolved=0, assistResolved=2` (play.mjs had to call
   `resolveRound` itself after 5 s). Without that, every game would stall at Locked until refund.
   Expected: after `SeedReceived` (getRound(id, round).seed != 0 while phase == Locked) the driver calls `resolveRound`.
   Note: docs/INTERFACES.md section 2 ("Locked -> Resolved (instant state)") disagrees with the contract.

2. **infra/docker-compose.yml anvil service is unusable as written.**
   - `command: ["anvil","--host","0.0.0.0","--chain-id","31337","--block-time","1"]`: the foundry image entrypoint is `/bin/sh -c`,
     so the list becomes `sh -c anvil --host ...` => bare `anvil`: logs "Listening on 127.0.0.1:8545" (unreachable through the
     published port: "Connection reset by peer"), and `--block-time 1` is ignored. Expected: ONE string, e.g. `["anvil --host 0.0.0.0 ..."]`.
   - healthcheck uses `curl`, not present in the image => container is `unhealthy` forever (`docker compose up --wait` fails).
   Workaround in this directory: `compose.anvil-fix.yml` (second `-f`).

3. **Indexer lags ~64 s on anvil** (server/src/indexer/indexer.ts:266-277). `finalizedHead()` uses the `finalized` block tag whenever the
   node answers it; `INDEXER_CONFIRMATIONS` is only a fallback when the tag is unsupported. Anvil's default `finalized` is ~64 blocks
   behind head, so with 1 s blocks `/api/rooms`, `/api/games/:id` and all WS frames derived from finalized logs (seat, countdown, locked,
   resolved...) arrive ~1 min late (`/api/rooms` was `[]` for a minute). Workaround: anvil `--slots-in-an-epoch 1`.
   Suggest: honour INDEXER_CONFIRMATIONS as a cap (or document the anvil flag in infra/ and server README).

## OBSERVATIONS (low severity / unverified)

- No WS frame signals "countdown cancelled" when a seat leaves below MIN_PLAYERS (contract zeroes `phaseEndsAt`; translate.ts has no
  event for it; SeatLeft is not in SNAPSHOT_EVENTS), so clients keep showing a countdown until they react to `seat{left}` themselves.
- Server logs `monadLogs unsupported, falling back to logs` on anvil (expected, benign).
- UNVERIFIED: in the last (polluted) run the driver did not call `startGame` within 30 s of the countdown end for game 5; I could not
  separate this from a stale second server instance that was still holding the Redis leader lock. Re-check on a clean run.
- UNVERIFIED: Multicall3 (0xcA11...CA11) is not deployed on a fresh anvil (`eth_getCode` = 0x) while server/src/config/chain.ts declares it
  for every chain and driver.ts/clients.ts use `client.multicall`. A stale server showed `aggregate3 returned no data`; the clean server
  did lock/advance fine, so the effect on a clean anvil needs a re-test.
- Test-harness bug (mine, not a product bug): scenario d's per-player balance check ignored gas spent on pick/pickFor/repick; fix = track
  gas for those txs.

## Process conflict (needs a decision from whoever dispatched this)

While this worker was running, another agent (opencode) overwrote tools/e2e/up.sh (16:37) and created tools/e2e/down.sh (16:35), using
port 8787, files `tools/e2e/{server.pid,server.log,anvil-accounts.json}` and `docker rm -f spotkick-*` / `compose down -v` on the
same container names. Its up.sh also `pkill -f "tsx src/main.ts"`. Both versions fight over the same containers, DB and server
processes. This worker also ran `pkill -f up.sh` / `pkill -f play.mjs` during cleanup and may have killed the other worker's run.
Files from THIS worker: play.mjs, server.sh, compose.anvil-fix.yml, package.json, .state/ (play.mjs reads .state/accounts.json and
.state/deployment.json, written by this worker's original up.sh, which is now lost).
