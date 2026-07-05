#!/usr/bin/env bash
# QA script for the repo-tracked memory layer (#79, PR #80).
#
# Two tiers:
#   AUTO   — deterministic, CI-safe (no agent needed). Verifies:
#            - lib/memory.js loads + syntax
#            - policy prompt injected in all 6 builders
#            - fragment add / recall / read work on the CLI (no LLM)
#            - canonical MEMORY.md NOT touched by fragment add
#            - .output/ is tracked, .ephemeral/ is ignored
#   MANUAL — needs a configured agent backend for compact/promote (LLM path).
#            Prints the exact commands to run; does not execute them.
#
# Usage:
#   bash scripts/qa-memory.sh           # AUTO tier only
#   bash scripts/qa-memory.sh --manual  # also print manual steps

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
JG="node $REPO/bin/jonggrang.js"
PASS=0; FAIL=0
B="\\033[1m"; G="\\033[32m"; R="\\033[31m"; N="\\033[0m"

assert() { local d="$1"; shift; if eval "$@" >/dev/null 2>&1; then
  printf "  ${G}✓${N} %s\n" "$d"; PASS=$((PASS+1))
else
  printf "  ${R}✗${N} %s\n" "$d"; FAIL=$((FAIL+1)); fi
}
section() { printf "\n${B}=== %s ===${N}\n" "$1"; }

# ── AUTO TIER ──────────────────────────────────────────────────

section "A1: lib/memory.js loads + syntax"
node -c "$REPO/lib/memory.js"; assert "lib/memory.js syntax OK" "true"
node -e "require('$REPO/lib/memory.js')"; assert "lib/memory.js requires OK" "true"

section "A2: policy prompt injected in all 6 builders"
node -e '
const lib = require("'$REPO'/lib/jonggrang.js");
const fs = require("fs"), os = require("os");
const tmp = fs.mkdtempSync(os.tmpdir()+"/qa2-");
fs.mkdirSync(tmp+"/.jonggrang/.output/features/feat-x",{recursive:true});
fs.writeFileSync(tmp+"/.jonggrang/.output/features/feat-x/jonggrang-tasks.json",
  JSON.stringify({tasks:[{id:"task-001",title:"t",feature_id:"feat-x"}]}));
const draftPath = os.tmpdir()+"/plan.md";
const prompts = [
  ["draft",   lib.buildDraftPlanPrompt("feat", null, tmp, draftPath)],
  ["append",  lib.buildAppendPlanPrompt("more", "# p", [], null, tmp, draftPath, "feat-x")],
  ["revise",  lib.buildRevisePlanPrompt("# p", "fix", draftPath)],
  ["tasks",   lib.buildTasksFromPlanPrompt("# p", null, tmp, "feat-x", null)],
  ["work",    lib.buildWorkPrompt("task-001", tmp+"/.jonggrang/.output/features/feat-x/jonggrang-tasks.json", "execute")],
  ["review",  lib.buildReviewPrompt()],
];
let ok = true;
for (const [n,p] of prompts) {
  const pass = p.includes("## Jonggrang Memory Policy") && p.includes("jonggrang memory recall");
  if (!pass) ok = false;
  process.stdout.write((pass?"  ✓ ":"  ✗ ")+n+"\n");
}
process.exit(ok?0:1);
'; assert "all 6 builders inject policy + recall cmd" "[ $? -eq 0 ]"

section "A3: CLI — fragment add / recall / read (no agent)"
T=$(mktemp -d); cd "$T"; git init -q; git commit -q --allow-empty -m init
mkdir -p .jonggrang/.output/features/feat-billing
# Copy real .gitignore so git-tracking assertions are accurate
printf '.jonggrang/.ephemeral/\n.jonggrang/codemap/\n' > .gitignore
echo '{"name":"t","project":{"stack":"node"}}' > .jonggrang/jonggrang.json
echo '{"tasks":[{"id":"task-001","title":"idempotency","status":"completed","feature_id":"feat-billing"}]}' \
  > .jonggrang/.output/features/feat-billing/jonggrang-tasks.json

printf '## What Done\n- Added idempotency key\n## Lessons\n- Financial jobs need idempotency at boundary\n' > /tmp/qa-frag.md
$JG memory fragment add --feature feat-billing --task task-001 --file /tmp/qa-frag.md >/dev/null 2>&1
assert "fragment add exits 0"                            "[ $? -eq 0 ]"
assert "fragment staged under .ephemeral/"               "find .jonggrang/.ephemeral/memory/fragments/feat-billing -name '*.md' | grep -q ."
assert "canonical feature MEMORY.md NOT created"         "! [ -f .jonggrang/.output/features/feat-billing/MEMORY.md ]"

$JG memory read >/dev/null 2>&1
assert "memory read exits 0 (empty project)"             "[ $? -eq 0 ]"
$JG memory read 2>&1 | grep -q "Jonggrang Project Memory"
assert "memory read shows project header"                "[ $? -eq 0 ]"

$JG memory recall --phase work --feature feat-billing --query "idempotency" >/dev/null 2>&1
assert "memory recall exits 0 (empty memory)"            "[ $? -eq 0 ]"
$JG memory recall --phase work --query "x" 2>&1 | grep -q "0 snippet"
assert "recall empty-safe (0 snippets)"                  "[ $? -eq 0 ]"

$JG memory read --feature feat-billing >/dev/null 2>&1
assert "read --feature (no memory) exits 1"              "[ $? -eq 1 ]"

section "A4: git tracking — .output tracked, .ephemeral ignored"
touch .jonggrang/.output/features/feat-billing/MEMORY.md
git check-ignore -q .jonggrang/.output/features/feat-billing/MEMORY.md 2>/dev/null
assert "feature MEMORY.md NOT ignored (tracked)"         "[ $? -ne 0 ]"
git check-ignore -q .jonggrang/.ephemeral/memory/fragments/feat-billing/x.md 2>/dev/null
assert "fragment path IS ignored"                        "[ $? -eq 0 ]"

cd "$REPO"; rm -rf "$T"

section "A5: jong-code unit tests (7/7)"
node --test "$REPO/test/memory.test.js" 2>&1 | grep -q "^# pass 7"
assert "test/memory.test.js 7/7 pass"                    "[ $? -eq 0 ]"

# ── SUMMARY ───────────────────────────────────────────────────
echo ""
printf "${B}── AUTO QA: %s passed, %s failed ──${N}\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && printf "${G}AUTO TIER GREEN${N}\n" || printf "${R}FAILURES PRESENT${N}\n"

# ── MANUAL TIER (print only) ───────────────────────────────────
if [ "${1:-}" = "--manual" ]; then
  cat <<'MANUAL'

════════════════════════════════════════════════════════════════
MANUAL TIER — needs a configured agent backend for compact/promote
════════════════════════════════════════════════════════════════

These exercise the LLM path (compact/promote via runAgent). They are NOT
automated because they depend on a real agent + API key. Run them by hand
in a scratch repo:

  # 1. Setup scratch repo
  T=$(mktemp -d) && cd "$T" && git init -q && git commit -q --allow-empty -m init
  mkdir -p .jonggrang/.output/features/feat-x
  echo '{"name":"t","project":{"stack":"node"},"tool":"claude"}' > .jonggrang/jonggrang.json
  echo '{"tasks":[{"id":"task-001","title":"add idempotency","status":"completed","feature_id":"feat-x"}]}' \
    > .jonggrang/.output/features/feat-x/jonggrang-tasks.json

  # 2. Stage a fragment (no agent needed)
  printf '## What Done\n- Added job-level idempotency key\n## Why\nRetries duplicated invoices\n## Lessons\n- Financial jobs need idempotency at job boundary\n' > /tmp/frag.md
  node /PATH/TO/jonggrang/bin/jonggrang.js memory fragment add --feature feat-x --task task-001 --file /tmp/frag.md

  # 3. COMPACT (LLM) — merges fragment → feature MEMORY.md
  node /PATH/TO/jonggrang/bin/jonggrang.js memory compact --feature feat-x
  # Expect: "Feature memory updated: .jonggrang/.output/features/feat-x/MEMORY.md"
  #         "Archived 1 fragment(s)"
  cat .jonggrang/.output/features/feat-x/MEMORY.md   # should have frontmatter + sections
  find .jonggrang/.ephemeral/memory/archive -name '*.md'  # fragment moved here

  # 4. Read feature memory
  node /PATH/TO/jonggrang/bin/jonggrang.js memory read --feature feat-x

  # 5. Recall (now non-empty — should return snippets)
  node /PATH/TO/jonggrang/bin/jonggrang.js memory recall --phase work --feature feat-x --query "idempotency"

  # 6. PROMOTE (LLM) — distills feature → project MEMORY.md
  node /PATH/TO/jonggrang/bin/jonggrang.js memory promote --feature feat-x
  # Expect: "Project memory updated: .jonggrang/MEMORY.md"
  cat .jonggrang/MEMORY.md   # should have distilled lesson

  # 7. Read project + feature index
  node /PATH/TO/jonggrang/bin/jonggrang.js memory read

  # 8. Verify policy injection in a REAL plan run
  node /PATH/TO/jonggrang/bin/jonggrang.js plan "test feature" --yes 2>&1 | grep "Jonggrang Memory Policy"
  # Should print the policy block (proves it reached the agent)

MANUAL
fi

exit $FAIL
