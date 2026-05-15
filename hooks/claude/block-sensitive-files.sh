#!/bin/bash
# Block AI agent from reading/writing sensitive files
# PreToolUse hook — matcher: Read|Edit|Write|Glob|Grep

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')

[ -z "$FILE_PATH" ] && exit 0

deny() {
  printf '{"decision": "block", "reason": %s}\n' "$(printf '%s' "$1" | jq -Rs .)"
  exit 2
}

# ===== ALLOWLIST: *.example — always allowed =====
echo "$FILE_PATH" | grep -qE '\.example$' && exit 0

# ===== CONDITIONAL ALLOW: .env / orcinus.* — only if in .gitignore =====
if echo "$FILE_PATH" | grep -qE '(^|/)(\.env(\.[^/]+)?|orcinus(\.[^/]+)?)$'; then
  if git check-ignore -q "$FILE_PATH" 2>/dev/null; then
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

for pattern in "${SENSITIVE_PATTERNS[@]}"; do
  if echo "$FILE_PATH" | grep -qiE "$pattern"; then
    deny "DENIED: Akses ke '$FILE_PATH' diblokir — file sensitif (pattern: $pattern). Gunakan secret manager atau wrapper yang sesuai."
  fi
done

exit 0
