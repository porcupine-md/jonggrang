#!/bin/bash
# Scan modified files for leaked secrets before agent completes
# SubagentStop hook

set -euo pipefail

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")
cd "$PROJECT_ROOT"

MODIFIED_FILES=$(git diff --name-only HEAD 2>/dev/null || true)

[ -z "$MODIFIED_FILES" ] && exit 0

if ! command -v trufflehog &>/dev/null; then
  echo "[jonggrang] WARNING: trufflehog tidak terinstall — secret scan dilewati. Install: https://github.com/trufflesecurity/trufflehog" >&2
  exit 0
fi

LEAKED=$(trufflehog git file://. --since-commit HEAD --only-verified --json 2>/dev/null || true)

if [ -n "$LEAKED" ]; then
  printf '{"decision": "block", "reason": %s}\n' \
    "$(printf 'BLOCKED: Secret terdeteksi di file yang dimodifikasi. Hapus secret dan ganti dengan referensi ke secret manager sebelum menyelesaikan task. Temuan: %s' "$LEAKED" | jq -Rs .)"
  exit 2
fi

exit 0
