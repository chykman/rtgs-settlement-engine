#!/usr/bin/env bash
# Inject a fault into the running RTGS stack and print ONLY the symptom.
# Run from the rtgs/ folder on the VM:   bash drills/inject.sh <1-6>
# Diagnose it with docker compose ps/logs/inspect/events/exec, then write a short postmortem.
# Restore with bash drills/restore.sh. Solutions are in drills/SOLUTIONS.md (read AFTER you have a root cause).
set -euo pipefail
cd "$(dirname "$0")/.."
P="${COMPOSE_PROJECT_NAME:-rtgs}"
override() { docker compose -f docker-compose.yml -f "drills/overrides/$1" up -d --no-deps "$2" >/dev/null; }

case "${1:-}" in
  1) docker compose stop rtgs-core >/dev/null
     echo "PAGE: Banks report payment submissions failing. The console shows errors. Started a few seconds ago." ;;
  2) override 02-crashloop.yml rtgs-core
     echo "PAGE: After a config change, the settlement engine never becomes healthy. Payments fail. The container keeps cycling." ;;
  3) override 03-memory.yml rtgs-core
     echo "PAGE: Settlement engine restarts repeatedly, especially when traffic arrives. No error message appears in the application logs." ;;
  4) docker network disconnect "${P}_backend" "${P}-rtgs-core-1"
     echo "PAGE: Payments fail with 'SETTLEMENT_UNAVAILABLE'. The settlement engine container shows as running and healthy." ;;
  5) docker compose stop db >/dev/null
     echo "PAGE: Everything is down. Balances cannot be read, payments fail. Nothing was deployed today." ;;
  6) override 06-credentials.yml bank-gateway
     echo "PAGE: After a credential rotation, every bank gets errors on every call. The settlement engine looks fine." ;;
  *) echo "usage: $0 <1-6>"; exit 2 ;;
esac
echo "Business impact: no payments settle while this is broken. Find the cause using evidence, not guesses."
