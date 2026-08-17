#!/usr/bin/env bash
# JONGGRANG — Codex dispatcher smoke test (deterministic)
#
# Proves Jonggrang's Codex dispatcher contract works when invoked the way
# Codex hooks would invoke it: `node hooks/codex/dispatcher.js <hookName>` with
# one Codex-shaped JSON object on stdin.
#
# This does NOT prove `codex exec` dispatches hooks. That upstream runtime path
# is covered by scripts/smoke-e2e-codex-hooks.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DISPATCHER="$ROOT/hooks/codex/dispatcher.js"
PASS=0
FAIL=0

ok() { printf '  \033[0;32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
not_ok() { printf '  \033[0;31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }

run_dispatcher() {
  local hook_name="$1"
  local payload="$2"
  local out_file="$3"
  local err_file="$4"

  set +e
  printf '%s' "$payload" | node "$DISPATCHER" "$hook_name" >"$out_file" 2>"$err_file"
  local code=$?
  set -e
  return "$code"
}

assert_json_expr() {
  local file="$1"
  local expr="$2"
  node -e '
    const fs = require("fs");
    const obj = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expr = process.argv[2];
    if (!Function("obj", `return (${expr});`)(obj)) process.exit(1);
  ' "$file" "$expr"
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

printf '\033[1;36mCodex dispatcher smoke\033[0m\n'

# 1. PreToolUse deny: secret command must block.
OUT="$TMPDIR/secret.out"; ERR="$TMPDIR/secret.err"
if run_dispatcher blockSecretCommands \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"env"},"cwd":"'"$ROOT"'"}' \
  "$OUT" "$ERR"; then
  code=0
else
  code=$?
fi
if [ "$code" -eq 2 ] \
  && assert_json_expr "$OUT" 'obj.hookSpecificOutput?.hookEventName === "PreToolUse"' \
  && assert_json_expr "$OUT" 'obj.hookSpecificOutput?.permissionDecision === "deny"' \
  && grep -q 'SECRET COMMAND BLOCKED' "$OUT"; then
  ok 'blockSecretCommands denies env with PreToolUse deny JSON + exit 2'
else
  not_ok 'blockSecretCommands should deny env'
  printf 'stdout:\n%s\nstderr:\n%s\nexit=%s\n' "$(cat "$OUT")" "$(cat "$ERR")" "$code"
fi

# 2. Positive path: benign Bash command should allow with no stdout.
OUT="$TMPDIR/benign.out"; ERR="$TMPDIR/benign.err"
if run_dispatcher blockSecretCommands \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"},"cwd":"'"$ROOT"'"}' \
  "$OUT" "$ERR"; then
  code=0
else
  code=$?
fi
if [ "$code" -eq 0 ] && [ ! -s "$OUT" ]; then
  ok 'blockSecretCommands allows benign command with exit 0 + empty stdout'
else
  not_ok 'blockSecretCommands should allow benign command'
  printf 'stdout:\n%s\nstderr:\n%s\nexit=%s\n' "$(cat "$OUT")" "$(cat "$ERR")" "$code"
fi

# 3. Hooks.json command shape: git-root resolution must work from a subdir.
OUT="$TMPDIR/git-root.out"; ERR="$TMPDIR/git-root.err"
set +e
(
  cd "$ROOT/docs"
  printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"env"},"cwd":"'"$ROOT"'"}' \
    | bash -c 'node "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/hooks/codex/dispatcher.js" blockSecretCommands'
) >"$OUT" 2>"$ERR"
code=$?
set -e
if [ "$code" -eq 2 ] \
  && assert_json_expr "$OUT" 'obj.hookSpecificOutput?.permissionDecision === "deny"' \
  && grep -q 'SECRET COMMAND BLOCKED' "$OUT"; then
  ok 'hooks.json git-root dispatcher command works from a subdir'
else
  not_ok 'hooks.json git-root dispatcher command should work from a subdir'
  printf 'stdout:\n%s\nstderr:\n%s\nexit=%s\n' "$(cat "$OUT")" "$(cat "$ERR")" "$code"
fi

# 4. F1 parity: task-skill warning on SubagentStop must be non-blocking systemMessage.
OUT="$TMPDIR/task-skill.out"; ERR="$TMPDIR/task-skill.err"
if run_dispatcher taskSkillEnforcement \
  '{"hook_event_name":"SubagentStop","last_assistant_message":"done without persistence marker","cwd":"'"$ROOT"'"}' \
  "$OUT" "$ERR"; then
  code=0
else
  code=$?
fi
if [ "$code" -eq 0 ] \
  && assert_json_expr "$OUT" 'typeof obj.systemMessage === "string" && obj.systemMessage.includes("SKILL COMPLIANCE")' \
  && assert_json_expr "$OUT" 'obj.decision === undefined' \
  && assert_json_expr "$OUT" 'obj.hookSpecificOutput === undefined'; then
  ok 'taskSkillEnforcement emits non-blocking systemMessage on SubagentStop'
else
  not_ok 'taskSkillEnforcement should preserve non-blocking systemMessage semantics'
  printf 'stdout:\n%s\nstderr:\n%s\nexit=%s\n' "$(cat "$OUT")" "$(cat "$ERR")" "$code"
fi

# 5. F2 fail-closed: internal error in a PreToolUse blocker must deny.
OUT="$TMPDIR/fail-closed.out"; ERR="$TMPDIR/fail-closed.err"
if run_dispatcher blockSecretCommands \
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":12345},"cwd":"'"$ROOT"'"}' \
  "$OUT" "$ERR"; then
  code=0
else
  code=$?
fi
if [ "$code" -eq 2 ] \
  && assert_json_expr "$OUT" 'obj.hookSpecificOutput?.permissionDecision === "deny"' \
  && grep -q 'fail-closed' "$OUT"; then
  ok 'PreToolUse deny hook fails closed on handler error'
else
  not_ok 'PreToolUse deny hook should fail closed on handler error'
  printf 'stdout:\n%s\nstderr:\n%s\nexit=%s\n' "$(cat "$OUT")" "$(cat "$ERR")" "$code"
fi

printf '\nPassed: %s  Failed: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
