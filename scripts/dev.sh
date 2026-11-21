#!/usr/bin/env bash
# Start the whole AI Travel Planner locally:
#   Destination agent :8001, Budget agent :8002, Itinerary agent :8003,
#   Coordinator API   :8000, Next.js frontend :3000
#
# Usage: ./scripts/dev.sh               # everything
#        ./scripts/dev.sh --no-frontend  # backend services only
# Ctrl-C stops every process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_FRONTEND=1
[[ "${1:-}" == "--no-frontend" ]] && WITH_FRONTEND=0

die() { echo "error: $*" >&2; exit 1; }
command -v uv >/dev/null || die "uv is not installed. See https://docs.astral.sh/uv/getting-started/installation/"
if [[ $WITH_FRONTEND == 1 ]]; then command -v pnpm >/dev/null || die "pnpm is not installed. Run: npm install -g pnpm"; fi
[[ -f "$ROOT/.env" ]] || die "missing .env — run: cp .env.example .env  and set GOOGLE_API_KEY"

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for port in 8000 8001 8002 8003 $([[ $WITH_FRONTEND == 1 ]] && echo 3000); do
  port_in_use "$port" && die "port $port is already in use (another instance running?)"
done

echo "Syncing Python dependencies (uv)..."
(cd "$ROOT/backend" && uv sync --quiet)
if [[ $WITH_FRONTEND == 1 && ! -d "$ROOT/node_modules" ]]; then
  echo "Installing frontend dependencies (pnpm)..."
  (cd "$ROOT" && pnpm install)
fi

PIDS=()
cleanup() {
  echo; echo "Stopping all services..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# run <label> <colour> <dir> <command...> — prefixes every log line with the service name
run() {
  local label=$1 colour=$2 dir=$3; shift 3
  (cd "$dir" && exec "$@" 2>&1 | while IFS= read -r line; do printf '\033[%sm%-12s\033[0m %s\n' "$colour" "$label" "$line"; done) &
  PIDS+=($!)
}

run destination "36" "$ROOT/backend" uv run python -m agents.destination.server
run budget      "33" "$ROOT/backend" uv run python -m agents.budget.server
run itinerary   "35" "$ROOT/backend" uv run python -m agents.itinerary.server

echo "Waiting for agent cards..."
for port in 8001 8002 8003; do
  for _ in $(seq 1 60); do
    curl -fsS "http://localhost:$port/.well-known/agent-card.json" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS "http://localhost:$port/.well-known/agent-card.json" >/dev/null 2>&1 || die "agent on port $port did not start (see logs above)"
done

run coordinator "32" "$ROOT/backend" uv run python -m coordinator.main
[[ $WITH_FRONTEND == 1 ]] && run frontend "34" "$ROOT" pnpm dev

cat <<EOF

  AI Travel Planner is starting:
    Frontend        http://localhost:3000
    Coordinator API http://localhost:8000/docs
    Agent Cards     http://localhost:8001/.well-known/agent-card.json
                    http://localhost:8002/.well-known/agent-card.json
                    http://localhost:8003/.well-known/agent-card.json
  Press Ctrl-C to stop.

EOF
wait
