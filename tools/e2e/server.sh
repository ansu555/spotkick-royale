#!/usr/bin/env bash
# server.sh start|stop|status  - run the REAL server (pnpm start) with server/.env.e2e; pid in .state/server.pid
set -euo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$E2E_DIR/../.." && pwd)"
STATE="$E2E_DIR/.state"; mkdir -p "$STATE"
PIDF="$STATE/server.pid"
PORT="${E2E_SERVER_PORT:-8080}"

alive() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

stop() {
  if alive; then
    local pid; pid="$(cat "$PIDF")"
    # pnpm -> node: signal the whole process group child tree
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do alive || break; sleep 0.5; done
    alive && { pkill -KILL -P "$pid" 2>/dev/null || true; kill -KILL "$pid" 2>/dev/null || true; }
  fi
  # belt and braces: anything still listening on the port is our server
  local p; p="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$p" ] && kill -TERM $p 2>/dev/null || true
  rm -f "$PIDF"
  echo "[server] stopped"
}

start() {
  alive && { echo "[server] already running ($(cat "$PIDF"))"; return 0; }
  cd "$ROOT/server"
  set -a; . ./.env.e2e; set +a
  echo "[server] starting on :$PORT (log: $STATE/server.log)"
  nohup pnpm start >> "$STATE/server.log" 2>&1 &
  echo $! > "$PIDF"
  for _ in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      echo "[server] up: $(curl -s "http://127.0.0.1:$PORT/api/health" | cut -c1-200)"; return 0
    fi
    # health may be 503 while degraded; accept any HTTP answer once listening
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
      echo "[server] listening (health not ok yet): $(curl -s "http://127.0.0.1:$PORT/api/health" | cut -c1-200)"; return 0
    fi
    alive || { echo "[server] exited early:"; tail -n 40 "$STATE/server.log"; return 1; }
    sleep 1
  done
  echo "[server] not listening after 90s"; tail -n 40 "$STATE/server.log"; return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) alive && echo "running $(cat "$PIDF")" || echo "stopped" ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
