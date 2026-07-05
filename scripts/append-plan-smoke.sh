#!/usr/bin/env bash
# Deterministic lib-layer smoke test for per-plan task numbering + resolver (PR #75).
# No agent backend needed — exercises lib/jonggrang.js directly.
#
# Usage:
#   bash scripts/append-plan-smoke.sh
#
# What it verifies (design §10 invariants + §11 acceptance checklist):
#   1. New feature A numbers tasks task-001, task-002
#   2. New feature B resets to task-001, task-002
#   3. Append into A continues at task-003, task-004
#   4. Collision within a feature is rejected (not silently overwritten)
#   5. Bare ambiguous id (task-001 in A and B) throws AMBIGUOUS_TASK_ID
#   6. --feature scope disambiguates an ambiguous id
#   7. Legacy single global match still resolves (backward compat)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# lib loads config from .jonggrang/jonggrang.json; create a minimal one so
# require() doesn't blow up on missing config. addTask writes into
# .output/features/<id>/ so pre-create the per-feature dirs it touches.
mkdir -p "$TMP/.jonggrang/.output/features/feat-a"
mkdir -p "$TMP/.jonggrang/.output/features/feat-b"
mkdir -p "$TMP/.jonggrang/.output/features/feat-c"
cat > "$TMP/.jonggrang/jonggrang.json" <<'JSON'
{ "tool": "opencode", "mode": { "autonomy": "balanced" } }
JSON

cd "$REPO_ROOT"

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
run()  { node -e "$1" -- "$TMP"; }

echo "Append-plan lib tests (project root: $TMP)"
echo "==========================================="

# --- 1 & 2: per-feature numbering ------------------------------------------
echo
echo "[1] New feature A → task-001, task-002"
A=$(run "
const root=process.argv[1]; const lib=require('./lib/jonggrang.js');
lib.addTask(root,'feat-a',{title:'A1'}); lib.addTask(root,'feat-a',{title:'A2'});
const t=lib.getTasks(lib.tasksFileFor(root,'feat-a')).tasks.map(x=>x.id).join(',');
process.stdout.write(t);
")
[ "$A" = "task-001,task-002" ] && ok "A = $A" || bad "expected task-001,task-002, got $A"

echo "[2] New feature B resets → task-001, task-002"
B=$(run "
const root=process.argv[1]; const lib=require('./lib/jonggrang.js');
lib.addTask(root,'feat-b',{title:'B1'}); lib.addTask(root,'feat-b',{title:'B2'});
const t=lib.getTasks(lib.tasksFileFor(root,'feat-b')).tasks.map(x=>x.id).join(',');
process.stdout.write(t);
")
[ "$B" = "task-001,task-002" ] && ok "B = $B" || bad "expected task-001,task-002, got $B"

# --- 3: append continues ----------------------------------------------------
echo "[3] Append into A continues → task-003, task-004"
AP=$(run "
const root=process.argv[1]; const lib=require('./lib/jonggrang.js');
lib.addTask(root,'feat-a',{title:'A3'}); lib.addTask(root,'feat-a',{title:'A4'});
const t=lib.getTasks(lib.tasksFileFor(root,'feat-a')).tasks.map(x=>x.id).join(',');
process.stdout.write(t);
")
[ "$AP" = "task-001,task-002,task-003,task-004" ] && ok "A after append = $AP" || bad "expected ...003,004, got $AP"

# --- 4: collision within feature rejected ----------------------------------
echo "[4] Duplicate id within a feature is rejected"
COLL=$(run "
const root=process.argv[1]; const lib=require('./lib/jonggrang.js');
try { lib.addTask(root,'feat-a',{id:'task-001',title:'dup'}); process.stdout.write('NO_THROW'); }
catch(e){ process.stdout.write(e.message); }
")
case "$COLL" in
  *already\ exists*) ok "rejected: $COLL" ;;
  NO_THROW)          bad "addTask with duplicate id did NOT throw" ;;
  *)                 bad "unexpected: $COLL" ;;
esac

# --- 5: ambiguous bare id throws AMBIGUOUS_TASK_ID -------------------------
echo "[5] Ambiguous task-001 (in A and B) → AMBIGUOUS_TASK_ID"
AMB=$(run "
const root=process.argv[1]; const lib=require('./lib/jonggrang.js');
try { lib.findTaskFeature(root,'task-001',{throwOnAmbiguous:true}); process.stdout.write('NO_THROW'); }
catch(e){ process.stdout.write(e.code||e.message); }
")
case "$AMB" in
  AMBIGUOUS_TASK_ID) ok "threw AMBIGUOUS_TASK_ID" ;;
  NO_THROW)          bad "ambiguous id did NOT throw" ;;
  *)                 bad "unexpected: $AMB" ;;
esac

# --- 6: --feature disambiguates --------------------------------------------
echo "[6] --feature feat-b disambiguates task-001 → feat-b"
DIS=$(run "
const root=process.argv[1]; const lib=require('./lib/jonggrang.js');
const fid=lib.findTaskFeature(root,'task-001',{featureId:'feat-b',throwOnAmbiguous:true});
process.stdout.write(fid||'null');
")
[ "$DIS" = "feat-b" ] && ok "resolved → $DIS" || bad "expected feat-b, got $DIS"

# --- 7: legacy single global match still resolves --------------------------
echo "[7] Legacy single-match id resolves (backward compat)"
LEG=$(run "
const root=process.argv[1]; const lib=require('./lib/jonggrang.js');
// feat-c has a globally-unique id task-099
lib.addTask(root,'feat-c',{id:'task-099',title:'legacy'});
const fid=lib.findTaskFeature(root,'task-099');  // no opts — old behavior
process.stdout.write(fid||'null');
")
[ "$LEG" = "feat-c" ] && ok "legacy → $LEG" || bad "expected feat-c, got $LEG"

# --- summary ---------------------------------------------------------------
echo
echo "==========================================="
echo "  pass: $PASS   fail: $FAIL"
echo "==========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
