#!/usr/bin/env bash
# ensure-build.sh — auto-build client if dist/index.html is missing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_DIR="$PROJECT_DIR/client"
DIST_HTML="$CLIENT_DIR/dist/index.html"

if [ -f "$DIST_HTML" ]; then
  echo "[jonggrang] Frontend build found, skipping build."
  exit 0
fi

echo "[jonggrang] Frontend build not found. Running npm run build..."
cd "$PROJECT_DIR"

# If client/node_modules is missing, install dependencies first
if [ ! -d "$CLIENT_DIR/node_modules" ]; then
  echo "[jonggrang] client/node_modules missing. Installing..."
  cd "$CLIENT_DIR" && npm install
fi

npm run build
echo "[jonggrang] Build complete."
