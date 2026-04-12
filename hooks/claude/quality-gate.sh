#!/usr/bin/env bash
# JONGGRANG — Quality Gate Stop Hook (Defense-in-Depth)
# Claude Code Stop hook — backup check after feedback-loop.sh
# Catches anything that slipped through SubagentStop
#
# Input (stdin): JSON { session_id, stop_reason, ... }
# Exit 0 = allow exit, Exit 2 = block exit with message

set -euo pipefail

INPUT=$(cat)
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")')

if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

VIOLATIONS=()

# ─── Check 1: Untracked markdown files outside .jonggrang/.output/ ────────────
# Agents should write reports to .jonggrang/.output/, not scatter them
UNTRACKED_MD=$(git -C "$PROJECT_ROOT" ls-files --others --exclude-standard 2>/dev/null | grep '\.md$' \
  | grep -v '\.jonggrang/' | grep -v '\.claude/' | grep -v '\.opencode/' \
  | grep -v 'AGENTS\.md' | grep -v 'CLAUDE\.md' | grep -v 'SKILL\.md' | grep -v 'progress\.txt' \
  | head -10 || true)

if [[ -n "$UNTRACKED_MD" ]]; then
  while IFS= read -r file; do
    VIOLATIONS+=("Untracked .md outside .jonggrang/.output/: $file")
  done <<< "$UNTRACKED_MD"
fi

# ─── Check 2: Feedback loop state — is dirty bit still set? ──────────────────
FEEDBACK_STATE="$PROJECT_ROOT/.jonggrang/.ephemeral/feedback-loop-state.json"
if [[ -f "$FEEDBACK_STATE" ]]; then
  ACTIVE=$(jq -r '.active // false' "$FEEDBACK_STATE" 2>/dev/null || echo "false")
  DIRTY=$(jq -r '.dirty_bit // false' "$FEEDBACK_STATE" 2>/dev/null || echo "false")

  if [[ "$ACTIVE" == "true" && "$DIRTY" == "true" ]]; then
    VIOLATIONS+=("Feedback loop dirty bit still set — review/testing incomplete")
  fi
fi


# ─── Report ──────────────────────────────────────────────────────────────────
if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
  exit 0
fi

echo "=== QUALITY GATE VIOLATIONS ==="
for v in "${VIOLATIONS[@]}"; do
  echo "  ✗ $v"
done
echo ""
echo "Resolve violations before completing this phase."
echo "{ \"decision\": \"block\", \"reason\": \"Quality gate: ${#VIOLATIONS[@]} violation(s) found\" }"
exit 2
