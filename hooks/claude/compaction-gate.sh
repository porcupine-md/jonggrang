#!/usr/bin/env bash
# JONGGRANG — Compaction Gate Hook
# Claude Code PreToolUse hook (Task tool only)
# Blocks new agent spawning when context > 85%
#
# Input (stdin): JSON { tool_name, tool_input, ... }
# Exit 0 = allow, Exit 2 = block with message

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")')

# Only intercept Task tool (agent spawning)
if [[ "$TOOL_NAME" != "Task" ]]; then
  exit 0
fi

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

COMPACTION_STATE="$PROJECT_ROOT/.jonggrang/.ephemeral/compaction-state.json"

# If no state file, run compaction check via node
if [[ ! -f "$COMPACTION_STATE" ]]; then
  # Try to refresh state
  node -e "
    try {
      const c = require('${JONGGRANG_LIB}/compaction.js');
      const state = c.refreshCompactionState('$PROJECT_ROOT');
      process.exit(0);
    } catch(e) {
      process.exit(0);
    }
  " 2>/dev/null || true
fi

if [[ ! -f "$COMPACTION_STATE" ]]; then
  exit 0
fi

STATUS=$(jq -r '.status // "ok"' "$COMPACTION_STATE" 2>/dev/null || echo "ok")
RATIO=$(jq -r '.ratio // 0' "$COMPACTION_STATE" 2>/dev/null || echo "0")
MESSAGE=$(jq -r '.message // ""' "$COMPACTION_STATE" 2>/dev/null || echo "")
UPDATED=$(jq -r '.updated_at // ""' "$COMPACTION_STATE" 2>/dev/null || echo "")

# Check if state is stale (> 5 minutes old) — refresh if so
if [[ -n "$UPDATED" ]]; then
  NOW=$(date +%s)
  STATE_TIME=$(date -d "$UPDATED" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${UPDATED%.*}" +%s 2>/dev/null || echo 0)
  AGE=$((NOW - STATE_TIME))
  if [[ $AGE -gt 300 ]]; then
    node -e "
      try {
        const c = require('${JONGGRANG_LIB}/compaction.js');
        c.refreshCompactionState('$PROJECT_ROOT');
      } catch(e) {}
    " 2>/dev/null || true
    STATUS=$(jq -r '.status // "ok"' "$COMPACTION_STATE" 2>/dev/null || echo "ok")
    MESSAGE=$(jq -r '.message // ""' "$COMPACTION_STATE" 2>/dev/null || echo "")
  fi
fi

if [[ "$STATUS" == "block" ]]; then
  echo "COMPACTION GATE BLOCKED: $MESSAGE"
  echo "Run /compact to clear context before spawning new agents."
  echo "{ \"decision\": \"block\", \"reason\": \"$MESSAGE\" }"
  exit 2
fi

if [[ "$STATUS" == "must" || "$STATUS" == "warn" ]]; then
  echo "⚠ COMPACTION WARNING: $MESSAGE"
  # Non-blocking warning — allow but surface the message
fi

exit 0
