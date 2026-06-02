#!/usr/bin/env bash
set -e

IMAGE="orcinus/jonggrang-agent:dev"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Building $IMAGE from local source ..."
echo "Context: $REPO_ROOT"
echo ""

docker build \
  -t "$IMAGE" \
  -f "$SCRIPT_DIR/Dockerfile.dev" \
  "$REPO_ROOT"

echo ""
echo "Built: $IMAGE"
echo ""
echo "To use this image:"
echo "  1. Set sandbox image to 'orcinus/jonggrang-agent:dev' in project settings"
echo "  2. Restart the project container so it picks up the new image"
