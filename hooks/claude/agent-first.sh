#!/usr/bin/env bash
# JONGGRANG — Agent-First Enforcement Hook
# Claude Code PreToolUse hook
# Blocks orchestrator from directly editing files — forces delegation to specialized agents
#
# Input (stdin): JSON { tool_name, tool_input, session_id, ... }
# Exit 0 = allow, Exit 2 = block with message

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")')

# Only intercept Edit and Write tools
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

# If no project root, can't check — allow
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

AGENTS_CONFIG="$PROJECT_ROOT/.jonggrang/.output/agents-registry.json"

# If no agents registry exists, allow (orchestration not active)
if [[ ! -f "$AGENTS_CONFIG" ]]; then
  exit 0
fi

# Determine domain from file path
domain=""
if [[ "$FILE_PATH" =~ (frontend|client|components|pages|views|ui) ]]; then
  domain="frontend"
elif [[ "$FILE_PATH" =~ (backend|server|api|routes|controllers|handlers|services) ]]; then
  domain="backend"
elif [[ "$FILE_PATH" =~ (test|spec|__tests__|\.test\.|\.spec\.) ]]; then
  domain="testing"
elif [[ "$FILE_PATH" =~ (migrations?|schema\.|database|db/) ]]; then
  domain="database"
fi

if [[ -z "$domain" ]]; then
  exit 0
fi

# Check if a specialized agent is registered for this domain
AGENT_EXISTS=$(jq -r --arg domain "$domain" '.[$domain] // "none"' "$AGENTS_CONFIG" 2>/dev/null || echo "none")

if [[ "$AGENT_EXISTS" != "none" && "$AGENT_EXISTS" != "" ]]; then
  # Check if we're running AS the specialized agent (prevent self-blocking)
  CURRENT_ROLE=$(echo "$INPUT" | jq -r '.agent_role // ""')
  if [[ "$CURRENT_ROLE" == "developer" || "$CURRENT_ROLE" == "tester" ]]; then
    exit 0
  fi

  echo "AGENT-FIRST ENFORCEMENT: Cannot edit $FILE_PATH directly."
  echo "A '$domain' specialist exists. Spawn '$domain-developer' agent instead."
  echo "{ \"decision\": \"block\", \"reason\": \"Agent-first enforcement: spawn ${domain}-developer\" }"
  exit 2
fi

exit 0
