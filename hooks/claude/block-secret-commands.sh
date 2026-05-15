#!/bin/bash
# Block Bash commands that could expose secrets to LLM context
# PreToolUse hook — matcher: Bash

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

[ -z "$COMMAND" ] && exit 0

deny() {
  printf '{"decision": "block", "reason": %s}\n' "$(printf '%s' "$1" | jq -Rs .)"
  exit 2
}

# ── env / printenv / set (dump all env vars) ─────────────────────────────────
echo "$COMMAND" | grep -qE '^(env|printenv|set)([[:space:]]|$)' \
  && deny "DENIED: Command '$COMMAND' membuang semua env vars ke LLM context. Gunakan 'run-with-secrets <profile> <cmd>' untuk akses kredensial."

# ── export with literal value (not from subshell/variable) ───────────────────
echo "$COMMAND" | grep -qE '^export [A-Za-z_][A-Za-z0-9_]*=[^\$\(]' \
  && deny "DENIED: Command '$COMMAND' mungkin meng-export literal secret. Gunakan referensi dari secret manager."

# ── AWS credential commands ───────────────────────────────────────────────────
echo "$COMMAND" | grep -qE 'aws (configure list|sts get-session-token)' \
  && deny "DENIED: Command '$COMMAND' dapat membongkar AWS credentials. Gunakan 'run-with-secrets <profile> <cmd>'."

# ── GitHub CLI token dump ─────────────────────────────────────────────────────
echo "$COMMAND" | grep -qE 'gh auth (token|status)' \
  && deny "DENIED: Command '$COMMAND' dapat membongkar GitHub token. Gunakan 'run-with-secrets <profile> <cmd>'."

# ── kubectl config view without --minify ─────────────────────────────────────
if echo "$COMMAND" | grep -qE 'kubectl config view'; then
  echo "$COMMAND" | grep -q '\-\-minify' \
    || deny "DENIED: 'kubectl config view' tanpa --minify dapat membongkar semua kubeconfig. Tambahkan flag --minify."
fi

# ── cat of sensitive files ────────────────────────────────────────────────────
echo "$COMMAND" | grep -qiE 'cat .*(credentials|\.pem|\.key$|id_rsa|id_ed25519|id_dsa)' \
  && deny "DENIED: Command '$COMMAND' membaca file sensitif. Gunakan secret manager atau wrapper yang sesuai."

# ── echo of secret env vars ──────────────────────────────────────────────────
echo "$COMMAND" | grep -qiE 'echo \$[A-Za-z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)' \
  && deny "DENIED: Command '$COMMAND' mencetak nilai secret ke output. Jangan expose secret ke LLM context."

exit 0
