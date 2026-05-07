#!/usr/bin/env bash
# JONGGRANG — Quality Gate Stop Hook (Defense-in-Depth)
# Claude Code Stop hook — backup check after feedback-loop.sh
# Catches anything that slipped through SubagentStop
#
# Input (stdin): JSON { session_id, stop_reason, ... }
# Exit 0 = allow exit, Exit 2 = block exit with message

# Read JSON from stdin only if it's a pipe (not a terminal)
if [ -t 0 ]; then
  INPUT='{}'
else
  INPUT=$(cat 2>/dev/null || echo '{}')
fi

PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")' 2>/dev/null || true)

# Fallback: use git root or pwd when no JSON cwd provided (e.g. manual run)
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi

VIOLATION_COUNT=0
VIOLATION_MSGS=""

# ─── Check 1: Untracked markdown files outside .jonggrang/.output/ ────────────
UNTRACKED_MD=$(git -C "$PROJECT_ROOT" ls-files --others --exclude-standard 2>/dev/null \
  | grep '\.md$' \
  | grep -v 'node_modules/' | grep -v '\.jonggrang/' | grep -v '\.claude/' | grep -v '\.opencode/' \
  | grep -v 'AGENTS\.md' | grep -v 'CLAUDE\.md' | grep -v 'SKILL\.md' | grep -v 'progress\.txt' \
  | head -10 || true)

if [ -n "$UNTRACKED_MD" ]; then
  while IFS= read -r file; do
    VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
    VIOLATION_MSGS="${VIOLATION_MSGS}  ✗ Untracked .md outside .jonggrang/.output/: ${file}\n"
  done <<< "$UNTRACKED_MD"
fi

# ─── Check 2: Feedback loop state — is dirty bit still set? ──────────────────
FEEDBACK_STATE="$PROJECT_ROOT/.jonggrang/.ephemeral/feedback-loop-state.json"
if [ -f "$FEEDBACK_STATE" ]; then
  ACTIVE=$(jq -r '.active // false' "$FEEDBACK_STATE" 2>/dev/null || echo "false")
  DIRTY=$(jq -r '.dirty_bit // false' "$FEEDBACK_STATE" 2>/dev/null || echo "false")
  if [ "$ACTIVE" = "true" ] && [ "$DIRTY" = "true" ]; then
    VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
    VIOLATION_MSGS="${VIOLATION_MSGS}  ✗ Feedback loop dirty bit still set — review/testing incomplete\n"
  fi
fi

# ─── Report ──────────────────────────────────────────────────────────────────
if [ "$VIOLATION_COUNT" -eq 0 ]; then
  exit 0
fi

echo "=== QUALITY GATE VIOLATIONS ==="
printf "%b" "$VIOLATION_MSGS"
echo ""
echo "Resolve violations before completing this phase."
echo "{ \"decision\": \"block\", \"reason\": \"Quality gate: ${VIOLATION_COUNT} violation(s) found\" }"
exit 2
