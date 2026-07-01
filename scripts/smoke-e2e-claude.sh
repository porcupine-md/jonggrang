#!/usr/bin/env bash
# Smoke test: end-to-end plan→approve→decompose with a REAL agent.
#
# ⚠️  This is NOT a CI test. It requires a configured AI agent (claude by default),
#     costs tokens, takes minutes, and its task *content* is non-deterministic.
#     Only the STRUCTURAL CONTRACT is asserted (file locations, feature_id stamping,
#     MANIFEST phase progression) — not the agent's specific output.
#
# Run by hand before opening a PR / after touching the plan→approve→decompose chain:
#   bash scripts/smoke-e2e-claude.sh            # default: --tool claude
#   TOOL=opencode bash scripts/smoke-e2e-claude.sh
#   TIMEOUT=900 bash scripts/smoke-e2e-claude.sh  # extend if the agent is slow
#
# Prereqs:
#   - the agent CLI (`claude` / `opencode` / etc.) installed and authenticated
#   - the global `jonggrang` resolves to THIS branch (or REPO points at it)
#
# What it checks (Option B + per-feature task state, end-to-end):
#   1. `jonggrang plan "..." --yes` runs an agent that writes a draft, then
#      auto-approves → decomposes into tasks via `task import --feature`.
#   2. After completion:
#        - no root .jonggrang/plan.md         (draft was per-session, moved on approve)
#        - no root .jonggrang/jonggrang-tasks.json   (per-feature)
#        - .drafts/ is empty                  (draft session discarded after move)
#        - exactly one feature folder, containing plan.md + MANIFEST.yaml + jonggrang-tasks.json
#        - tasks have feature_id stamped == the feature folder
#        - MANIFEST: status running, phases 1-7 completed (source=approve), current_phase 8
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
JG="node \"$REPO/bin/jonggrang.js\""

if [ ! -f "$REPO/bin/jonggrang.js" ]; then
  echo "Error: $REPO/bin/jonggrang.js not found. Set REPO=<path-to-jonggrang>." >&2
  exit 2
fi

TOOL="${TOOL:-claude}"
TIMEOUT="${TIMEOUT:-900}"   # 15 min default — two agent runs (plan + decompose)
PASS=0; FAIL=0
G=$'\033[32m'; R=$'\033[31m'; B=$'\033[1m'; Y=$'\033[33m'; N=$'\033[0m'

assert() { local d="$1"; shift; if eval "$@" >/dev/null 2>&1; then
  echo "  ${G}✓${N} $d"; PASS=$((PASS+1)); else echo "  ${R}✗${N} $d"; FAIL=$((FAIL+1)); fi; }

cleanup() { [ -n "${FIX:-}" ] && rm -rf "$FIX" 2>/dev/null; }
trap cleanup EXIT

FIX=$(mktemp -d /tmp/jg-smoke.XXXXXX)
cd "$FIX"

echo "${B}════════════════════════════════════════════════════════════${N}"
echo "${B} SMOKE: end-to-end plan→approve→decompose (agent: $TOOL)${N}"
echo "${B}════════════════════════════════════════════════════════════${N}"
echo "${Y}⚠  agent-required, ~minutes, costs tokens — NOT a CI test${N}"
echo "workdir: $FIX"
echo ""

# ── Setup ───────────────────────────────────────────────────
echo "${B}── init (tool=$TOOL) ──${N}"
eval "$JG init --name smoke --tool $TOOL --autonomy autonomous" >/dev/null 2>&1
assert "init succeeded" '[ -f .jonggrang/jonggrang.json ]'
assert "tool config = $TOOL" "[ \"\$(node -e \"console.log(require('./.jonggrang/jonggrang.json').tool)\")\" = '$TOOL' ]"

# ── The real run ────────────────────────────────────────────
echo ""
echo "${B}── plan + auto-approve (--yes) — running agent, this takes minutes ──${N}"
DESC="add a GET /health endpoint returning {ok:true} JSON, no auth, minimal deps"
if ! timeout "$TIMEOUT" sh -c "$JG plan \"$DESC\" --yes" >/tmp/jg-smoke.log 2>&1; then
  echo "${R}✗ agent run failed/exceeded ${TIMEOUT}s. Tail of log:${N}"
  tail -25 /tmp/jg-smoke.log
  exit 1
fi
echo "${G}agent run completed.${N} (tail of output:)"
tail -4 /tmp/jg-smoke.log
echo ""

# ── Structural contract assertions ──────────────────────────
echo "${B}── structural assertions ──${N}"

# Root stays clean
assert "no root plan.md"                         '! [ -f .jonggrang/plan.md ]'
assert "no root jonggrang-tasks.json"            '! [ -f .jonggrang/jonggrang-tasks.json ]'
assert "no root progress.txt"                    '! [ -f .jonggrang/progress.txt ]'

# Draft session discarded after the move
assert ".drafts/ is empty (draft moved on approve)" \
  '[ "$(find .jonggrang/.drafts -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d "[:space:]")" = "0" ]'

# Exactly one feature folder
FEAT_COUNT=$(find .jonggrang/.output/features -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d '[:space:]')
assert "exactly one feature folder"              '[ "'"$FEAT_COUNT"'" = "1" ]'

if [ "$FEAT_COUNT" = "1" ]; then
  FID=$(ls .jonggrang/.output/features/)
  FF=".jonggrang/.output/features/$FID"
  echo "  feature: ${Y}$FID${N}"

  assert "feature folder has plan.md"            '[ -f "'"$FF"'/plan.md" ]'
  assert "feature folder has MANIFEST.yaml"      '[ -f "'"$FF"'/MANIFEST.yaml" ]'
  assert "feature folder has jonggrang-tasks.json" '[ -f "'"$FF"'/jonggrang-tasks.json" ]'

  # Tasks: count > 0, every task's feature_id == folder name (global ID uniqueness
  # is exercised in acceptance-isolated-state.sh; here we confirm the agent's
  # `task import --feature` actually wrote to the right place and stamped it).
  assert "tasks: count > 0" \
    'node -e "const d=require(\"./'"$FF"'/jonggrang-tasks.json\");process.exit(d.tasks.length>0?0:1)"'
  assert "tasks: every task.feature_id == folder" \
    'node -e "const d=require(\"./'"$FF"'/jonggrang-tasks.json\");process.exit(d.tasks.every(t=>t.feature_id===\"'"$FID"'\")?0:1)"'
  assert "tasks: IDs are task-NNN (global scheme)" \
    'node -e "const d=require(\"./'"$FF"'/jonggrang-tasks.json\");process.exit(d.tasks.every(t=>/^task-\d+$/.test(t.id))?0:1)"'

  # MANIFEST: approve completed planning phases, phase 8 is now running
  assert "MANIFEST: status running" \
    'node -e "const m=require(\"'"$REPO"'/node_modules/js-yaml\").load(require(\"fs\").readFileSync(\"'"$FF"'/MANIFEST.yaml\",\"utf8\"));process.exit(m.status===\"running\"?0:1)"'
  assert "MANIFEST: feature_id stamped" \
    'node -e "const m=require(\"'"$REPO"'/node_modules/js-yaml\").load(require(\"fs\").readFileSync(\"'"$FF"'/MANIFEST.yaml\",\"utf8\"));process.exit(m.feature_id===\"'"$FID"'\"?0:1)"'
  assert "MANIFEST: phases 1-7 completed (source=approve)" \
    'node -e "const m=require(\"'"$REPO"'/node_modules/js-yaml\").load(require(\"fs\").readFileSync(\"'"$FF"'/MANIFEST.yaml\",\"utf8\"));process.exit([1,2,3,4,5,6,7].every(n=>m.phases[n]&&m.phases[n].status===\"completed\")?0:1)"'
  assert "MANIFEST: current_phase 8 (Implement, ready for 'jonggrang work')" \
    'node -e "const m=require(\"'"$REPO"'/node_modules/js-yaml\").load(require(\"fs\").readFileSync(\"'"$FF"'/MANIFEST.yaml\",\"utf8\"));process.exit(m.current_phase===8?0:1)"'

  # status command surfaces the feature
  assert "status lists the feature"              'eval "$JG status" 2>/dev/null | grep -q "'"$FID"'"'
else
  echo "${R}no feature folder — skipping feature-scoped assertions${N}"
fi

# ── Result ──────────────────────────────────────────────────
echo ""
echo "${B}──────────────────────────────────${N}"
echo "  ${G}Passed: $PASS${N}   ${R}Failed: $FAIL${N}"
echo "${B}──────────────────────────────────${N}"
[ "$FAIL" -eq 0 ] && echo "${G}SMOKE GREEN${N} — the plan→approve→decompose chain works end-to-end with agent '$TOOL'." || echo "${R}SMOKE RED${N}"
exit $FAIL
