#!/usr/bin/env bash
# Creates rtgs/.env with fresh random secrets (never committed). Refuses to overwrite an existing file.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e .env ] && { echo ".env already exists; delete it first to regenerate" >&2; exit 1; }
rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$1"; }
cluster_id="$(head -c 16 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
cat > .env <<ENV
POSTGRES_PASSWORD=$(rand 32)
INTERNAL_TOKEN=$(rand 48)
BANK_KEYS=key-alpha-$(rand 12)=BANKA,key-bravo-$(rand 12)=BANKB,key-charlie-$(rand 12)=BANKC,key-delta-$(rand 12)=BANKD
OPERATOR_KEY=key-operator-$(rand 12)
DEMO_MODE=true
ALLOW_RESET=true
KAFKA_CLUSTER_ID=${cluster_id}
KAFKA_ADMIN_PASSWORD=$(rand 24)
KAFKA_APP_PASSWORD=$(rand 24)
ENV
chmod 600 .env
echo "wrote rtgs/.env (DEMO_MODE=true exposes the sample keys in the console; test use only)"
