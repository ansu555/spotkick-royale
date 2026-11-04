# Spotkick Runbooks & Incident Response

Chain: **Monad** (mainnet chain id `143`, testnet `10143`). The game contract is
**not upgradeable** — there is no proxy, no upgrade path. "Fixing" logic means a
new deployment (see [R6 — contract upgrade/redeploy](#r6-contract-upgraderedeploy)).

Every runbook follows **Detect → Triage → Contain → Recover → Aftermath**.

---

## R1 — Stalled game (driver down or phase deadline missed)

- **Detect**: `stuck-phase detector` alarm (game in a phase past its deadline), or
  `driver heartbeat` gap, or a `/rooms` entry whose `phaseEndsAt` is in the past.
- **Triage**: which phase is it stuck in? Is the driver process alive (heartbeat in
  Redis)? Is the stall in chain state (deadline missed) or in the driver (healthy but
  not acting)?
- **Contain**: if the driver is down, restart/redploy it (`flyctl machines list` /
  `fly deploy`); it is a long-lived loop with `auto_stop_machines=false`, so a restart
  resumes it. No funds need to be "paused" — a stalled game simply holds value.
- **Recover**: the state transitions are **permissionless** — anyone can unstick a
  round by calling the right move for the current phase:
  - Lobby past countdown → `startGame`
  - Picking past `pickDeadline` → `lockPicks`
  - Locked but no seed after `ENTROPY_TIMEOUT_SECS` (120s) → `resolveRound` / `refundStalled`
  - Between past `nextPhaseAt` → `advance`
  - Any missed deadline beyond `STALL_TIMEOUT_SECS` (600s) → `refundStalled`
- **Aftermath**: confirm the next phase advanced, verify seed/outcome in `/fair`, log
  root cause, and re-enable the driver. Calls are idempotent per round — do not double-call.

## R2 — Pyth Entropy outage or slow seed

- **Detect**: `entropy latency` alarm (a request pending longer than 120s), or a
  `Locked` round with no seed delivered.
- **Triage**: is Pyth down (provider status page), or is the request underfunded /
  malformed, or is the RPC (R3) blocking the reveal? Check provider events.
- **Contain**: do **not** spam re-requests; the pot is already committed and not at
  risk during Locked. The round is safe to treat as stalled.
- **Recover**: retry with an adequate fee. If the seed fails to arrive within
  `ENTROPY_TIMEOUT_SECS` (120s), treat as stalled → `refundStalled` (within
  `STALL_TIMEOUT_SECS`). If a seed later arrives, `resolveRound`.
- **Aftermath**: widen the fee buffer, add a fallback entropy path, and alert on
  provider status.

## R3 — RPC outage / failover

- **Detect**: indexer falling behind chain head, `eth_getLogs`/send timeouts,
  increasingly stale `rooms`/`game` data.
- **Triage**: which endpoint — HTTP or WS? Probe `eth_chainId`/`eth_blockNumber` on
  the mainnet-143 endpoint; test the WS feed separately.
- **Contain**: `RPC_FALLBACK_URL` is already wired in; confirm the driver/indexer has
  failed over. Sends are idempotent and non-time-critical, so no fund risk while down.
- **Recover**: let failover carry traffic. If both endpoints are down, the driver
  halts sends and resumes after restore; backfill missed logs from the last processed
  block (or `START_BLOCK` on a fresh DB).
- **Aftermath**: add a third provider, tune redundancy, record outage duration.

## R4 — Suspected exploit or invariant breach

- **Detect**: invariant monitor fires (`contract balance < pots + claimable + treasury`),
  or an anomalous cashout/withdrawal pattern.
- **Triage**: confirm breach vs. accounting bug. Pull on-chain state and reconcile
  against the indexer; snapshot balances immediately.
- **Contain**:
  - `pause` **only blocks new entries** (new games/joins). It does **not** and
    **cannot** block exits.
  - **Exits are never pausable** by design — `cashOut`/`claim` always work. Do not
    attempt to stop them (impossible), and do not promise users otherwise.
  - If a hot key may be compromised, stop using `DRIVER_PRIVATE_KEY` (it never holds
    user funds) and rotate it.
- **Recover**: determine bug vs. exploit. The contract is **not upgradeable**, so a
  logic bug is remedied by: (a) stopping new entries, and (b) draining old games to
  completion (R6) — never force-migrating mid-game. For a UI-only issue, disable new
  joins at the frontend, not on-chain.
- **Aftermath**: full reconciliation; add the breach condition to the invariant
  monitor; follow R6 if a redeploy is required.

## R5 — Wallet-clustering / sybil alert

- **Detect**: sybil monitor flags many wallets sharing a funding source, device/IP
  fingerprint, or correlated behavior.
- **Triage**: cluster size vs. policy; distinguish one-user-many-wallets from shared
  legitimate infra (e.g. public VPN/CGNAT).
- **Contain**: confirmed sybil during an active game cannot be retroactively removed
  (exits unpausable). Block new joins at the off-chain auth/session layer and gate
  future rounds (allowlist / session attestation).
- **Recover**: record clusters, apply gating for next rounds; honor outstanding
  cashouts/refunds normally.
- **Aftermath**: tune clustering heuristics and feed cluster signals back into
  off-chain auth.

## R6 — Contract upgrade / redeploy

The game contract is **not upgradeable**, so "upgrade" always means **deploy a new
version + drain the old one by completion**. Procedure:

1. Deploy the new contract version (new address) and configure tiers.
2. Keep the old contract live. Point **new games** at the new address by updating
   `ROYALE_ADDRESS` (and `RAIN_ADDRESS`/`SESSIONS_ADDRESS` if applicable) in the
   server env, frontend, and `packages/shared` constants.
3. **Drain-by-completion of old games**: let in-flight games finish naturally
   (winner takes the pot, players `cashOut`, or `refundStalled`). Never force-migrate
   mid-game — funds live in per-game pots.
4. Watch the old contract until every game is finished and every `claimable` balance
   is claimed; sweep any remaining treasury.
5. Bump `verifierVersion`; keep the indexer reading the old address until fully drained.
6. Archive old-contract events and retire the address.

---

## Invariant monitor list

| # | Invariant / detector | Alarm when |
|---|---|---|
| 1 | Contract balance ≥ Σ(pots) + Σ(claimable) + treasury | any block violates (money created/destroyed) |
| 2 | Per-game pot accounting | pot ≠ entries − fees − cashouts − prize paid |
| 3 | Stuck-phase detector | game past its deadline for > N blocks |
| 4 | Driver heartbeat | keeper heartbeat missing > X seconds |
| 5 | Entropy latency | request pending > `ENTROPY_TIMEOUT_SECS` (120s) |
| 6 | Seat/geometry bounds | seats > 10, or pick/target out of legal ranges |
| 7 | Treasury/fee consistency | accrued `FEE_BPS` (400) does not match entries |

---

## SEV levels & war-room roles

Roles: **IC** — Incident Commander (owns timeline, unblocks). **ENG** — on-call
engineer (contracts/server triage, runs unstuck/pause txs). **FE** — frontend/deploy
lead (hotfix, address-pointer updates). **SEC** — security lead (exploit forensics).
**COMMS** — user/community messaging. **COMP** — compliance/legal (any fund handling).

| SEV | Meaning | Examples | Required roles |
|---|---|---|---|
| **SEV1** | Funds at risk / invariant broken / confirmed exploit | invariant #1/#2 breach, active exploit, lost private key | IC, ENG, SEC, COMP (comm on-call) |
| **SEV2** | Core degraded — money flow blocked | driver down, stalled games, entropy or RPC outage | IC, ENG, FE |
| **SEV3** | Partial / latency / cosmetic | single stalled game, slow seed, sybil cluster | ENG (FE/COMMS as needed) |

Wire `pause` only as a **new-entry** gate (R4). Exits (`cashOut`/`claim`) are **never**
pausable and must not be treated as a lever.