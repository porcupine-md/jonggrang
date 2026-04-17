#!/usr/bin/env bash
# JONGGRANG — Task Role Claim Hook
# Claude Code PreToolUse hook (Task tool only)
# Writes a pending role entry before a sub-agent is spawned so that
# session-init.sh can claim it and register the session's role.
#
# Input (stdin): JSON { tool_name, tool_input, session_id, cwd, ... }
# Exit 0 always (non-blocking)

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

if [[ "$TOOL_NAME" != "Task" ]]; then
  exit 0
fi

PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")')
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

# Parse task description/prompt for role keywords
TASK_DESC=$(echo "$INPUT" | jq -r '(.tool_input.description // .tool_input.prompt // "") | ascii_downcase')

# Infer role from task description
role=""
if echo "$TASK_DESC" | grep -qE '\b(tester|testing agent)\b'; then
  role="tester"
elif echo "$TASK_DESC" | grep -qE '\b(reviewer|review agent|auditor)\b'; then
  role="reviewer"
elif echo "$TASK_DESC" | grep -qE 'test[- ]lead|test strategy'; then
  role="test-lead"
elif echo "$TASK_DESC" | grep -qE '\b(lead|architect|architecture)\b'; then
  role="lead"
elif echo "$TASK_DESC" | grep -qE '\b(developer|implement|executor)\b'; then
  role="developer"
fi

if [[ -z "$role" ]]; then
  exit 0
fi

# Write pending role file with nanosecond timestamp for uniqueness
PENDING_DIR="$PROJECT_ROOT/.jonggrang/.ephemeral/pending-roles"
mkdir -p "$PENDING_DIR"

# Use nanoseconds if available, fallback to seconds + random
TIMESTAMP=$(date +%s%N 2>/dev/null || echo "$(date +%s)$(( RANDOM * RANDOM ))")
PENDING_FILE="$PENDING_DIR/${TIMESTAMP}.json"

echo "{\"role\": \"$role\", \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$PENDING_FILE"

echo "[jonggrang] Pending role queued for next session: $role" >&2

exit 0
