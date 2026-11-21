#!/usr/bin/env bash
# Print health + Agent Card summary for every service. Requires curl; uses python3 for JSON.
set -uo pipefail

PY_CARD='
import json, sys
card = json.load(sys.stdin)
iface = card["supportedInterfaces"][0]
caps = card.get("capabilities", {})
print("               card:  %s v%s | %s %s | streaming=%s" % (card["name"], card["version"], iface["protocolBinding"], iface.get("protocolVersion", ""), caps.get("streaming", False)))
for skill in card.get("skills", []):
    print("               skill: " + skill["id"])
'
PY_HEALTH='
import json, sys
d = json.load(sys.stdin)
print("               model: %s | gemini_configured=%s" % (d["model"], d["gemini_configured"]))
'

check() {
  local name=$1 url=$2 body
  if ! body=$(curl -fsS --max-time 3 "$url/health" 2>/dev/null); then
    printf '  %-12s DOWN  %s\n' "$name" "$url"
    return
  fi
  printf '  %-12s UP    %s\n' "$name" "$url"
  if [[ "$name" == "coordinator" ]]; then
    echo "$body" | python3 -c "$PY_HEALTH"
  else
    curl -fsS --max-time 3 "$url/.well-known/agent-card.json" | python3 -c "$PY_CARD"
  fi
}

echo "AI Travel Planner services:"
check coordinator "${COORDINATOR_URL:-http://localhost:8000}"
check destination "${DESTINATION_AGENT_URL:-http://localhost:8001}"
check budget      "${BUDGET_AGENT_URL:-http://localhost:8002}"
check itinerary   "${ITINERARY_AGENT_URL:-http://localhost:8003}"
