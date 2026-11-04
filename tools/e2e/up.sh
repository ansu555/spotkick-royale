#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Spotkick Royale — local end-to-end environment bring-up.  TEST TOOLING ONLY.
#
#   1. docker compose up (postgres, redis, anvil chain-id 31337) — FRESH volumes
#   2. read the anvil dev accounts/private keys from `docker logs` (never typed)
#   3. deploy contracts with forge inside the foundry Docker image
#      (entrypoint is /bin/sh -c → ONE quoted command string; host anvil is
#       reached at http://host.docker.internal:8545)
#   4. write server/.env.e2e, run DB migrations, start the server (pnpm start)
#      in the background with a pid file, poll /api/health until ok
#
# Run:  ./up.sh   then   node play.mjs      Teardown: ./down.sh
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COMPOSE_FILE="$REPO/infra/docker-compose.yml"
FOUNDRY_IMAGE="ghcr.io/foundry-rs/foundry:latest"
ANVIL_CONTAINER="spotkick-anvil"
RPC="http://localhost:8545"
PORT=8787
SERVER_DIR="$REPO/server"
ENV_FILE="$SERVER_DIR/.env.e2e"
PID_FILE="$HERE/server.pid"
LOG_FILE="$HERE/server.log"
ACCOUNTS_FILE="$HERE/anvil-accounts.json"
DEPLOY_JSON="$REPO/contracts/deployments/31337.json"

log() { printf '[e2e] %s\n' "$*"; }
die() { printf '[e2e] ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found"
command -v node   >/dev/null || die "node not found (need >= 22)"
command -v pnpm   >/dev/null || die "pnpm not found"
docker info >/dev/null 2>&1 || die "docker daemon not running"
[ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE"

# ---- 1. fresh local stack --------------------------------------------------
log "recreating local stack (postgres, redis, anvil) with FRESH volumes"
if [ -f "$PID_FILE" ]; then
  OLDPID="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$OLDPID" ] && { pkill -P "$OLDPID" 2>/dev/null || true; kill "$OLDPID" 2>/dev/null || true; }
fi
pkill -f "tsx src/main.ts" 2>/dev/null || true
# remove same-named containers that may belong to a different compose project
docker rm -f spotkick-postgres spotkick-redis spotkick-anvil >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" up -d

wait_for() { # name timeout_s cmd...
  local name="$1" timeout="$2"; shift 2
  local i=0
  until "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt $((timeout * 2)) ]; then die "$name not ready after ${timeout}s"; fi
    sleep 0.5
  done
  log "$name ready"
}
wait_for "postgres" 90 docker exec spotkick-postgres pg_isready -U spotkick -d spotkick
wait_for "redis"    60 docker exec spotkick-redis redis-cli ping
wait_for "anvil"    60 curl -sf -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' "$RPC"

CHAIN_ID_HEX=$(curl -sf -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' "$RPC" \
  | sed -E 's/.*"result":"([^"]+)".*/\1/')
[ "$CHAIN_ID_HEX" = "0x7a69" ] || die "anvil chain id is $CHAIN_ID_HEX, expected 0x7a69 (31337)"
log "anvil chain-id 31337 confirmed"

# Multicall3 sanity (the server driver multicalls through the canonical address)
MC3=$(curl -sf -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0xcA11bde05977b3631167028862bE2a173976CA11","latest"],"id":1}' "$RPC" \
  | sed -E 's/.*"result":"([^"]*)".*/\1/')
if [ "$MC3" = "0x" ] || [ -z "$MC3" ]; then
  log "WARNING: Multicall3 NOT deployed at 0xcA11...CA11 — server driver multicalls will fail"
else
  log "Multicall3 present at canonical address"
fi

# ---- 2. anvil accounts (parsed from container logs; keys are NEVER typed) ---
sleep 1
docker logs "$ANVIL_CONTAINER" > "$HERE/anvil-startup.log" 2>&1 || die "cannot read anvil logs"
node -e '
const fs = require("fs");
const log = fs.readFileSync(process.argv[1], "utf8");
const keys  = [...log.matchAll(/^\((\d+)\)\s+(0x[0-9a-fA-F]{64})\s*$/gm)].map((m) => ({ index: Number(m[1]), privateKey: m[2] }));
const addrs = [...log.matchAll(/^\((\d+)\)\s+(0x[0-9a-fA-F]{40})\s+\(/gm)].map((m) => ({ index: Number(m[1]), address: m[2] }));
if (keys.length < 10 || addrs.length < 10) { console.error(`parsed only ${keys.length} keys / ${addrs.length} addresses from anvil logs`); process.exit(1); }
const out = keys.map((k) => ({ ...k, address: (addrs.find((a) => a.index === k.index) || {}).address }));
if (out.some((o) => !o.address)) { console.error("address/key index mismatch in anvil logs"); process.exit(1); }
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
' "$HERE/anvil-startup.log" "$ACCOUNTS_FILE" || die "failed to parse anvil accounts from docker logs"
log "parsed 10 anvil accounts -> tools/e2e/anvil-accounts.json (local dev keys only)"

pk() { node -p "JSON.parse(require('fs').readFileSync('$ACCOUNTS_FILE','utf8')).find(a=>a.index===$1).privateKey"; }
PK0="$(pk 0)"   # deployer / contract owner
PK9="$(pk 9)"   # server driver key (per task spec: anvil account 9)

# ---- 3. deploy via forge in Docker -----------------------------------------
log "deploying contracts (DeployLocal.s.sol + MockRandomness) via $FOUNDRY_IMAGE"
rm -f "$DEPLOY_JSON"
DEPLOY_CMD="forge script script/DeployLocal.s.sol --rpc-url http://host.docker.internal:8545 --broadcast --private-key $PK0"
ENTRYPOINT="$(docker image inspect -f '{{json .Config.Entrypoint}}' "$FOUNDRY_IMAGE" 2>/dev/null || echo '[]')"
if [ "$(printf '%s' "$ENTRYPOINT" | tr -d ' "[]')" = "/bin/sh,-c" ]; then
  # entrypoint is /bin/sh -c → pass ONE quoted string
  docker run --rm -v "$REPO:/app" -w /app/contracts "$FOUNDRY_IMAGE" "$DEPLOY_CMD" 2>&1 | tee "$HERE/deploy.log"
else
  docker run --rm --entrypoint /bin/sh -v "$REPO:/app" -w /app/contracts "$FOUNDRY_IMAGE" -c "$DEPLOY_CMD" 2>&1 | tee "$HERE/deploy.log"
fi
[ -f "$DEPLOY_JSON" ] || die "deploy did not write $DEPLOY_JSON (see tools/e2e/deploy.log)"

read_json() { node -p "JSON.parse(require('fs').readFileSync('$DEPLOY_JSON','utf8')).$1"; }
ROYALE="$(read_json royale)"; SESSIONS="$(read_json sessions)"; RAIN="$(read_json rain)"; RANDOMNESS="$(read_json randomness)"
PLACEHOLDER="$(read_json placeholderSaveTable)"
[ "$PLACEHOLDER" = "false" ] || die "deployed with PLACEHOLDER save table — packages/shared/save-table.json was not visible inside Docker; /fair verification would mismatch"
log "deployed royale=$ROYALE sessions=$SESSIONS rain=$RAIN randomness=$RANDOMNESS"

# ---- 4. server env, deps, migrations, start --------------------------------
JWT_SECRET="$(openssl rand -hex 24)"   # 48 hex chars >= 32 required by realtime
cat > "$ENV_FILE" <<EOF
# Generated by tools/e2e/up.sh — LOCAL E2E ONLY (anvil 31337). Never use in production.
RPC_HTTP_URL=http://localhost:8545
RPC_WS_URL=ws://localhost:8545
CHAIN_ID=31337
ROYALE_ADDRESS=$ROYALE
RAIN_ADDRESS=$RAIN
SESSIONS_ADDRESS=$SESSIONS
# MockRandomness (harness fulfils seeds; the server does not read this): $RANDOMNESS
DATABASE_URL=postgres://spotkick:spotkick@localhost:5432/spotkick
REDIS_URL=redis://localhost:6379
JWT_SECRET=$JWT_SECRET
DRIVER_PRIVATE_KEY=$PK9
START_BLOCK=0
MIN_CHAT_WAGER_WEI=0
PORT=$PORT
HOST=0.0.0.0
CORS_ORIGINS=*
LOG_LEVEL=info
INDEXER_POLL_MS=500
EOF
log "wrote server/.env.e2e (port $PORT, driver = anvil account 9)"

if [ ! -d "$SERVER_DIR/node_modules/tsx" ] || [ ! -d "$SERVER_DIR/node_modules/viem" ] || [ ! -d "$SERVER_DIR/node_modules/ws" ]; then
  log "installing server deps"; (cd "$SERVER_DIR" && pnpm install)
fi
if [ ! -d "$REPO/packages/shared/node_modules/viem" ]; then
  log "installing packages/shared deps"; (cd "$REPO/packages/shared" && pnpm install)
fi
# play.mjs resolves viem/ws/tsx through this symlink (it must not modify server/)
ln -sfn "$SERVER_DIR/node_modules" "$HERE/node_modules"

log "running DB migrations"
(cd "$SERVER_DIR" && set -a && . ./.env.e2e && set +a && pnpm db:migrate)

kill_server() {
  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ]; then pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; fi
  fi
  pkill -f "tsx src/main.ts" 2>/dev/null || true
  sleep 1
}
start_server() {
  ( cd "$SERVER_DIR" && set -a && . ./.env.e2e && set +a \
    && nohup pnpm start > "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE" )
  log "server starting (pid $(cat "$PID_FILE"), log: tools/e2e/server.log)"
}
health_ok() { curl -sf "http://localhost:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; }

attempt=1
while true; do
  log "starting server (attempt $attempt/3)"
  start_server
  ok=0
  for _ in $(seq 1 240); do           # up to 120 s
    if health_ok; then ok=1; break; fi
    sleep 0.5
  done
  if [ "$ok" -eq 1 ]; then break; fi
  log "server not healthy after 120s; last log lines:"
  tail -n 40 "$LOG_FILE" >&2 || true
  kill_server
  if [ "$attempt" -ge 3 ]; then
    die "server failed to become healthy after 3 attempts — record it in tools/e2e/FINDINGS.md (see $LOG_FILE)"
  fi
  log "another worker may still be editing server/ — waiting 120s before retry"
  sleep 120
  attempt=$((attempt + 1))
done

log "server healthy at http://localhost:$PORT/api/health (pid $(cat "$PID_FILE"))"
log "stack is up. Next:  cd tools/e2e && node play.mjs"
