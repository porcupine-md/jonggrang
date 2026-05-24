#!/bin/bash
# Scan modified files for leaked secrets before agent completes
# SubagentStop hook

set -euo pipefail

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")
cd "$PROJECT_ROOT"

# Collect unstaged + staged modifications + untracked files (working-tree state).
MODIFIED_FILES=$(
  {
    git diff --name-only 2>/dev/null
    git diff --name-only --cached 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u | grep -v '^$' || true
)

[ -z "$MODIFIED_FILES" ] && exit 0

if ! command -v trufflehog &>/dev/null; then
  echo "[jonggrang] WARNING: trufflehog not installed — secret scan skipped. Install: https://github.com/trufflesecurity/trufflehog" >&2
  exit 0
fi

# Mirror modified working-tree files into a tempdir so trufflehog scans the
# CURRENT content (the original `--since-commit HEAD` form scanned commits
# after HEAD — i.e., nothing).
SCAN_DIR=$(mktemp -d -t jonggrang-secret-scan.XXXXXXXX)
trap 'rm -rf "$SCAN_DIR"' EXIT

while IFS= read -r f; do
  [ -f "$f" ] || continue
  dest="$SCAN_DIR/$f"
  mkdir -p "$(dirname "$dest")"
  cp -- "$f" "$dest" 2>/dev/null || true
done <<< "$MODIFIED_FILES"

LEAKED=$(trufflehog filesystem --directory="$SCAN_DIR" --only-verified --json --no-update 2>/dev/null || true)

if [ -n "$LEAKED" ]; then
  printf '{"decision": "block", "reason": %s}\n' \
    "$(printf 'BLOCKED: Secret detected in modified files. Remove the secret and replace it with a secret manager reference before completing the task. Findings: %s' "$LEAKED" | jq -Rs .)"
  exit 2
fi

exit 0
