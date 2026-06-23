#!/usr/bin/env bash
# Acceptance test for per-feature task & progress state + per-session plan drafts (#64).
#
# Deterministic — no AI agent. Simulates the agent by writing files to the paths
# the prompts would tell the agent to write, then exercises the REAL CLI code paths
# (resolvers, migration, task CRUD, concurrency, flags). One fresh repo per
# scenario to avoid cross-scenario state bleed (global task IDs make shared state
# fragile).
#
# Usage:
#   bash scripts/acceptance-per-feature.sh
#
# REPO is derived from this script's location (scripts/ → repo root), so it runs
# from anywhere. Invoking the installed `jonggrang` binary also works if REPO is
# overridden via env: REPO=/path/to/jonggrang bash scripts/acceptance-per-feature.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
JG="node \"$REPO/bin/jonggrang.js\""

if [ ! -f "$REPO/bin/jonggrang.js" ]; then
  echo "Error: $REPO/bin/jonggrang.js not found. Set REPO=<path-to-jonggrang> or run from inside the repo." >&2
  exit 2
fi

PASS=0; FAIL=0
ROOT_FIX=""

G=$'\033[32m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'

assert() { # assert <description> <condition-cmd>
  local desc="$1"; shift
  if eval "$@" >/dev/null 2>&1; then
    echo "  ${G}✓${N} $desc"; PASS=$((PASS+1))
  else
    echo "  ${R}✗${N} $desc"; FAIL=$((FAIL+1))
  fi
}

# count dir entries (macOS-wc-safe)
dircount() { find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d '[:space:]'; }

section() { echo ""; echo "${B}=== $1 ===${N}"; }

# Fresh repo per scenario. Returns its path on stdout.
newrepo() {
  local d; d=$(mktemp -d /tmp/jg-acc.XXXXXX)
  ( cd "$d" && eval "$JG init --name acc --tool opencode --autonomy autonomous" >/dev/null 2>&1 )
  echo "$d"
}

cleanup() { [ -n "$ROOT_FIX" ] && rm -rf /tmp/jg-acc.* /tmp/jg-accept.* 2>/dev/null; }
trap cleanup EXIT

# ─── Scenario 1: Fresh init produces NO root state files ───
section "S1: Fresh init → no root state files"
ROOT_FIX=$(newrepo); cd "$ROOT_FIX"
assert "init succeeded (config exists)"      '[ -f .jonggrang/jonggrang.json ]'
assert "no root jonggrang-tasks.json"        '! [ -f .jonggrang/jonggrang-tasks.json ]'
assert "no root plan.md"                     '! [ -f .jonggrang/plan.md ]'
assert "no root progress.txt"                '! [ -f .jonggrang/progress.txt ]'
assert ".gitignore excludes .drafts/"        'grep -q ".jonggrang/.drafts/" .gitignore'
assert ".gitignore excludes .ephemeral/"     'grep -q ".jonggrang/.ephemeral/" .gitignore'

# ─── Scenario 2: Legacy migration ───
section "S2: Migrate legacy root files → per-feature/per-session"
ROOT_FIX=$(newrepo); cd "$ROOT_FIX"
mkdir -p .jonggrang/.output/features/feat-old
cat > .jonggrang/jonggrang-tasks.json <<'JSON'
{"feature":"old","branch":"feat/old","tasks":[
  {"id":"task-001","feature_id":"feat-old","title":"old A","status":"completed","priority":1},
  {"id":"task-002","feature_id":"feat-other","title":"other A","status":"pending","priority":1},
  {"id":"task-003","feature_id":null,"title":"orphan","status":"pending","priority":3}
]}
JSON
echo "# legacy progress" > .jonggrang/progress.txt
cat > .jonggrang/plan.md <<'MD'
---
feature: legacy-plan
work_type: MEDIUM
---
# Legacy pending plan
MD
eval "$JG init --force --name acc --tool opencode --autonomy autonomous" 2>&1 | grep -i migrat
assert "root tasks.json deleted"                 '! [ -f .jonggrang/jonggrang-tasks.json ]'
assert "root plan.md deleted"                    '! [ -f .jonggrang/plan.md ]'
assert "root progress.txt deleted"               '! [ -f .jonggrang/progress.txt ]'
assert "feat-old folder has tasks"               '[ -f .jonggrang/.output/features/feat-old/jonggrang-tasks.json ]'
assert "feat-other folder created"               '[ -d .jonggrang/.output/features/feat-other ]'
assert "orphan → legacy-* folder"                'ls .jonggrang/.output/features/ | grep -q "^legacy-"'
assert "draft session created from legacy plan"  '[ "$(dircount .jonggrang/.drafts)" = "1" ]'
assert "status shows migrated tasks grouped"     'eval "$JG status" 2>/dev/null | grep -q "feat-old"'

# ─── Scenario 3: Per-feature task lifecycle (simulated approve) ───
section "S3: Per-feature task lifecycle"
ROOT_FIX=$(newrepo); cd "$ROOT_FIX"
# Simulate cmdApprove's pre-agent step: feature dir + MANIFEST (no agent needed)
FID=$(node -e "
const o=require('$REPO/lib/orchestration.js');const fs=require('fs');
const id=o.generateFeatureId('auth-system');
fs.mkdirSync('.jonggrang/.output/features/'+id,{recursive:true});
o.createManifest(process.cwd(),id,'auth-system','MEDIUM');
process.stdout.write(id);
")
assert "feature folder + MANIFEST created"       '[ -f .jonggrang/.output/features/'"$FID"'/MANIFEST.yaml ]'
# Simulate the decompose agent: task import --feature
eval "$JG task import --feature '$FID' --input '[
  {\"id\":\"task-001\",\"title\":\"set up schema\",\"priority\":1,\"blocked_by\":[]},
  {\"id\":\"task-002\",\"title\":\"login handler\",\"priority\":2,\"blocked_by\":[\"task-001\"]}
]' --pretty" >/dev/null 2>&1
assert "tasks landed in feature file"            '[ -f .jonggrang/.output/features/'"$FID"'/jonggrang-tasks.json ]'
assert "root tasks.json still absent"            '! [ -f .jonggrang/jonggrang-tasks.json ]'
assert "feature file has 2 tasks"                '[ "$(node -e "console.log(require(\"./.jonggrang/.output/features/'"$FID"'/jonggrang-tasks.json\").tasks.length)")" = "2" ]'
assert "task list shows 2 tasks (cross-feature)" 'eval "$JG task list --json" 2>/dev/null | node -e "console.log(JSON.parse(require(\"fs\").readFileSync(0)).length)" | grep -q "^2$"'
# Auto-lookup: task done WITHOUT --feature
eval "$JG task done task-001 --pretty" >/dev/null 2>&1
assert "task done task-001 → completed in feature file" \
  'node -e "const d=require(\"./.jonggrang/.output/features/'"$FID"'/jonggrang-tasks.json\");process.exit(d.tasks.find(t=>t.id===\"task-001\").status===\"completed\"?0:1)"'
assert "task next resolves to task-002"          'eval "$JG task next --json" 2>/dev/null | grep -q task-002'

# ─── Scenario 4: Global ID uniqueness across features ───
section "S4: Global task ID uniqueness"
ROOT_FIX=$(newrepo); cd "$ROOT_FIX"
# Feature A with task-001..003
FID_A=$(node -e "
const o=require('$REPO/lib/orchestration.js');const fs=require('fs');
const id=o.generateFeatureId('alpha');
fs.mkdirSync('.jonggrang/.output/features/'+id,{recursive:true});
o.createManifest(process.cwd(),id,'alpha','SMALL');
process.stdout.write(id);
")
eval "$JG task import --feature '$FID_A' --input '[
  {\"id\":\"task-001\",\"title\":\"a1\",\"priority\":1},
  {\"id\":\"task-002\",\"title\":\"a2\",\"priority\":2},
  {\"id\":\"task-003\",\"title\":\"a3\",\"priority\":3}
]' --pretty" >/dev/null 2>&1
# Feature B: a single add should continue global numbering → task-004
FID_B=$(node -e "
const o=require('$REPO/lib/orchestration.js');const fs=require('fs');
const id=o.generateFeatureId('beta');
fs.mkdirSync('.jonggrang/.output/features/'+id,{recursive:true});
o.createManifest(process.cwd(),id,'beta','SMALL');
process.stdout.write(id);
")
NEWID=$(eval "$JG task add --feature '$FID_B' --title b1 --json" 2>/dev/null | node -e "console.log(JSON.parse(require(\"fs\").readFileSync(0)).id)")
assert "task add continues global numbering (task-004)" '[ "'"$NEWID"'" = "task-004" ]'
# Collision: import task-001 into feature B → must fail
eval "$JG task import --feature '$FID_B' --input '[{\"id\":\"task-001\",\"title\":\"collide\"}]' --pretty" >/dev/null 2>&1; RC=$?
assert "cross-feature ID collision rejected (non-zero exit)" '[ '"$RC"' -ne 0 ]'

# ─── Scenario 5: Concurrent plan drafts (Option B) ───
section "S5: Concurrent plan drafts"
ROOT_FIX=$(newrepo); cd "$ROOT_FIX"
rm -rf .jonggrang/.drafts
SID_A=$(node -e "
const l=require('$REPO/lib/jonggrang.js');const fs=require('fs');
const s=l.generateDraftId('auth');
fs.mkdirSync(l.draftDirFor(process.cwd(),s),{recursive:true});
fs.writeFileSync(l.draftFileFor(process.cwd(),s),'---\nfeature: auth\ndescription: draft A\n---\n# A\n');
process.stdout.write(s);
")
sleep 0.05
SID_B=$(node -e "
const l=require('$REPO/lib/jonggrang.js');const fs=require('fs');
const s=l.generateDraftId('billing');
fs.mkdirSync(l.draftDirFor(process.cwd(),s),{recursive:true});
fs.writeFileSync(l.draftFileFor(process.cwd(),s),'---\nfeature: billing\ndescription: draft B\n---\n# B\n');
process.stdout.write(s);
")
assert "two drafts coexist"                       '[ "$(dircount .jonggrang/.drafts)" = "2" ]'
assert "no root plan.md"                          '! [ -f .jonggrang/plan.md ]'
ACTIVE=$(node -e "const l=require('$REPO/lib/jonggrang.js');console.log(l.resolveActiveDraft(process.cwd()))")
assert "resolveActiveDraft = most-recent (B)"     '[ "$ACTIVE" = "'"$SID_B"'" ]'
# Approve-move contract (cmdApprove needs an agent, so exercise the move directly)
node -e "
const l=require('$REPO/lib/jonggrang.js');const fs=require('fs');
const root=process.cwd();
const sid=l.resolveActiveDraft(root);
const draftFile=l.draftFileFor(root,sid);
const outDir=root+'/.jonggrang/.output/features/approved-xxx';
fs.mkdirSync(outDir,{recursive:true});
fs.copyFileSync(draftFile,outDir+'/plan.md');
fs.rmSync(l.draftDirFor(root,sid),{recursive:true,force:true});
"
assert "approved draft moved to features/"       '[ -f .jonggrang/.output/features/approved-xxx/plan.md ]'
assert "approved draft folder discarded"         '! [ -d .jonggrang/.drafts/'"$SID_B"' ]'
assert "other draft (A) still present"           '[ -d .jonggrang/.drafts/'"$SID_A"' ]'

# ─── Scenario 6: --session flag targets a specific (non-default) draft ───
section "S6: --session flag picks specific draft"
ROOT_FIX=$(newrepo); cd "$ROOT_FIX"
rm -rf .jonggrang/.drafts
SID_OLD=$(node -e "
const l=require('$REPO/lib/jonggrang.js');const fs=require('fs');
const s=l.generateDraftId('old-plan');
fs.mkdirSync(l.draftDirFor(process.cwd(),s),{recursive:true});
fs.writeFileSync(l.draftFileFor(process.cwd(),s),'---\nfeature: old\n---\n# old\n');
process.stdout.write(s);
")
sleep 0.05
SID_NEW=$(node -e "
const l=require('$REPO/lib/jonggrang.js');const fs=require('fs');
const s=l.generateDraftId('new-plan');
fs.mkdirSync(l.draftDirFor(process.cwd(),s),{recursive:true});
fs.writeFileSync(l.draftFileFor(process.cwd(),s),'---\nfeature: new\n---\n# new\n');
process.stdout.write(s);
")
# Default would pick NEW; --session OLD must target the older one.
assert "default resolveActiveDraft picks newer"  '[ "$(node -e "const l=require(\"$REPO/lib/jonggrang.js\");console.log(l.resolveActiveDraft(process.cwd()))")" = "'"$SID_NEW"'" ]'
assert "--session OLD target exists on disk"     'node -e "const l=require(\"$REPO/lib/jonggrang.js\");process.exit(l.fileExists(l.draftFileFor(process.cwd(),\"'"$SID_OLD"'\"))?0:1)"'
assert "--session NEW target exists on disk"     'node -e "const l=require(\"$REPO/lib/jonggrang.js\");process.exit(l.fileExists(l.draftFileFor(process.cwd(),\"'"$SID_NEW"'\"))?0:1)"'

# ─────────────────────────────────────────────────────────────
echo ""
echo "${B}──────────────────────────────────${N}"
echo "  ${G}Passed: $PASS${N}   ${R}Failed: $FAIL${N}"
echo "${B}──────────────────────────────────${N}"
[ "$FAIL" -eq 0 ] && echo "${G}ALL GREEN${N}" || echo "${R}FAILURES PRESENT${N}"
exit $FAIL
