#!/usr/bin/env bash
# JONGGRANG — Feedback Loop Stop Hook
# Claude Code Stop / SubagentStop hook
# Blocks agent exit until all modified domains pass review AND testing
#
# Input (stdin): JSON { session_id, stop_reason, ... }
# Exit 0 = allow exit, Exit 2 = block exit with message

set -euo pipefail

INPUT=$(cat)
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")')

if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

# Resolve jonggrang lib — works in user projects (.jonggrang/lib/) and source repo (lib/)
_JONGGRANG_BASE="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)"
if [[ -z "${JONGGRANG_LIB:-}" ]]; then
  if [[ -d "${_JONGGRANG_BASE}/.jonggrang/lib" ]]; then
    JONGGRANG_LIB="${_JONGGRANG_BASE}/.jonggrang/lib"
  else
    JONGGRANG_LIB="${_JONGGRANG_BASE}/lib"
  fi
fi

FEEDBACK_STATE="$PROJECT_ROOT/.jonggrang/.ephemeral/feedback-loop-state.json"

# If no feedback state, allow exit (loop not active)
if [[ ! -f "$FEEDBACK_STATE" ]]; then
  exit 0
fi

ACTIVE=$(jq -r '.active // false' "$FEEDBACK_STATE" 2>/dev/null || echo "false")
DIRTY=$(jq -r '.dirty_bit // false' "$FEEDBACK_STATE" 2>/dev/null || echo "false")

if [[ "$ACTIVE" != "true" || "$DIRTY" != "true" ]]; then
  exit 0
fi

# Run exit gate check via node
GATE_RESULT=$(node -e "
  try {
    const fb = require('${JONGGRANG_LIB}/feedback.js');
    const result = fb.checkExitGate('$PROJECT_ROOT');
    console.log(JSON.stringify(result));
  } catch(e) {
    console.log(JSON.stringify({ allowed: true, reason: 'feedback.js error: ' + e.message }));
  }
" 2>/dev/null)

ALLOWED=$(echo "$GATE_RESULT" | jq -r '.allowed // true')
REASON=$(echo "$GATE_RESULT" | jq -r '.reason // ""')
STUCK=$(echo "$GATE_RESULT" | jq -r '.stuck_count // 0')

if [[ "$ALLOWED" == "true" ]]; then
  exit 0
fi

# Check if escalation advisor should trigger
if [[ "$STUCK" -gt 3 ]]; then
  echo "=== ESCALATION ADVISOR TRIGGERED ==="
  echo "Agent has been stuck for $STUCK consecutive exits."
  echo "Hint: Review feedback-loop-state.json and check if reviewer/tester agents"
  echo "have been spawned for all modified domains."
  echo ""
fi

echo "=== FEEDBACK LOOP GATE ==="
echo "$REASON"
echo ""
echo "To unblock:"
echo "  1. Spawn reviewer agent for each modified domain"
echo "  2. Spawn tester agent for each modified domain"
echo "  3. Both must return PASS status"
echo ""
echo "{ \"decision\": \"block\", \"reason\": \"Feedback loop: pending review/testing\" }"
exit 2
