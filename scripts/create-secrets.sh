#!/usr/bin/env bash
# Creates the namespace and the cluster Secrets from rtgs/.env (which is never committed).
# Optional: export GHCR_PULL_TOKEN (a PAT with read:packages) if the ghcr.io packages are private.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f rtgs/.env ] || { echo "rtgs/.env missing: run 'make rtgs-env' first" >&2; exit 1; }

kubectl create namespace rtgs --dry-run=client -o yaml | kubectl apply -f -
kubectl -n rtgs create secret generic rtgs-secrets --from-env-file=rtgs/.env \
  --dry-run=client -o yaml | kubectl apply -f -

if [ -n "${GHCR_PULL_TOKEN:-}" ]; then
  kubectl -n rtgs create secret docker-registry ghcr-pull \
    --docker-server=ghcr.io --docker-username="${GHCR_USER:-chykman}" --docker-password="$GHCR_PULL_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f -
fi
echo "secrets ready in namespace rtgs"
