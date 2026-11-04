#!/usr/bin/env bash
# Deploy Spotkick to Monad TESTNET (10143) with MockRandomness (valueless testnet only — seeds are predictable)
# and write server/.env.testnet. The key is read from your shell, never printed or written to disk by this script
# except as the server's DRIVER_PRIVATE_KEY in the git-ignored server/.env.testnet (same testnet key doubles as driver).
#
#   export DEPLOYER_KEY=0x...        # funded testnet key (Monad testnet faucet); use `! export ...` inside Claude Code
#   ./deploy-testnet.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/.." && pwd)"
RPC="${MONAD_TESTNET_RPC:-https://testnet-rpc.monad.xyz}"; WS="${MONAD_TESTNET_WS:-wss://testnet-rpc.monad.xyz}"
: "${DEPLOYER_KEY:?export DEPLOYER_KEY=0x<funded testnet private key> first}"
[[ "$DEPLOYER_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "DEPLOYER_KEY must be 0x + 64 hex chars"; exit 1; }

CID=$(curl -s -m 15 -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | sed -E 's/.*"result":"(0x[0-9a-f]+)".*/\1/')
[ "$((CID))" = "10143" ] || { echo "RPC is chain $((CID)), expected 10143 — refusing"; exit 1; }

ADDR=$(docker run --rm --entrypoint /bin/sh -e K="$DEPLOYER_KEY" ghcr.io/foundry-rs/foundry:latest -c 'cast wallet address --private-key "$K"')
BAL=$(docker run --rm --entrypoint /bin/sh ghcr.io/foundry-rs/foundry:latest -c "cast balance $ADDR --rpc-url $RPC --ether")
echo "deployer $ADDR  balance $BAL MON on Monad testnet"
awk -v b="$BAL" -v m="${MIN_MON:-2.1}" 'BEGIN{exit !(b+0 >= m+0)}' || { echo "need >= ${MIN_MON:-2.1} MON (Monad testnet gas is ~100 gwei base fee; charged on gas limit) — aborting"; exit 1; }
rm -f "$HERE/deployments/10143.json"   # forge writes this even in simulation; only trust it after a successful broadcast

echo "deploying (MockRandomness, tiers 3/5/10/25 MON)…"
docker run --rm -v "$REPO":/app -w /app/contracts -e K="$DEPLOYER_KEY" -e ENTROPY_FUND_WEI="${ENTROPY_FUND_WEI:-200000000000000000}" \
  ghcr.io/foundry-rs/foundry:latest "forge script script/DeployLocal.s.sol --rpc-url $RPC --broadcast --private-key \$K --slow ${GAS_FLAGS:-} 2>&1 | tee /app/contracts/cache/deploy10143.log | tail -25"
grep -q "ONCHAIN EXECUTION COMPLETE" "$HERE/cache/deploy10143.log" || { echo "DEPLOY FAILED (see above) — nothing written"; rm -f "$HERE/deployments/10143.json"; exit 1; }

J="$HERE/deployments/10143.json"; [ -f "$J" ] || { echo "no $J written — deploy failed"; exit 1; }
g() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$J" "$1"; }
ENVF="$REPO/server/.env.testnet"; umask 077
cat > "$ENVF" <<ENV
RPC_HTTP_URL=$RPC
RPC_WS_URL=$WS
CHAIN_ID=10143
ROYALE_ADDRESS=$(g royale)
RAIN_ADDRESS=$(g rain)
SESSIONS_ADDRESS=$(g sessions)
MOCK_RANDOMNESS_ADDRESS=$(g randomness)
START_BLOCK=$(g deployBlock)
DATABASE_URL=postgres://spotkick:spotkick@localhost:5432/spotkick_testnet
REDIS_URL=redis://localhost:6379/1
JWT_SECRET=$(openssl rand -hex 24)
DRIVER_PRIVATE_KEY=$DEPLOYER_KEY
DRIVER_MIN_BALANCE_WEI=300000000000000000
INDEXER_CONFIRMATIONS=2
PORT=8080
MIN_CHAT_WAGER_WEI=0
ENV
docker exec spotkick-postgres psql -U spotkick -d spotkick -tc "SELECT 1 FROM pg_database WHERE datname='spotkick_testnet'" | grep -q 1 \
  || docker exec spotkick-postgres psql -U spotkick -d spotkick -c "CREATE DATABASE spotkick_testnet" >/dev/null
echo; echo "royale=$(g royale) rain=$(g rain) sessions=$(g sessions) mockRng=$(g randomness) block=$(g deployBlock)"
echo "wrote server/.env.testnet. Start server:  cd server && set -a && . ./.env.testnet && set +a && pnpm start"
echo "then open http://localhost:8765/?api=http://localhost:8080/api  (wallet auto-adds Monad Testnet)"
