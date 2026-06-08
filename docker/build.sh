#!/usr/bin/env bash
set -e

IMAGE="ghcr.io/porcupine-md/jonggrang-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building $IMAGE ..."
docker build \
  --platform linux/amd64,linux/arm64 \
  -t "$IMAGE:latest" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$SCRIPT_DIR"

echo ""
echo "Built: $IMAGE:latest"
echo "Push:  docker push $IMAGE:latest"
