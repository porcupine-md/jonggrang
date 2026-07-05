#!/usr/bin/env bash
# E2E smoke test for append-plan + per-plan numbering (PR #75).
#
# Unlike scripts/append-plan-smoke.sh (deterministic, no agent), this one runs
# the REAL agent flow end-to-end: plan → approve → ambiguous-id error → append →
# work. Slow (each plan/work step invokes an agent) but exercises the actual
# CLI paths the user hits.
#
# Usage:
#   bash scripts/append-plan-e2e.sh
#   JONGGRANG_BIN=./bin/jonggrang.js bash scripts/append-plan-e2e.sh
#   SKIP_WORK=1 bash scripts/append-plan-e2e.sh   # skip the heavy `work` step
#
# Preflight: needs `jonggrang` on PATH (or JONGGRANG_BIN) + a working agent
# backend (the `jonggrang` tool uses the Pi SDK in-process, no external dep).
set -uo pipefail

# Always test the CURRENT branch's code, not a globally-installed jonggrang
# (which may be an older version without the append-plan feature).
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JG="${JONGGRANG_BIN:-$REPO_ROOT/bin/jonggrang.js}"
TMP="$(mktemp -d /tmp/jg-append-e2e.XXXXXX)"
SKIP_WORK="${SKIP_WORK:-0}"

PASS=0; FAIL=0; STEP=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
step() { STEP=$((STEP+1)); echo; echo "[$STEP] $1"; }
die()  { echo "FATAL: $1"; exit 1; }

# Capture the newest feature id under .output/features/ by snapshotting before
# and after a command. Usage: before_ids=$(feature_ids); run cmd; new=$(newest_feature "$before_ids")
feature_ids() { ls -1 "$TMP/.jonggrang/.output/features" 2>/dev/null | sort; }
newest_feature() {
  local before="$1"
  diff <(printf '%s' "$before") <(feature_ids) | grep '^>' | sed 's/^> //' | tail -1
}
task_ids() { node -e "
const lib=require('$REPO_ROOT/lib/jonggrang.js');
const t=lib.getTasks(lib.tasksFileFor('$TMP','$1')).tasks.map(x=>x.id).join(',');
process.stdout.write(t);
" 2>/dev/null; }

echo "Append-plan E2E smoke test"
echo "  project : $TMP"
echo "  jonggrang: $JG"
echo "  skip work: $SKIP_WORK"
echo "============================================="

# --- preflight -------------------------------------------------------------
[ -x "$JG" ] || die "'$JG' not found or not executable. Set JONGGRANG_BIN=/path/to/jonggrang"
echo "  testing : $JG"
echo "  (override with JONGGRANG_BIN=...; skip the heavy work step with SKIP_WORK=1)"

# --- setup -----------------------------------------------------------------
step "Setup: non-interactive init"
( cd "$TMP" && git init -q && "$JG" init --name jg-append-e2e --tool jonggrang --autonomy autonomous --force ) \
  || die "init failed"
[ -f "$TMP/.jonggrang/jonggrang.json" ] && ok "project initialized" || bad "no jonggrang.json after init"

# --- 1. first plan → task-001, task-002 ------------------------------------
step "Plan feature A → expect task-001, task-002"
BEFORE=$(feature_ids)
( cd "$TMP" && "$JG" plan "simple hello endpoint that returns a greeting" --yes ) || die "plan A failed"
FEATURE_A=$(newest_feature "$BEFORE")
[ -n "$FEATURE_A" ] || die "could not capture feature A id"
A_IDS=$(task_ids "$FEATURE_A")
echo "  feature A: $FEATURE_A  tasks: $A_IDS"
case "$A_IDS" in task-001,task-002) ok "A numbered from 001" ;; *) bad "expected task-001,task-002, got $A_IDS" ;; esac

# --- 2. second plan → resets to task-001 -----------------------------------
step "Plan feature B → expect reset to task-001"
BEFORE=$(feature_ids)
( cd "$TMP" && "$JG" plan "health check endpoint returning ok status" --yes ) || die "plan B failed"
FEATURE_B=$(newest_feature "$BEFORE")
[ -n "$FEATURE_B" ] || die "could not capture feature B id"
B_IDS=$(task_ids "$FEATURE_B")
echo "  feature B: $FEATURE_B  tasks: $B_IDS"
case "$B_IDS" in task-001,task-002) ok "B reset to 001 (per-plan)" ;; *) bad "expected task-001,task-002, got $B_IDS" ;; esac

# --- 3. ambiguous bare id → AMBIGUOUS_TASK_ID ------------------------------
step "task done task-001 (no --feature) → expect AMBIGUOUS_TASK_ID"
( cd "$TMP" && "$JG" task done task-001 ) 2>&1 | tee /tmp/jg-e2e-ambiguous.log
if grep -q "AMBIGUOUS_TASK_ID\|exists in.*plans" /tmp/jg-e2e-ambiguous.log; then
  ok "ambiguous id rejected with a clear error"
else
  bad "ambiguous id did NOT error (check /tmp/jg-e2e-ambiguous.log)"
fi
rm -f /tmp/jg-e2e-ambiguous.log

# --- 4. --feature disambiguates --------------------------------------------
step "task done task-001 --feature A → expect success"
if ( cd "$TMP" && "$JG" task done task-001 --feature "$FEATURE_A" ) >/tmp/jg-e2e-done.log 2>&1; then
  ok "disambiguated via --feature"
else
  bad "task done --feature failed (check /tmp/jg-e2e-done.log)"
fi
rm -f /tmp/jg-e2e-done.log

# --- 5. append → numbering continues ---------------------------------------
step "Append to A → expect task-003, task-004 (completed tasks untouched)"
( cd "$TMP" && "$JG" plan --append "$FEATURE_A" "add input validation to the greeting endpoint" --yes ) \
  || die "append failed"
AP_IDS=$(task_ids "$FEATURE_A")
echo "  feature A after append: $AP_IDS"
case "$AP_IDS" in
  task-001,task-002,task-003,task-004) ok "append continued numbering (003, 004)" ;;
  *) bad "expected ...003,004, got $AP_IDS" ;;
esac
# completed task-001 must still be 'completed' (immutable)
A_T1_STATUS=$(node -e "
const lib=require('$REPO_ROOT/lib/jonggrang.js');
const t=lib.getTasks(lib.tasksFileFor('$TMP','$FEATURE_A')).tasks.find(x=>x.id==='task-001');
process.stdout.write(t?t.status:'missing');
" 2>/dev/null)
[ "$A_T1_STATUS" = "completed" ] && ok "task-001 still completed (immutable)" || bad "task-001 status=$A_T1_STATUS (should stay completed)"

# plan.md should have an Appended section (not overwritten)
if grep -q "## Appended" "$TMP/.jonggrang/.output/features/$FEATURE_A/plan.md" 2>/dev/null; then
  ok "plan.md has '## Appended' section"
else
  bad "plan.md missing '## Appended' section"
fi

# --- 6. work re-runs appended tasks (phase 8 reopened) ---------------------
if [ "$SKIP_WORK" = "1" ]; then
  echo
  echo "[6] (skipped — SKIP_WORK=1) work + phase-8 reopen check"
else
  step "work → expect phase 8 (Implement) reopened for appended tasks"
  ( cd "$TMP" && "$JG" work ) || echo "  (work exited non-zero — check output above)"
  PHASE8=$(node -e "
const fs=require('fs'),yaml=require('js-yaml');
const m=process.argv[1];
try{const d=fs.readFileSync(m,'utf8');const y=yaml.load(d);
 process.stdout.write((y.phases&&y.phases[8]?y.phases[8].status:'missing'));}catch(e){process.stdout.write('read-error');}
" "$TMP/.jonggrang/.output/features/$FEATURE_A/MANIFEST.yaml" 2>/dev/null)
  echo "  MANIFEST phase 8 status: $PHASE8"
  case "$PHASE8" in completed) bad "phase 8 still completed — appended tasks may not run" ;; *) ok "phase 8 not completed (reopened/resumed)" ;; esac
fi

# --- summary ---------------------------------------------------------------
echo
echo "============================================="
echo "  pass: $PASS   fail: $FAIL"
echo "  project kept at: $TMP  (rm -rf to clean up)"
echo "============================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
