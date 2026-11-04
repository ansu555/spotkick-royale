#!/usr/bin/env bash
# Spotkick Royale — local e2e teardown. TEST TOOLING ONLY.
#   ./down.sh      stop server + compose stack (keeps DB/redis volumes)
#   ./down.sh -v   also delete postgres/redis volumes (fresh state next up)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

if [ -f "$HERE/server.pid" ]; then
  PID="$(cat "$HERE/server.pid" 2>/dev/null || true)"
  if [ -n "$PID" ]; then
    pkill -P "$PID" 2>/dev/null || true
    kill "$PID" 2>/dev/null || true
  fi
  rm -f "$HERE/server.pid"
fi
pkill -f "tsx src/main.ts" 2>/dev/null || true

VOLUMES=""
if [ "${1:-}" = "-v" ]; then VOLUMES="--volumes"; fi
docker compose -f "$REPO/infra/docker-compose.yml" down $VOLUMES --remove-orphans
echo "[e2e] stack stopped"
