#!/usr/bin/env bash
# JONGGRANG — Codex native hooks runtime diagnostic (manual)
#
# This is a real `codex exec` probe. It verifies whether Codex itself dispatches
# hooks in non-interactive exec mode. It intentionally uses a safe SessionStart
# sentinel (touching a temp file), not an `env` command, so it does not leak
# secrets while checking the runtime dispatch path.
#
# Current expected result (2026-06-25): KNOWN GAP confirmed — Codex exec does
# not dispatch hooks even with --dangerously-bypass-hook-trust. See:
#   https://github.com/openai/codex/issues/25875
#   https://github.com/openai/codex/issues/26452
#
# Usage:
#   scripts/smoke-e2e-codex-hooks.sh
#   scripts/smoke-e2e-codex-hooks.sh --allow-known-gap   # exit 0 when gap is confirmed
#   scripts/smoke-e2e-codex-hooks.sh --model gpt-5.1 --timeout 90
#
# Do NOT add this to npm test. It needs Codex auth and costs API tokens.

set -euo pipefail

ALLOW_KNOWN_GAP=0
MODEL=""
TIMEOUT=60

while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-known-gap) ALLOW_KNOWN_GAP=1; shift ;;
    --model) MODEL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --help|-h)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! command -v codex >/dev/null 2>&1; then
  echo "skip: codex CLI not found on PATH" >&2
  exit 0
fi

if [ -z "${CODEX_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ] && ! codex login status >/dev/null 2>&1; then
  echo "skip: codex CLI is installed but not authenticated (no CODEX_API_KEY/OPENAI_API_KEY and codex login status failed)" >&2
  exit 0
fi

TESTDIR="$(mktemp -d)"
LOG="$TESTDIR/codex-exec.jsonl"
SENTINEL="$TESTDIR/SENTINEL_FIRED"
trap 'rm -rf "$TESTDIR"' EXIT

cd "$TESTDIR"
git init -q
git config user.email smoke@example.invalid
git config user.name smoke
mkdir -p .codex

cat > .codex/hooks.json <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "touch $SENTINEL",
            "timeout": 10,
            "statusMessage": "jonggrang smoke: SessionStart sentinel"
          }
        ]
      }
    ]
  }
}
EOF

args=(exec --json --sandbox workspace-write --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust)
if [ -n "$MODEL" ]; then args+=(--model "$MODEL"); fi
args+=("Reply with exactly: done")

printf '\033[1;36mCodex exec hook dispatch diagnostic\033[0m\n'
echo "codex: $(codex --version 2>/dev/null || echo unknown)"
echo "workdir: $TESTDIR"
echo "timeout: ${TIMEOUT}s"
echo "model: ${MODEL:-codex default}"
echo "prompt: harmless reply-only prompt"
echo "sentinel: $SENTINEL"
echo ""

set +e
timeout "$TIMEOUT" codex "${args[@]}" >"$LOG" 2>&1
CODE=$?
set -e

HOOKS_DISPATCHED=no
if [ -f "$SENTINEL" ]; then HOOKS_DISPATCHED=yes; fi

HOOK_LINES=$(grep -Eci 'hook|SessionStart|SENTINEL|trust' "$LOG" || true)
ERROR_LINES=$(grep -Eci 'error|failed|auth|login|unauthorized' "$LOG" || true)

echo "codex_exit: $CODE"
echo "hooks_dispatched: $HOOKS_DISPATCHED"
echo "hook_related_lines: $HOOK_LINES"
echo "error_related_lines: $ERROR_LINES"
echo "log: $LOG"
echo ""

if [ "$HOOKS_DISPATCHED" = yes ]; then
  echo "PASS: codex exec dispatched SessionStart hook. Native hook runtime path is active."
  exit 0
fi

if [ "$CODE" -eq 124 ]; then
  echo "FAIL: codex exec timed out before hook dispatch could be verified."
  exit 1
fi

if [ "$ERROR_LINES" -gt 0 ]; then
  echo "DIAGNOSTIC: codex reported auth/runtime errors. First relevant lines:"
  grep -Ei 'error|failed|auth|login|unauthorized' "$LOG" | head -10 || true
  echo ""
fi

echo "KNOWN GAP CONFIRMED: codex exec did not dispatch the SessionStart hook."
echo "This matches upstream reports openai/codex#25875 and #26452."
echo "Jonggrang native Codex hook installation is therefore not runtime enforcement under codex exec yet."

if [ "$ALLOW_KNOWN_GAP" -eq 1 ]; then
  exit 0
fi
exit 1
