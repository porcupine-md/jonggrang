#!/usr/bin/env bash
# node-pty launches a small spawn helper on Unix. Some package extractions lose
# its executable bit, which turns every PTY launch into "posix_spawnp failed".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="$(node -p 'process.platform')"
ARCH="$(node -p 'process.arch')"
HELPER="$ROOT/node_modules/node-pty/prebuilds/${PLATFORM}-${ARCH}/spawn-helper"

# Native builds and Windows do not use this packaged Unix helper.
if [[ ! -e "$HELPER" ]]; then
  exit 0
fi

if [[ -x "$HELPER" ]]; then
  exit 0
fi

chmod u+x "$HELPER"
printf '[node-pty] restored executable permission: %s\n' "$HELPER"
