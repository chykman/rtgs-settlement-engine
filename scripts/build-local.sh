#!/usr/bin/env bash
# Builds the six RTGS images and imports them into the k3d cluster (tag "dev"), no registry involved.
set -euo pipefail
cd "$(dirname "$0")/.."
tag=dev
build() { echo "== $1"; docker build -q -t "rtgs-$1:$tag" "${@:2}" >/dev/null; }
build core        rtgs/services/rtgs-core
build gateway     rtgs/services/bank-gateway
build event-relay rtgs/services/event-relay
build kafka       rtgs/services/kafka
build db          -f rtgs/services/db/Dockerfile rtgs/services
build web         rtgs/web
k3d image import -c rtgs \
  rtgs-core:$tag rtgs-gateway:$tag rtgs-event-relay:$tag rtgs-kafka:$tag rtgs-db:$tag rtgs-web:$tag
