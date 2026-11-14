#!/usr/bin/env bash
# Return the stack to its healthy, un-faulted state. The database volume is kept.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose down --remove-orphans
docker compose up -d --wait --wait-timeout 120
docker compose ps
