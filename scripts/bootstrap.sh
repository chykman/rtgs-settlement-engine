#!/usr/bin/env bash
# Creates the k3d cluster and installs ArgoCD. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."

ARGOCD_VERSION="${ARGOCD_VERSION:-v2.13.3}"
CLUSTER=rtgs

if k3d cluster list 2>/dev/null | grep -q "^${CLUSTER} "; then
  echo "cluster '${CLUSTER}' already exists"
  k3d cluster start "${CLUSTER}" >/dev/null 2>&1 || true
else
  echo "creating cluster '${CLUSTER}'"
  k3d cluster create --config cluster/k3d.yaml --wait
fi

kubectl config use-context "k3d-${CLUSTER}" >/dev/null
kubectl wait --for=condition=Ready nodes --all --timeout=180s

echo "installing ArgoCD ${ARGOCD_VERSION}"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
# server-side apply: some ArgoCD CRDs are too large for client-side apply
kubectl apply -n argocd --server-side --force-conflicts \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"
kubectl -n argocd rollout status deploy/argocd-server --timeout=300s
kubectl -n argocd rollout status deploy/argocd-repo-server --timeout=300s

# Secrets come from rtgs/.env (never from Git). Without it the pods wait; run `make rtgs-env` then `make up`.
if [ -f rtgs/.env ]; then
  bash scripts/create-secrets.sh
else
  echo "NOTE: rtgs/.env not found; run 'make rtgs-env' and then 'make secrets' before the pods can start"
fi

# Let ArgoCD read this (possibly private) repo. GITHUB_TOKEN is the codespace's own token for this repo.
if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  kubectl -n argocd create secret generic repo-rtgs \
    --from-literal=type=git --from-literal=url="https://github.com/${GITHUB_REPOSITORY}.git" \
    --from-literal=username="${GITHUB_ACTOR:-git}" --from-literal=password="${GITHUB_TOKEN}" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n argocd label secret repo-rtgs argocd.argoproj.io/secret-type=repository --overwrite
fi

# Root application ("app of apps"): ArgoCD manages everything else from Git.
if [ -f gitops/root-app.yaml ]; then
  kubectl apply -n argocd -f gitops/root-app.yaml
fi

cat <<MSG

Cluster and ArgoCD are ready.
  make argocd-ui        forward the UI to codespace port 8080 (open it from the Ports tab)
  make argocd-password  print the initial admin password (user: admin)
  make status           show nodes and pods
MSG
