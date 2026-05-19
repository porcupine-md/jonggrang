#!/bin/bash
# Detect leaked secrets in tool output and surface a warning to the LLM.
# PostToolUse hook — matcher: "" (all tools)
#
# CAVEAT: Claude Code's PostToolUse hook does NOT mutate the tool_response the
# model already received. This hook can only:
#   (a) detect secrets and inject `hookSpecificOutput.additionalContext` so the
#       model is told a redacted version exists and warned not to repeat the raw
#       value, and
#   (b) optionally block-on-detect via exit 2.
# The real defense lives at PreToolUse: block-sensitive-files.sh and
# block-secret-commands.sh stop the secret from being read in the first place.

set -euo pipefail

INPUT=$(cat)
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_response // ""' 2>/dev/null || printf '%s' "$INPUT")
[ -z "$TOOL_OUTPUT" ] && exit 0

SANITIZED=$(printf '%s' "$TOOL_OUTPUT" | \
  sed -E 's/(AKIA|ASIA)[0-9A-Z]{16}/AWS_KEY<REDACTED>/g' | \
  sed -E 's/(aws_secret_access_key[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1<REDACTED>/g' | \
  sed -E 's/(aws_access_key_id[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1<REDACTED>/g' | \
  sed -E 's/-----BEGIN [A-Z ]*(PRIVATE|CERTIFICATE|EC|OPENSSH) KEY-----/-----BEGIN <REDACTED>-----/g' | \
  sed -E 's/(eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+/\1<REDACTED>/g' | \
  sed -E 's|(postgres(ql)?://[^:[:space:]]+:)[^@[:space:]]+@|\1<REDACTED>@|g' | \
  sed -E 's|(mongodb(\+srv)?://[^:[:space:]]+:)[^@[:space:]]+@|\1<REDACTED>@|g' | \
  sed -E 's|(mysql://[^:[:space:]]+:)[^@[:space:]]+@|\1<REDACTED>@|g' | \
  sed -E 's|(redis://[^:[:space:]]+:)[^@[:space:]]+@|\1<REDACTED>@|g')

if [ "$SANITIZED" != "$TOOL_OUTPUT" ]; then
  WARNING=$(printf '⚠ SECRET LEAK DETECTED in tool output. The redacted form is below. DO NOT repeat the raw secret values back, do NOT write them to files, and do NOT commit them. Treat them as untrusted and surface the leak to the user.\n\n---\nREDACTED OUTPUT:\n%s\n---' "$SANITIZED")
  jq -n --arg ctx "$WARNING" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: $ctx
    }
  }'
fi

exit 0
