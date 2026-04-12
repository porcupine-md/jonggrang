#!/usr/bin/env bash
# JONGGRANG — Session Init Hook
# Claude Code UserPromptSubmit hook
# Registers the current session's role by:
#   1. Detecting role from the prompt text (agent identity phrase)
#   2. Falling back to claiming the oldest pending role from the queue
# Result is stored in .jonggrang/.ephemeral/session-roles.json
#
# Input (stdin): JSON { session_id, prompt, cwd, ... }
# Exit 0 always (non-blocking)

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")')

if [[ -z "$PROJECT_ROOT" || -z "$SESSION_ID" ]]; then
  exit 0
fi

SESSION_ROLES="$PROJECT_ROOT/.jonggrang/.ephemeral/session-roles.json"

# If this session already has a role, nothing to do
if [[ -f "$SESSION_ROLES" ]]; then
  EXISTING=$(jq -r --arg sid "$SESSION_ID" '.[$sid] // ""' "$SESSION_ROLES" 2>/dev/null || echo "")
  if [[ -n "$EXISTING" ]]; then
    exit 0
  fi
fi

# ── 1. Detect role from prompt text (agent identity phrase) ─────────────────
PROMPT=$(echo "$INPUT" | jq -r '(.prompt // "") | ascii_downcase')
role=""

if echo "$PROMPT" | grep -qE 'you are a specialized tester|specialized tester'; then
  role="tester"
elif echo "$PROMPT" | grep -qE 'you are a specialized reviewer|specialized reviewer'; then
  role="reviewer"
elif echo "$PROMPT" | grep -qE 'you are a test lead|test lead'; then
  role="test-lead"
elif echo "$PROMPT" | grep -qE 'you are a specialized lead|specialized lead'; then
  role="lead"
elif echo "$PROMPT" | grep -qE 'you are a specialized developer|specialized developer'; then
  role="developer"
fi

# ── 2. Fallback: claim oldest pending role from queue ───────────────────────
if [[ -z "$role" ]]; then
  PENDING_DIR="$PROJECT_ROOT/.jonggrang/.ephemeral/pending-roles"
  if [[ -d "$PENDING_DIR" ]]; then
    # Oldest file = smallest timestamp = first in sorted list
    OLDEST=$(ls -1 "$PENDING_DIR"/*.json 2>/dev/null | head -1 || true)
    if [[ -n "$OLDEST" && -f "$OLDEST" ]]; then
      role=$(jq -r '.role // ""' "$OLDEST" 2>/dev/null || echo "")
      rm -f "$OLDEST"
    fi
  fi
fi

if [[ -z "$role" ]]; then
  exit 0
fi

# ── 3. Register session → role ───────────────────────────────────────────────
mkdir -p "$(dirname "$SESSION_ROLES")"

node -e "
  const fs = require('fs');
  const f = process.argv[1];
  let data = {};
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
  data[process.argv[2]] = process.argv[3];
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
" "$SESSION_ROLES" "$SESSION_ID" "$role" 2>/dev/null || true

echo "[jonggrang] Session $SESSION_ID registered as: $role" >&2

exit 0
