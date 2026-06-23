#!/usr/bin/env bash
# Test the commit-convention hook (PreToolUse enforcement for #62).
#
# Mirrors scripts/acceptance-isolated-state.sh in style: deterministic, no
# agent needed, CI-safe. Each scenario invokes the hook via stdin JSON
# (same shape Claude Code passes) and asserts exit code + block reason.
#
# Scenarios:
#   T1: Non-commit command (`git status`)             → exit 0
#   T2: Human commit (no Co-authored-by trailer)      → exit 0 (skip)
#   T3: Agent commit with all 5 fields                → exit 0
#   T4: Agent commit missing Context/Why/Tradeoff     → exit 2 + reason lists missing
#   T5: Case-insensitive trailer (CO-AUTHORED-BY)     → exit 0
#   T6: `-F file` with full message                   → exit 0
#   T7: `-F file` missing fields                      → exit 2
#   T8: `--amend` against last commit (was valid)     → exit 0
#   T9: Multiple `-m` (subject + body)                 → exit 0
#  T10: Chained command (`cd X && git commit ...`)    → exit 2 when incomplete

set -uo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/hooks/claude/commit-convention.sh"
[ -x "$HOOK" ] || { echo "FATAL: hook not found or not executable: $HOOK"; exit 1; }

REPO=$(mktemp -d -t commit-hook-test.XXXXXXXX)
trap 'rm -rf "$REPO" /tmp/test-commit-msg-*.txt' EXIT
git -C "$REPO" init -q
git -C "$REPO" config user.email "test@test"
git -C "$REPO" config user.name "Test"
echo "init" > "$REPO/a.txt"
git -C "$REPO" add a.txt
git -C "$REPO" commit -q -m "init"

PASS=0
FAIL=0
G='\033[0;32m'; R='\033[0;31m'; B='\033[1;36m'; N='\033[0m'
section() { echo ""; echo -e "${B}=== $1 ===${N}"; }
check()    { if [ "$1" = "$2" ]; then echo -e "  ${G}✓${N} $3"; PASS=$((PASS+1)); else echo -e "  ${R}✗${N} $3 (expected $1, got $2)"; FAIL=$((FAIL+1)); fi; }

# Helper: invoke the hook with a command string and capture exit code + stdout.
# Args: $1 = command, sets globals $EXIT, $STDOUT.
run_hook() {
  local cmd="$1"
  local input
  input=$(jq -nc --arg c "$cmd" '{tool_input:{command:$c}}')
  STDOUT=$(printf '%s' "$input" | bash "$HOOK" 2>/dev/null)
  EXIT=$?
}

# ── T1: Non-commit command ────────────────────────────────────────────
section "T1: non-commit command (git status) → pass"
run_hook "git status"
check 0 "$EXIT" "git status does not trigger hook"

# ── T2: Human commit (no Co-authored-by trailer) ──────────────────────
section "T2: human commit (no trailer) → pass"
run_hook "git commit -m \"fix typo\""
check 0 "$EXIT" "human commit skips validation"

# ── T3: Agent commit with all 5 fields ───────────────────────────────
section "T3: agent commit, all 5 fields + trailer → pass"
run_hook "git commit -m \"refactor: simplify

Context: cleanup pass
What:    extracted helper
Why:     DRY
Tradeoff:none
Caveats: none

Co-authored-by: jonggrang <koko@jonggrang.dev>\""
check 0 "$EXIT" "complete agent commit passes"

# ── T4: Agent commit missing fields → BLOCK ──────────────────────────
section "T4: agent commit missing 4 fields → block"
run_hook "git commit -m \"refactor: bad

What: only this field

Co-authored-by: a <b>\""
check 2 "$EXIT" "exit code 2 on missing fields"
echo "$STDOUT" | grep -q '"decision": "block"' && { echo -e "  ${G}✓${N} decision=block emitted"; PASS=$((PASS+1)); } || { echo -e "  ${R}✗${N} decision=block missing"; FAIL=$((FAIL+1)); }
for field in "Context:" "Why:" "Tradeoff:" "Caveats:"; do
  echo "$STDOUT" | grep -q "$field" && { echo -e "  ${G}✓${N} reason mentions $field"; PASS=$((PASS+1)); } || { echo -e "  ${R}✗${N} reason missing $field"; FAIL=$((FAIL+1)); }
done

# ── T5: Case-insensitive trailer ──────────────────────────────────────
section "T5: lowercase trailer (co-authored-by) → pass"
run_hook "git commit -m \"fix: x

Context: y
What:    y
Why:     y
Tradeoff:none
Caveats: none

co-authored-by: a <b>\""
check 0 "$EXIT" "case-insensitive trailer accepted"

# ── T6: `-F file` with full message ──────────────────────────────────
section "T6: -F file with all fields → pass"
MSG6=/tmp/test-commit-msg-6.txt
cat > "$MSG6" <<'EOF'
docs: typo

Context: README quickstart
What:    fixed typo
Why:     spelling
Tradeoff:none
Caveats: none

Co-authored-by: jonggrang <koko@jonggrang.dev>
EOF
run_hook "git commit -F $MSG6"
check 0 "$EXIT" "-F file with full message passes"

# ── T7: `-F file` missing fields → BLOCK ─────────────────────────────
section "T7: -F file missing fields → block"
MSG7=/tmp/test-commit-msg-7.txt
cat > "$MSG7" <<'EOF'
chore: bad

Co-authored-by: a <b>
EOF
run_hook "git commit -F $MSG7"
check 2 "$EXIT" "-F file with missing fields blocks"

# ── T8: `--amend` reads last commit's message ────────────────────────
section "T8: --amend against last valid commit → pass"
# Last commit in $REPO is from T6 (valid). --amend without override reuses it.
run_hook "git commit --amend"
check 0 "$EXIT" "--amend validates against last commit's message"

# ── T9: Multiple `-m` (subject + body) ───────────────────────────────
section "T9: multiple -m (subject + body) → pass"
run_hook "git commit -m \"feat: new feature\" -m \"Context: new flow
What:    added the thing
Why:     user asked
Tradeoff:none
Caveats: none

Co-authored-by: a <b>\""
check 0 "$EXIT" "multiple -m args join into one message"

# ── T10: Chained command with commit ─────────────────────────────────
section "T10: chained 'cd X && git commit' incomplete → block"
run_hook "cd $REPO && git commit -m \"bad

Co-authored-by: a <b>\""
check 2 "$EXIT" "chained commit still triggers validation"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo -e "${B}──────────────────────────────────${N}"
echo -e "  ${G}Passed: $PASS${N}   ${R}Failed: $FAIL${N}"
echo -e "${B}──────────────────────────────────${N}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
