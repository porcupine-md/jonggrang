#!/usr/bin/env bash
set -euo pipefail

# Smoke-test anoa inside a Jonggrang agent image.
# Verifies the packaged browser starts, opens a page, snapshots its interactive
# elements, resizes the viewport and captures a valid PNG — the whole path an
# agent takes when it validates a rendered UI.
#
# Usage:
#   bash scripts/anoa-smoke.sh [image]
#
# Default:
#   ghcr.io/porcupine-md/jonggrang-agent:dev

IMAGE="${1:-${IMAGE:-ghcr.io/porcupine-md/jonggrang-agent:dev}}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jg-anoa-smoke.XXXXXX")"
CONTAINER_NAME="jg-anoa-smoke-$$"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
docker info >/dev/null 2>&1 || fail "docker daemon is not available"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf 'Pulling %s\n' "$IMAGE"
  docker pull "$IMAGE" >/dev/null
fi

cat > "$TMP_DIR/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Jonggrang browser smoke</h1>
      <button type="button">Ready</button>
    </main>
  </body>
</html>
HTML

cat > "$TMP_DIR/server.js" <<'JS'
const fs = require('fs');
const http = require('http');

const page = fs.readFileSync('/smoke/index.html');
http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
}).listen(4173, '127.0.0.1');
JS

cat > "$TMP_DIR/verify-png.js" <<'JS'
const fs = require('fs');
const png = fs.readFileSync('/smoke/mobile.png');

if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
  throw new Error('screenshot is not a PNG');
}
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== 375 || height !== 812) {
  throw new Error(`expected 375x812 screenshot, got ${width}x${height}`);
}
JS

printf 'Testing anoa in %s\n' "$IMAGE"
docker run --name "$CONTAINER_NAME" --rm \
  -v "$TMP_DIR:/smoke" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail

    cleanup() {
      kill "${BROWSER_PID:-}" >/dev/null 2>&1 || true
      kill "${SERVER_PID:-}" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT INT TERM

    command -v anoa >/dev/null
    anoa --version

    # anoa is a session: start one browser, everything else attaches to it.
    anoa --headless --port 9222 >/tmp/jg-anoa-smoke-browser.log 2>&1 &
    BROWSER_PID=$!
    for _ in $(seq 1 50); do
      anoa status >/dev/null 2>&1 && break
      sleep 0.2
    done
    anoa status >/dev/null

    node /smoke/server.js >/tmp/jg-anoa-smoke-server.log 2>&1 &
    SERVER_PID=$!

    for _ in $(seq 1 30); do
      if curl -fsS http://127.0.0.1:4173 >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done
    curl -fsS http://127.0.0.1:4173 >/dev/null

    anoa open http://127.0.0.1:4173 >/dev/null
    anoa wait --text "Jonggrang browser smoke" >/dev/null

    grep -q "Jonggrang browser smoke" <<<"$(anoa get text)"
    grep -q "button" <<<"$(anoa snapshot -i)"

    anoa set viewport 375 812 >/dev/null
    anoa screenshot /smoke/mobile.png >/dev/null
    node /smoke/verify-png.js
  '

printf 'PASS: anoa start/open/get text/snapshot/viewport/screenshot\n'
