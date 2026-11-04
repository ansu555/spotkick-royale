# spotkick-server

On-chain spot-kick royale game server for **Monad**. One Node.js (≥22) process that:

- **indexes** the Royale + Rain contracts (backfill from `START_BLOCK`, then live via WebSocket),
- **drives** the on-chain settle step as a gas-only keeper wallet,
- serves the **REST API** (`/api/*`) and a **WebSocket realtime gateway** for browser clients.

Written in strict TypeScript (ESM). Wei values are `bigint`; nothing is mocked in `src/`.

## Architecture

```
main.ts
  ├─ config/      env parsing (zod), chain clients, tier provider, logger, price feed, save-table
  ├─ db/          drizzle schema + queries, SQL migrations (drizzle/*.sql), rain/game persistence
  ├─ indexer/     backfill + live log indexer, rain→ServerMsg translation, Redis message bus
  ├─ driver/      keeper: resolves finished rounds, sends settle txs, heartbeats to Redis
  ├─ api/         Fastify REST routes (see below)
  ├─ gateway/     WebSocket realtime (rooms/games/chat), auth via SIWE + JWT
  └─ fair/        re-derives round outcomes from on-chain seeds (packages/shared royale-math)
```

Startup order in `main.ts`: parse env → migrate DB → connect Redis → build chain client →
start indexer → start driver → register API → `startRealtime` → `app.listen` → install
SIGINT/SIGTERM graceful shutdown. Each component is independently toggleable via env.

## Environment variables

Full reference lives in [`infra/.env.example`](../infra/.env.example); a local copy is
[`.env.example`](./.env.example). Required (no default) unless noted:

| Var | Purpose |
|---|---|
| `RPC_HTTP_URL` | HTTPS JSON-RPC (Monad), used for sends + finalized reads |
| `RPC_WS_URL` | WS endpoint for the live indexer |
| `RPC_FALLBACK_URL` | optional secondary RPC used on primary failure |
| `CHAIN_ID` | 143 (mainnet) or 10143 (testnet) |
| `ROYALE_ADDRESS` / `RAIN_ADDRESS` / `SESSIONS_ADDRESS` | deployed contract addresses |
| `DATABASE_URL` | Postgres 16 (see docker-compose) |
| `REDIS_URL` | Redis 7 |
| `JWT_SECRET` | HS256 key (≥16 chars) for realtime auth; `openssl rand -base64 48` |
| `DRIVER_PRIVATE_KEY` | keeper wallet (`0x` + 32 bytes); gas-only, holds no user funds |
| `START_BLOCK` | indexer backfill start (big-int string) |
| `MIN_CHAT_WAGER_WEI` | min lifetime wager before a wallet may chat (big-int string) |
| `MON_USD_PRICE_URL` | optional JSON price feed (`{...,"price"...}`); unset ⇒ `/api/config` `monUsd` is `null` |

Defaults (override as needed): `PORT=8080`, `HOST=0.0.0.0`, `CORS_ORIGINS=*`,
`LOG_LEVEL=info`, `INDEXER_ENABLED=true`, `DRIVER_ENABLED=true`, plus the driver/indexer
tick, confirmation, and fee knobs shown in `infra/.env.example`. **On Fly, `PORT` must be
`8787`** (see `infra/fly.toml` `internal_port`).

## Run locally

The repo only ships Postgres + Redis + a local Anvil chain via Compose; the server itself
runs on the host with `pnpm`.

```bash
# 1. backing services (Postgres 16, Redis 7, Anvil at :8545)
docker compose -f infra/docker-compose.yml up -d

# 2. configure (mirror infra/.env.example; point RPC at http://127.0.0.1:8545 for Anvil)
cd server
cp .env.example .env
$EDITOR .env

# 3. install + migrate + run
pnpm install
pnpm db:migrate
pnpm dev              # tsx watch
```

For plain start / checks:

```bash
pnpm start            # tsx src/main.ts
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run (indexer, db, fair verifier, …)
```

## REST API

All routes are under `/api` (see `docs/INTERFACES.md` §3 for exact shapes):

| Route | Returns |
|---|---|
| `GET /api/config` | chainId, contract addresses, tiers, constants, save table, MON/USD price |
| `GET /api/rooms` | current rooms (snapshot) |
| `GET /api/games/:id` | full replay for a game, or 404 |
| `GET /api/fair/:id` | per-round on-chain values + server re-derived outcome + `verified` flag |
| `GET /api/players/:addr` | a player's stats |
| `GET /api/leaderboard?window=7d\|all&limit=` | ranked board |
| `GET /api/wins?limit=` | recent winners |
| `GET /api/health` | 200/503 with db/redis/rpc/indexer/driver probes |

`/api/fair/:id` re-derives each round's `target` / `outcome` / survivors from the committed
seed via `packages/shared/src/royale-math.ts`, returns both the on-chain and recomputed
values, and a boolean `verified` that is `true` when they match (see `src/fair/verifier.ts`).

Rain events are indexed, translated to `rain` server messages, and persisted; they surface
through the WebSocket gateway.