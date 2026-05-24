#!/bin/bash
# Block Bash commands that could expose secrets to LLM context
# PreToolUse hook — matcher: Bash
#
# Defense-in-depth: catches naive and chained forms (`; env`, `&& printenv`,
# `bash -c env`, `$(env)`). Not airtight — `eval`, base64-decode-then-exec,
# or other obfuscation can slip through. Pair with output sanitization and
# PreToolUse file blocks.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

[ -z "$COMMAND" ] && exit 0

deny() {
  printf '{"decision": "block", "reason": %s}\n' "$(printf '%s' "$1" | jq -Rs .)"
  exit 2
}

# Lift command-substitution `$(...)` and backtick contents onto their own lines
# so `echo $(env)` and `echo \`env\`` get checked, not just the outer command.
# Then split on chain operators ( ; && || | ) so each piped/chained segment is
# inspected individually.
NORMALIZED=$(printf '%s' "$COMMAND" \
  | perl -pe 's/\$\(([^)]*)\)/\n$1\n/g; s/`([^`]*)`/\n$1\n/g; s/[()]/ /g' 2>/dev/null \
  || printf '%s' "$COMMAND" | sed -E 's/\$\(/ /g; s/[`()]/ /g')
SEGMENTS=$(printf '%s' "$NORMALIZED" | awk '{
  gsub(/&&/, "\n"); gsub(/\|\|/, "\n"); gsub(/;/, "\n"); gsub(/\|/, "\n"); print
}')

READERS='(cat|head|tail|less|more|xxd|od|hexdump|strings|awk|sed|cp|mv|tar|zip|base64|openssl|grep|rg|fgrep|egrep|nl|tac|view|vim|vi|nano|emacs|code|subl)'
SECRETPATH='(credentials|\.pem(\s|$)|\.key(\s|$)|id_rsa|id_ed25519|id_ecdsa|id_ed25519_sk|id_ecdsa_sk|id_dsa|identity|ssh_host_.*_key|\.ssh/|\.aws/credentials|authorized_keys)'

while IFS= read -r seg; do
  # Trim whitespace and strip a leading `(bash|sh|zsh|dash) -c '...'` wrapper.
  seg=$(printf '%s' "$seg" | sed -E "s/^[[:space:]]+//; s/[[:space:]]+$//; s/^(bash|sh|zsh|dash)[[:space:]]+-c[[:space:]]+['\"]?//; s/^['\"]+//")
  [ -z "$seg" ] && continue

  # ── env / printenv / set (dump all env vars) ─────────────────────────
  echo "$seg" | grep -qE '^(env|printenv|set)([[:space:]]|$)' \
    && deny "DENIED: '$seg' dumps all env vars into LLM context. Use 'run-with-secrets <profile> <cmd>' to access credentials safely."

  # ── export with literal value (not from subshell/variable) ───────────
  echo "$seg" | grep -qE '^export[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[^$]' \
    && deny "DENIED: '$seg' may export a literal secret. Use a secret manager reference instead."

  # ── AWS credential commands ──────────────────────────────────────────
  echo "$seg" | grep -qE '\baws[[:space:]]+(configure[[:space:]]+list|sts[[:space:]]+get-session-token)\b' \
    && deny "DENIED: '$seg' may expose AWS credentials. Use 'run-with-secrets <profile> <cmd>'."

  # ── GitHub CLI token dump ────────────────────────────────────────────
  echo "$seg" | grep -qE '\bgh[[:space:]]+auth[[:space:]]+(token|status)\b' \
    && deny "DENIED: '$seg' may expose GitHub token. Use 'run-with-secrets <profile> <cmd>'."

  # ── kubectl config view without --minify ─────────────────────────────
  if echo "$seg" | grep -qE '\bkubectl[[:space:]]+config[[:space:]]+view\b'; then
    echo "$seg" | grep -q '\-\-minify' \
      || deny "DENIED: 'kubectl config view' without --minify may expose all kubeconfig data. Add the --minify flag."
  fi

  # ── Any reader-like command targeting a sensitive path ──────────────
  if echo "$seg" | grep -qiE "\\b${READERS}\\b.*${SECRETPATH}"; then
    deny "DENIED: '$seg' reads a sensitive file. Use a secret manager or an appropriate wrapper instead."
  fi

  # ── echo of secret env vars ──────────────────────────────────────────
  echo "$seg" | grep -qiE 'echo[[:space:]]+\$[A-Za-z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)' \
    && deny "DENIED: '$seg' prints a secret value to output. Do not expose secrets to LLM context."

done <<< "$SEGMENTS"

exit 0
