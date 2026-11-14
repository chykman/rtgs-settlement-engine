#!/usr/bin/env bash
# Installs the CLIs the devcontainer features do not provide: k3d and argocd.
# Versions are pinned so a fresh codespace behaves the same every time.
set -euo pipefail

K3D_VERSION="${K3D_VERSION:-v5.8.3}"
ARGOCD_VERSION="${ARGOCD_VERSION:-v2.13.3}"

arch="$(uname -m)"
case "$arch" in
  x86_64)  goarch=amd64 ;;
  aarch64) goarch=arm64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

install_bin() { sudo install -m 0755 "$1" "/usr/local/bin/$2"; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

if ! command -v k3d >/dev/null 2>&1; then
  echo "Installing k3d ${K3D_VERSION}"
  curl -fsSL -o "$tmp/k3d" "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-linux-${goarch}"
  install_bin "$tmp/k3d" k3d
fi

if ! command -v argocd >/dev/null 2>&1; then
  echo "Installing argocd ${ARGOCD_VERSION}"
  curl -fsSL -o "$tmp/argocd" "https://github.com/argoproj/argo-cd/releases/download/${ARGOCD_VERSION}/argocd-linux-${goarch}"
  install_bin "$tmp/argocd" argocd
fi

echo "--- tool versions ---"
node -v
docker --version
kubectl version --client
helm version --short
k3d version
argocd version --client --short
