#!/usr/bin/env bash
# JONGGRANG — Task Skill Enforcement Hook (Output Location Enforcement — Layer 1)
# Claude Code PostToolUse hook (Task tool only)
# Non-blocking warning if agent output does not appear to have used persisting-agent-outputs
#
# Input (stdin): JSON { tool_name, tool_response, cwd, ... }
# Exit 0 always (non-blocking feedback only)

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

if [[ "$TOOL_NAME" != "Task" ]]; then
  exit 0
fi

# Check tool response for output persistence markers
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_response // ""' 2>/dev/null || echo "")

PERSISTED=false
if echo "$TOOL_OUTPUT" | grep -qiE '(jonggrang-output|\.jonggrang/.output|persisting-agent-outputs)'; then
  PERSISTED=true
fi

if [[ "$PERSISTED" == "false" && -n "$TOOL_OUTPUT" ]]; then
  echo "⚠ [jonggrang] SKILL COMPLIANCE: agent may not have invoked persisting-agent-outputs."
  echo "  Outputs should be written to .jonggrang/.output/features/{feature_id}/ with jonggrang-output: true"
  echo "  (non-blocking — verify agent output for compliance)"
fi

exit 0
