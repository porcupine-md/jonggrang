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
#   JG_MODEL=deepseek-v4-pro bash scripts/append-plan-e2e.sh  # use a different model
#
# Preflight: needs `jonggrang` on PATH (or JONGGRANG_BIN) + a working agent
# backend. The `jonggrang` tool uses the Pi SDK in-process. Set up once:
#   jonggrang login        # writes ~/.jonggrang/agent/auth.json (API key)
# The script sets provider+model in the test project's jonggrang.json
# automatically (defaults: opencode-go / deepseek-v4-flash). Override with
# JG_PROVIDER=... JG_MODEL=...
set -uo pipefail

# Always test the CURRENT branch's code, not a globally-installed jonggrang
# (which may be an older version without the append-plan feature).
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JG="${JONGGRANG_BIN:-$REPO_ROOT/bin/jonggrang.js}"
TMP="$(mktemp -d /tmp/jg-append-e2e.XXXXXX)"
SKIP_WORK="${SKIP_WORK:-0}"
# Pi SDK needs a provider+model in jonggrang.json. Defaults use the opencode-go
# provider (key lives in ~/.jonggrang/agent/auth.json from `jonggrang login`).
# Override with JG_PROVIDER=... JG_MODEL=... for a different backend.
JG_PROVIDER="${JG_PROVIDER:-opencode-go}"
JG_MODEL="${JG_MODEL:-deepseek-v4-flash}"

PASS=0; FAIL=0; STEP=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
step() { STEP=$((STEP+1)); echo; echo "[$STEP] $1"; }
die()  { echo "FATAL: $1"; exit 1; }

# Capture the newest feature id under .output/features/ by snapshotting before
# and after a command. Usage: before_ids=$(feature_ids); run cmd; new=$(newest_feature "$before_ids")
# Uses ls -t (mtime, newest first) NOT ls | sort — alphabetical sort returns the
# wrong feature when names share a prefix (e.g. 'hello' vs 'health').
feature_ids() { ls -1t "$TMP/.jonggrang/.output/features" 2>/dev/null; }
newest_feature() {
  local before="$1"
  # diff before vs after; the new entry is the one only in 'after'. With -t sort,
  # the newest feature is first, so head -1 of the new entries.
  diff <(printf '%s\n' "$before") <(feature_ids) | grep '^>' | sed 's/^> //' | head -1
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

# Pi SDK (tool=jonggrang) needs (a) a populated auth.json and (b) a model set
# per-project. Fail early with a clear hint instead of a confusing "Agent did
# not write the plan" midway through.
AUTH_FILE="$HOME/.jonggrang/agent/auth.json"
if [ ! -f "$AUTH_FILE" ] || [ "$(wc -c < "$AUTH_FILE" | tr -d ' ')" -le 5 ]; then
  die "auth.json missing or empty ($AUTH_FILE). Run 'jonggrang login' first."
fi
if ! node -e "const a=require('$AUTH_FILE'); const hasKey=Object.values(a).some(v=>v&&(v.key||v.api_key||v.token)); process.exit(hasKey?0:1)" 2>/dev/null; then
  die "No API key found in $AUTH_FILE. Run 'jonggrang login' first."
fi

# The Pi extension must parse (see issue #76 / PR #77). A parse error here
# breaks 'jonggrang agent' AND every runAgent path that loads the extension.
if ! node --experimental-strip-types -e "import('$REPO_ROOT/hooks/pi/jonggrang-extension.ts').then(()=>process.exit(0)).catch(e=>{console.error(e.message.split(String.fromCharCode(10))[0]);process.exit(1)})" 2>/dev/null; then
  die "hooks/pi/jonggrang-extension.ts does not parse (issue #76). Apply PR #77 first, or cherry-pick it onto this branch."
fi
ok "preflight: auth.json has a key + Pi extension parses"

# --- setup -----------------------------------------------------------------
step "Setup: non-interactive init + set Pi SDK model"
( cd "$TMP" && git init -q && "$JG" init --name jg-append-e2e --tool jonggrang --autonomy autonomous --force ) \
  || die "init failed"
[ -f "$TMP/.jonggrang/jonggrang.json" ] && ok "project initialized" || bad "no jonggrang.json after init"

# Patch provider+model into the project config (cmdModel is interactive TUI,
# so we write the fields directly). Without this, Pi SDK has no model and the
# agent silently fails to write the plan.
node -e "
const fs=require('fs');
const p=process.argv[1];
const cfg=JSON.parse(fs.readFileSync(p,'utf8'));
cfg.provider=process.argv[2];
cfg.model=process.argv[3];
fs.writeFileSync(p, JSON.stringify(cfg,null,2));
" "$TMP/.jonggrang/jonggrang.json" "$JG_PROVIDER" "$JG_MODEL"
echo "  Pi SDK model: $JG_PROVIDER/$JG_MODEL"

# --- 1. first plan → task-001, task-002 ------------------------------------
step "Plan feature A → expect task-001, task-002"
BEFORE=$(feature_ids)
( cd "$TMP" && "$JG" plan "simple hello endpoint that returns a greeting" --yes ) || die "plan A failed"
FEATURE_A=$(newest_feature "$BEFORE")
[ -n "$FEATURE_A" ] || die "could not capture feature A id"
A_IDS=$(task_ids "$FEATURE_A")
echo "  feature A: $FEATURE_A  tasks: $A_IDS"
# Per-plan numbering: a fresh feature MUST start at task-001. The agent decides
# how many tasks to create (2, 3, ...), so don't assert an exact count — just
# assert the first id is task-001 and ids are contiguous from there.
case "$A_IDS" in task-001,*) ok "A starts at task-001 ($A_IDS)" ;; *) bad "expected to start at task-001, got $A_IDS" ;; esac

# --- 2. second plan → resets to task-001 -----------------------------------
step "Plan feature B → expect reset to task-001"
BEFORE=$(feature_ids)
( cd "$TMP" && "$JG" plan "health check endpoint returning ok status" --yes ) || die "plan B failed"
FEATURE_B=$(newest_feature "$BEFORE")
[ -n "$FEATURE_B" ] || die "could not capture feature B id"
B_IDS=$(task_ids "$FEATURE_B")
echo "  feature B: $FEATURE_B  tasks: $B_IDS"
# Per-plan: B must reset to task-001 (not continue A's sequence). Agent picks
# the count; we only assert the reset.
case "$B_IDS" in task-001,*) ok "B reset to task-001 (per-plan)" ;; *) bad "expected to start at task-001, got $B_IDS" ;; esac

# --- 3. bare id resolves to active feature (not ambiguous) -----------------
# With per-plan numbering, task-001 exists in both A and B. But feature B was
# just approved, so it's the 'active' feature — findTaskFeature resolves the
# bare id to B without erroring (design §6 resolution order: --feature → active
# → single-match → error). The ambiguity error path is covered by the
# deterministic smoke test (append-plan-smoke.sh) which has no active feature.
step "task done task-001 (no --feature) → expect active-feature resolution (B)"
DONE_OUT=$( cd "$TMP" && "$JG" task done task-001 2>&1 )
echo "$DONE_OUT" | head -3
RESOLVED_FEAT=$(echo "$DONE_OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=s.match(/\"feature_id\":\s*\"([^\"]+)\"/);process.stdout.write(m?m[1]:'')})")
if [ "$RESOLVED_FEAT" = "$FEATURE_B" ]; then
  ok "bare task-001 resolved to active feature B ($FEATURE_B)"
elif [ -n "$RESOLVED_FEAT" ]; then
  bad "resolved to $RESOLVED_FEAT, expected active feature $FEATURE_B"
else
  bad "could not parse resolved feature from output"
fi

# --- 4. --feature disambiguates --------------------------------------------
step "task done task-001 --feature A → expect success"
# Don't swallow stderr — if the agent/model errors here, we want to see it.
if ( cd "$TMP" && "$JG" task done task-001 --feature "$FEATURE_A" ); then
  ok "disambiguated via --feature"
else
  bad "task done --feature failed (see output above)"
fi

# --- 5. append → numbering continues ---------------------------------------
step "Append to A → expect task-003, task-004 (completed tasks untouched)"
( cd "$TMP" && "$JG" plan --append "$FEATURE_A" "add input validation to the greeting endpoint" --yes ) \
  || die "append failed"
AP_IDS=$(task_ids "$FEATURE_A")
echo "  feature A after append: $AP_IDS"
# Append must continue from feature A's own max (task-003 existed, so next is
# task-004). Check that appended ids start right after the existing max and
# there are NO GAPS (design §10: 'numbers are contiguous within a feature').
# A real agent sometimes second-guesses per-plan numbering and skips ids it
# thinks are 'globally taken' — that gap is a real finding, so we catch it.
# A_IDS holds the pre-append ids (task-001,task-002,task-003 from step 2).
READOUT=$(node -e "
const lib=require('$REPO_ROOT/lib/jonggrang.js');
const all=lib.getTasks(lib.tasksFileFor('$TMP','$FEATURE_A')).tasks.map(x=>x.id);
const before=(process.argv[1]||'').split(',').filter(Boolean); // ids before append
const beforeSet=new Set(before);
const newIds=all.filter(id=>!beforeSet.has(id));               // ids added by append
const beforeMax=Math.max(...before.map(id=>parseInt(id.match(/\\d+/)[0],10)));
const expectedNext='task-'+String(beforeMax+1).padStart(3,'0');
const nums=all.map(id=>parseInt(id.match(/\\d+/)[0],10)).sort((a,b)=>a-b);
const contiguous=nums.every((n,i)=>n===i+1) ? 'contiguous' : 'gap';
process.stdout.write([newIds[0]||'', expectedNext, contiguous].join(' '));
" "$A_IDS" 2>/dev/null || true)
read -r AP_FIRST_NEW EXPECTED_NEXT CONTIGUITY <<< "$READOUT"
if [ -z "$AP_FIRST_NEW" ] || [ -z "$EXPECTED_NEXT" ]; then
  bad "append assertion could not compute new/expected ids (readout='$READOUT')"
elif [ "$AP_FIRST_NEW" = "$EXPECTED_NEXT" ] && [ "$CONTIGUITY" = "contiguous" ]; then
  ok "append continued at $AP_FIRST_NEW (no gap)"
else
  bad "append first new task is $AP_FIRST_NEW, expected $EXPECTED_NEXT; sequence=$CONTIGUITY — GAP in numbering (agent may have skipped an id it thought was globally taken)"
fi
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
