#!/usr/bin/env bash
# JONGGRANG — Track Modifications Hook
# Claude Code PostToolUse hook (Edit/Write tools)
# Sets dirty bit in feedback-loop-state.json for modified domain
#
# Input (stdin): JSON { tool_name, tool_input, tool_output, ... }
# Exit 0 always (non-blocking)

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")')

# Only track Edit and Write tools
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

if [[ -z "$PROJECT_ROOT" || -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip .jonggrang/ orchestration files — ephemeral plans/reports are not production code
if [[ "$FILE_PATH" =~ \.jonggrang/ || "$FILE_PATH" =~ /\.jonggrang/ ]]; then
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

# Determine domain from file path
domain="backend"  # default

if [[ "$FILE_PATH" =~ (frontend|client|components|pages|views|ui|\.tsx$|\.jsx$|\.css$|\.scss$) ]]; then
  domain="frontend"
elif [[ "$FILE_PATH" =~ (\.test\.|\.spec\.|__tests__|/test/|/tests/) ]]; then
  domain="testing"
elif [[ "$FILE_PATH" =~ (migrations?/|schema\.|/database/|/db/) ]]; then
  domain="database"
elif [[ "$FILE_PATH" =~ (routes?/|controllers?/|handlers?/|api/|services?/) ]]; then
  domain="api"
fi

# Set dirty bit via node
node -e "
  try {
    const fb = require('${JONGGRANG_LIB}/feedback.js');
    fb.setDirtyBit('$PROJECT_ROOT', '$domain');
    console.error('[jonggrang] Dirty bit set for domain: $domain (${FILE_PATH})');
  } catch(e) {
    console.error('[jonggrang] track-modifications warning:', e.message);
  }
" 2>&1 | grep -E '^\[jonggrang\]' >&2 || true

exit 0
