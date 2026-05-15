#!/bin/bash
# Redact secrets from tool output before it enters LLM context
# PostToolUse hook — matcher: "" (all tools)

set -euo pipefail

INPUT=$(cat)
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_response // ""' 2>/dev/null || printf '%s' "$INPUT")

SANITIZED=$(printf '%s' "$TOOL_OUTPUT" | \
  sed -E 's/AKIA[0-9A-Z]{16}/AKIA<REDACTED>/g' | \
  sed -E 's/(aws_secret_access_key[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1<REDACTED>/g' | \
  sed -E 's/-----BEGIN [A-Z ]*(PRIVATE|CERTIFICATE) KEY-----[^-]*/-----BEGIN <REDACTED>-----/g' | \
  sed -E 's/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+/\1<REDACTED>/g' | \
  sed -E 's|(postgres://[^:]+:)[^@]+@|\1<REDACTED>@|g' | \
  sed -E 's|(mongodb://[^:]+:)[^@]+@|\1<REDACTED>@|g' | \
  sed -E 's|(mysql://[^:]+:)[^@]+@|\1<REDACTED>@|g')

[ "$SANITIZED" != "$TOOL_OUTPUT" ] && printf '%s' "$SANITIZED"

exit 0
