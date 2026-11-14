#!/usr/bin/env bash
# Runs all RTGS tests against a throwaway Postgres container, then removes it.
set -euo pipefail
cd "$(dirname "$0")/.."
name=rtgs-pgtest
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p 5433:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$name" psql -U postgres -c "create database rtgs_test" >/dev/null
for s in rtgs-core event-relay bank-gateway; do (cd "services/$s" && npm ci --silent); done
DATABASE_URL=postgres://postgres@localhost:5433/rtgs_test npm test
