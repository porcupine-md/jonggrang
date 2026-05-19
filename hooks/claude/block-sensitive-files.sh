#!/bin/bash
# Block AI agent from reading/writing sensitive files
# PreToolUse hook — matcher: Read|Edit|Write|Glob|Grep

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')
# Grep can pass a glob (e.g. "*.pem") with path=. — check that too.
GLOB_PATTERN=$(echo "$INPUT" | jq -r '.tool_input.glob // ""')

[ -z "$FILE_PATH" ] && [ -z "$GLOB_PATTERN" ] && exit 0

deny() {
  printf '{"decision": "block", "reason": %s}\n' "$(printf '%s' "$1" | jq -Rs .)"
  exit 2
}

# Resolve symlinks so a path like /tmp/notes.md → ~/.ssh/id_rsa can't bypass.
# Fall back to the original if the file doesn't exist yet (Write/Edit creating new file).
RESOLVED_PATH="$FILE_PATH"
if [ -n "$FILE_PATH" ]; then
  if command -v realpath &>/dev/null; then
    RESOLVED_PATH=$(realpath -- "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
  elif command -v readlink &>/dev/null; then
    RESOLVED_PATH=$(readlink -f -- "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
  fi
fi

# ===== ALLOWLIST: *.example — always allowed =====
if echo "$FILE_PATH" | grep -qE '\.example$' && echo "$RESOLVED_PATH" | grep -qE '\.example$'; then
  exit 0
fi

# ===== CONDITIONAL ALLOW: .env / orcinus.* — only if in .gitignore =====
if echo "$FILE_PATH" | grep -qE '(^|/)(\.env(\.[^/]+)?|orcinus(\.[^/]+)?)$'; then
  if git check-ignore -q -- "$FILE_PATH" 2>/dev/null; then
    exit 0
  else
    deny "DENIED: '$FILE_PATH' diblokir karena belum ada di .gitignore. Tambahkan ke .gitignore sebelum akses (SOP Section 4.1)."
  fi
fi

# ===== HARD BLOCK: sensitive file patterns =====
SENSITIVE_PATTERNS=(
  '\.pem$'
  '\.key$'
  '(^|/)id_rsa'
  'id_ed25519'
  'id_dsa'
  '\bcredentials\b'
  '\.pfx$'
  '\.p12$'
  '\.crt$'
  '\.cer$'
  '\.pkcs12$'
  '\.jks$'
  '\.keystore$'
  '(^|/)\.ssh/'
  'authorized_keys'
)

# Check both the literal path AND the resolved target, plus any glob pattern (e.g. Grep "*.pem").
for pattern in "${SENSITIVE_PATTERNS[@]}"; do
  for candidate in "$FILE_PATH" "$RESOLVED_PATH" "$GLOB_PATTERN"; do
    [ -z "$candidate" ] && continue
    if echo "$candidate" | grep -qiE "$pattern"; then
      deny "DENIED: Akses ke '$candidate' diblokir — file sensitif (pattern: $pattern). Gunakan secret manager atau wrapper yang sesuai."
    fi
  done
done

exit 0
