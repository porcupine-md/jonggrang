#!/usr/bin/env bash
# Scenario-based QA for the repo-tracked memory layer (#79, PR #80).
#
# Design philosophy: each scenario PRINTS its output so you can inspect the
# memory lifecycle with your own eyes, not just see pass/fail. Each has a
# "What to look for" note. One file, self-documenting, runnable.
#
# Two modes:
#   bash scripts/qa-memory-scenarios.sh            # default: --no-agent (deterministic)
#   bash scripts/qa-memory-scenarios.sh --agent    # also runs compact/promote + agent policy
#   bash scripts/qa-memory-scenarios.sh --agent --tool codex   # pick backend
#
# Scenarios:
#   1. Empty repo — memory state before anything (no agent)
#   2. Fragment staging — canonical untouched (no agent)
#   3. Git tracking — .output tracked, .ephemeral ignored (no agent)
#   4. Policy injection — prompts contain policy + recall (no agent)
#   5. Read-only contract — read never mutates (no agent)
#   6. Error quality — invalid input → actionable errors (no agent)
#   7. Compact + promote lifecycle (--agent only, LLM)
#   8. True agent policy usage — real plan run calls recall (--agent only)
#
# Prereqs:
#   --no-agent: nothing (no API key, no agent CLI)
#   --agent:    a configured agent CLI (claude by default) + API key

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
JG="node $REPO/bin/jonggrang.js"

# ── args ──
MODE="no-agent"
TOOL="claude"
prev=""
for a in "$@"; do
  case "$a" in
    --agent)    MODE="agent" ;;
    --no-agent) MODE="no-agent" ;;
    --tool)     : ;;
    *)          [[ "$prev" == "--tool" ]] && TOOL="$a" ;;
  esac
  prev="$a"
done

PASS=0; FAIL=0
B="\\033[1m"; G="\\033[32m"; R="\\033[31m"; Y="\\033[33m"; C="\\033[36m"; N="\\033[0m"

section() { printf "\n${B}${C}════════════════════════════════════════════════════════════${N}\n${B}${C}  SCENARIO %s${N}\n${B}${C}  %s${N}\n${B}${C}════════════════════════════════════════════════════════════${N}\n" "$1" "$2"; }
step()     { printf "\n${B}── %s ──${N}\n" "$1"; }
show()     { printf "${Y}▶ %s${N}\n" "$1"; }
assert()   { local d="$1"; shift; if eval "$@" >/dev/null 2>&1; then
  printf "  ${G}✓ assert: %s${N}\n" "$d"; PASS=$((PASS+1))
else
  printf "  ${R}✗ assert: %s${N}\n" "$d"; FAIL=$((FAIL+1)); fi
}

newrepo() {
  local d=$(mktemp -d)
  ( cd "$d" && git init -q && git commit -q --allow-empty -m init )
  printf '.jonggrang/.ephemeral/\n.jonggrang/codemap/\n' > "$d/.gitignore"
  echo "$d"
}

setup_feature() {
  local repo="$1" fid="$2" tid="$3"
  mkdir -p "$repo/.jonggrang/.output/features/$fid"
  echo '{"name":"qa","project":{"stack":"node"}}' > "$repo/.jonggrang/jonggrang.json"
  echo "{\"tasks\":[{\"id\":\"$tid\",\"title\":\"test task\",\"status\":\"completed\",\"feature_id\":\"$fid\"}]}" \
    > "$repo/.jonggrang/.output/features/$fid/jonggrang-tasks.json"
}

# ════════════════════════════════════════════════════════════════
# SCENARIO 1: Empty repo — memory state before anything (no agent)
# ════════════════════════════════════════════════════════════════
section "1" "Empty repo — inspect memory state before any compaction"
T=$(newrepo); cd "$T"
show "Fresh repo. No MEMORY.md anywhere yet."

step "memory read (no flag) — project view + feature index"
$JG memory read
assert "exits 0"                                 "[ $? -eq 0 ]"
assert "no project MEMORY.md file exists yet"    "! [ -f .jonggrang/MEMORY.md ]"

step "memory recall — empty memory should be empty-safe"
$JG memory recall --query "anything"
assert "recall exits 0 (not crash on empty)"     "[ $? -eq 0 ]"

step "memory read --feature feat-x — missing feature, clean error"
$JG memory read --feature feat-x
assert "exits 1 (clean error, not crash)"        "[ $? -eq 1 ]"

printf "\n${Y}Look for:${N} read shows 'not initialized'. recall shows '0 snippets'.\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 2: Fragment staging — canonical untouched (no agent)
# ════════════════════════════════════════════════════════════════
section "2" "Task fragment — staging only, canonical memory untouched"
T=$(newrepo); cd "$T"
setup_feature "$T" "feat-billing" "task-001"

step "Create a fragment (what a task agent writes at completion)"
cat > /tmp/qa-frag.md << 'EOF'
## What Done
- Added job-level idempotency key to reconciliation job

## Why
Retries were duplicating invoices.

## Lessons / Promotion Candidates
- For financial/background jobs, require idempotency at job boundary
  BEFORE adding retry logic. Retries + no idempotency = silent duplicates.
EOF

step "memory fragment add — stage to ephemeral"
$JG memory fragment add --feature feat-billing --task task-001 --file /tmp/qa-frag.md
assert "fragment staged under .ephemeral/"           "find .jonggrang/.ephemeral/memory/fragments/feat-billing -name '*.md' | grep -q ."
assert "canonical feature MEMORY.md NOT created"     "! [ -f .jonggrang/.output/features/feat-billing/MEMORY.md ]"
assert "project MEMORY.md NOT created"               "! [ -f .jonggrang/MEMORY.md ]"

step "Inspect: fragment content preserved?"
FRAG=$(find .jonggrang/.ephemeral/memory/fragments/feat-billing -name '*.md' | head -1)
show "cat $FRAG"; cat "$FRAG"

printf "\n${Y}Look for:${N} fragment under .ephemeral/ (gitignored), NOT .output/. No MEMORY.md yet.\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 3: Git tracking — .output tracked, .ephemeral ignored (no agent)
# ════════════════════════════════════════════════════════════════
section "3" "Git tracking — feature MEMORY.md tracked, fragments ignored"
T=$(newrepo); cd "$T"
setup_feature "$T" "feat-billing" "task-001"

step "Simulate: create canonical feature MEMORY.md (as compact would)"
cat > .jonggrang/.output/features/feat-billing/MEMORY.md << 'EOF'
---
feature_id: feat-billing
feature_name: Billing Reconciliation
tags: [billing, api]
updated_at: 2026-07-05T10:00:00Z
---
## Lessons Learned
- Idempotency at job boundary required for retry safety.
EOF

step "Simulate: create a fragment (ephemeral staging)"
mkdir -p .jonggrang/.ephemeral/memory/fragments/feat-billing
echo "## What Done" > .jonggrang/.ephemeral/memory/fragments/feat-billing/task-001-x.md

step "git status — what would be committed?"
show "git status --short"; git status --short

git check-ignore -q .jonggrang/.output/features/feat-billing/MEMORY.md 2>/dev/null
assert "feature MEMORY.md is TRACKED (not ignored)"   "[ $? -ne 0 ]"
git check-ignore -q .jonggrang/.ephemeral/memory/fragments/feat-billing/task-001-x.md 2>/dev/null
assert "fragment is IGNORED (ephemeral)"              "[ $? -eq 0 ]"

printf "\n${Y}Look for:${N} MEMORY.md in git status. Fragment NOT in git status.\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 4: Policy injection — prompts contain policy + recall (no agent)
# ════════════════════════════════════════════════════════════════
section "4" "Policy injection — verify prompts contain memory policy + recall guide"
show "Proves the agent WILL see the policy. No agent needed — inspect prompt directly."

node -e '
const lib = require("'$REPO'/lib/jonggrang.js");
const fs = require("fs"), os = require("os");
const tmp = fs.mkdtempSync(os.tmpdir()+"/qa4-");
fs.mkdirSync(tmp+"/.jonggrang/.output/features/feat-x",{recursive:true});
fs.writeFileSync(tmp+"/.jonggrang/.output/features/feat-x/jonggrang-tasks.json",
  JSON.stringify({tasks:[{id:"task-001",title:"t",feature_id:"feat-x"}]}));
const draftPath = os.tmpdir()+"/plan.md";
const samples = [
  ["buildDraftPlanPrompt (plan phase)",  lib.buildDraftPlanPrompt("feat", null, tmp, draftPath)],
  ["buildWorkPrompt (work phase)",        lib.buildWorkPrompt("task-001", tmp+"/.jonggrang/.output/features/feat-x/jonggrang-tasks.json", "execute")],
  ["buildReviewPrompt (review phase)",    lib.buildReviewPrompt()],
];
let ok = true;
for (const [label, prompt] of samples) {
  console.log("\n── " + label + " ──");
  const m = prompt.match(/## Jonggrang Memory Policy[\s\S]*?(?=\n## |\n$|$)/);
  if (m) { console.log(m[0].trim()); }
  else { console.log("❌ NO MEMORY POLICY FOUND"); ok = false; }
}
fs.rmSync(tmp, {recursive:true, force:true});
process.exit(ok?0:1);
'; assert "all sampled builders inject policy + recall cmd" "[ $? -eq 0 ]"

printf "\n${Y}Look for:${N} each phase shows policy block + recall cmd.\n"
printf "${Y}Work phase should ALSO show fragment-add cmd (task completion).${N}\n"

# ════════════════════════════════════════════════════════════════
# SCENARIO 5: Read-only contract — read never mutates (no agent)
# ════════════════════════════════════════════════════════════════
section "5" "Read-only contract — memory read does NOT rewrite canonical files"
T=$(newrepo); cd "$T"
setup_feature "$T" "feat-billing" "task-001"

step "Create project + feature memory (as compact/promote would)"
cat > .jonggrang/MEMORY.md << 'EOF'
---
updated_at: 2026-07-05T10:00:00Z
scope: project
---
## Conventions
- Use idempotency keys for financial jobs
EOF
cat > .jonggrang/.output/features/feat-billing/MEMORY.md << 'EOF'
---
feature_id: feat-billing
updated_at: 2026-07-05T10:00:00Z
---
## Lessons Learned
- Idempotency at job boundary
EOF

step "Hash files BEFORE read"
H1=$(shasum .jonggrang/MEMORY.md | cut -d' ' -f1)
H2=$(shasum .jonggrang/.output/features/feat-billing/MEMORY.md | cut -d' ' -f1)
show "project hash: $H1"; show "feature hash: $H2"

step "memory read (renders project + index)"
$JG memory read
step "memory read --feature feat-billing"
$JG memory read --feature feat-billing

step "Hash files AFTER read — must be unchanged"
H1b=$(shasum .jonggrang/MEMORY.md | cut -d' ' -f1)
H2b=$(shasum .jonggrang/.output/features/feat-billing/MEMORY.md | cut -d' ' -f1)
show "project hash: $H1b"; show "feature hash: $H2b"
assert "project MEMORY.md hash unchanged (read-only)"  "[ '$H1' = '$H1b' ]"
assert "feature MEMORY.md hash unchanged (read-only)"  "[ '$H2' = '$H2b' ]"

printf "\n${Y}Look for:${N} hashes identical before/after. read renders, never mutates.\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 6: Error quality — invalid input → actionable errors (no agent)
# ════════════════════════════════════════════════════════════════
section "6" "Error quality — invalid input produces actionable errors (no agent)"
T=$(newrepo); cd "$T"
setup_feature "$T" "feat-x" "task-001"
show "Each error should tell you WHAT's wrong and HOW to fix it. Read the messages."

step "A1: fragment add — task doesn't exist"
$JG memory fragment add --feature feat-x --task task-999 --file /tmp/x.md 2>&1 | tail -1
$JG memory fragment add --feature feat-x --task task-999 --file /tmp/x.md >/dev/null 2>&1
assert "A1 exits 1"  "[ $? -ne 0 ]"

step "A2: fragment add — file doesn't exist"
$JG memory fragment add --feature feat-x --task task-001 --file /tmp/does-not-exist.md 2>&1 | tail -1
$JG memory fragment add --feature feat-x --task task-001 --file /tmp/does-not-exist.md >/dev/null 2>&1
assert "A2 exits 1"  "[ $? -ne 0 ]"

step "A3: fragment add — missing flags"
$JG memory fragment add --feature feat-x --task task-001 2>&1 | tail -1
$JG memory fragment add --feature feat-x --task task-001 >/dev/null 2>&1
assert "A3 exits 1"  "[ $? -ne 0 ]"

step "A4: read — feature doesn't exist"
$JG memory read --feature feat-tidak-ada 2>&1 | tail -1
$JG memory read --feature feat-tidak-ada >/dev/null 2>&1
assert "A4 exits 1"  "[ $? -ne 0 ]"

step "A5: recall — missing --query"
$JG memory recall --feature x 2>&1 | tail -1
$JG memory recall --feature x >/dev/null 2>&1
assert "A5 exits 1"  "[ $? -ne 0 ]"

step "A6: compact — feature doesn't exist"
$JG memory compact --feature feat-nope 2>&1 | tail -1
$JG memory compact --feature feat-nope >/dev/null 2>&1
assert "A6 exits 1"  "[ $? -ne 0 ]"

step "A7: promote — no memory yet (compact not run)"
$JG memory promote --feature feat-x 2>&1 | tail -1
$JG memory promote --feature feat-x >/dev/null 2>&1
assert "A7 exits 1"  "[ $? -ne 0 ]"

printf "\n${Y}Look for:${N} each message actionable — tells you which field is wrong + how to fix.\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 7 (--agent only): Compact + promote lifecycle (LLM)
# ════════════════════════════════════════════════════════════════
if [ "$MODE" = "agent" ]; then
section "7" "Full lifecycle (LLM) — fragment → compact → feature MEMORY → promote → project MEMORY"
T=$(newrepo); cd "$T"
setup_feature "$T" "feat-billing" "task-001"
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('.jonggrang/jonggrang.json'));c.tool='$TOOL';fs.writeFileSync('.jonggrang/jonggrang.json',JSON.stringify(c,null,2));"

step "Stage fragment (no agent)"
cat > /tmp/qa-frag.md << 'EOF'
## What Done
- Added job-level idempotency key to reconciliation job

## Why
Retries were duplicating invoices.

## Lessons / Promotion Candidates
- For financial/background jobs, require idempotency at job boundary BEFORE
  adding retry logic. Retries + no idempotency = silent duplicates.
EOF
$JG memory fragment add --feature feat-billing --task task-001 --file /tmp/qa-frag.md

step "COMPACT (LLM) — merge fragment → feature MEMORY.md"
show "Calls the $TOOL agent. ~30-120s."
$JG memory compact --feature feat-billing
if [ -f .jonggrang/.output/features/feat-billing/MEMORY.md ]; then
  assert "feature MEMORY.md created by compact"   "[ -f .jonggrang/.output/features/feat-billing/MEMORY.md ]"
  step "Inspect feature MEMORY.md — READ CAREFULLY"
  show "cat .jonggrang/.output/features/feat-billing/MEMORY.md"
  cat .jonggrang/.output/features/feat-billing/MEMORY.md
  printf "\n${Y}Checklist:${N}\n"
  printf "  [ ] frontmatter (feature_id, updated_at)\n"
  printf "  [ ] all 6 sections (Context, Facts, What Done & Why, Lessons, Open Qs, Promotion)\n"
  printf "  [ ] idempotency lesson IS present\n"
  printf "  [ ] NO hallucination (no facts not in fragment/tasks)\n"
  printf "  [ ] NO silent fragment loss\n"
  step "Fragment should be archived now"
  show "ls .jonggrang/.ephemeral/memory/archive/feat-billing/"
  ls .jonggrang/.ephemeral/memory/archive/feat-billing/ 2>/dev/null || echo "(no archive dir)"
else
  printf "  ${R}✗ compact did not produce MEMORY.md${N}\n"; FAIL=$((FAIL+1))
fi

step "PROMOTE (LLM) — distill feature → project MEMORY.md"
show "Calls the $TOOL agent. ~30-120s."
$JG memory promote --feature feat-billing
if [ -f .jonggrang/MEMORY.md ]; then
  assert "project MEMORY.md created by promote"   "[ -f .jonggrang/MEMORY.md ]"
  step "Inspect project MEMORY.md — READ CAREFULLY"
  show "cat .jonggrang/MEMORY.md"
  cat .jonggrang/MEMORY.md
  printf "\n${Y}Checklist:${N}\n"
  printf "  [ ] frontmatter (scope: project, updated_at)\n"
  printf "  [ ] 4 sections (Conventions, Known Pitfalls, Arch Decisions, Repeated Lessons)\n"
  printf "  [ ] idempotency lesson present, but MORE ABSTRACT than feature\n"
  printf "  [ ] feature said: 'reconciliation job idempotency key' (specific)\n"
  printf "  [ ] project should say: 'financial jobs, job-boundary idempotency' (abstract)\n"
  printf "  [ ] NO task-specific detail leaked (no 'reconciliation', no 'task-001')\n"
else
  printf "  ${R}✗ promote did not produce MEMORY.md${N}\n"; FAIL=$((FAIL+1))
fi

step "Final: memory read — project + feature index now populated"
$JG memory read
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 8 (--agent only): True agent policy usage (the real test)
# ════════════════════════════════════════════════════════════════
section "8" "True agent policy usage — real plan run calls memory recall"
T=$(newrepo); cd "$T"
mkdir -p .jonggrang
echo "{\"name\":\"t\",\"project\":{\"stack\":\"node\"},\"tool\":\"$TOOL\"}" > .jonggrang/jonggrang.json

step "Pre-seed project memory so recall has something to find"
cat > .jonggrang/MEMORY.md << 'EOF'
---
updated_at: 2026-07-05T10:00:00Z
scope: project
---
## Known Pitfalls
- Always use idempotency keys for financial jobs — retries without keys cause silent duplicates
EOF
show "Seeded memory with an idempotency pitfall."

step "Run plan — watch for recall (~60-120s)"
show "jonggrang plan 'add retry logic to billing reconciliation' --yes"
$JG plan "add retry logic to billing reconciliation" --yes 2>&1 | tee /tmp/plan-run.log | tail -20

step "Check: did the agent call recall?"
show "grep -i 'memory recall' /tmp/plan-run.log"
grep -i "memory recall" /tmp/plan-run.log && assert "agent called memory recall" "true" || {
  printf "  ${Y}⚠ no 'memory recall' string in log — agent may have run it without echoing, or policy not acted on${N}\n"
}

step "Check: did the agent reference the seeded memory?"
show "grep -i 'idempotency\\|pitfall\\|memory' /tmp/plan-run.log | head"
grep -i "idempotency\|pitfall\|memory" /tmp/plan-run.log | head -5

printf "\n${Y}Look for:${N} agent's plan should acknowledge the idempotency pitfall from memory.\n"
printf "${Y}If plan ignores it entirely, recall didn't reach reasoning = bug.${N}\n"
cd "$REPO"; rm -rf "$T"
fi

# ════════════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════════════
printf "\n${B}════════════════════════════════════════════════════════════${N}\n"
printf "${B}  QA SUMMARY: %s passed, %s failed${N}\n" "$PASS" "$FAIL"
if [ "$MODE" = "agent" ]; then
  printf "${B}  Mode: --agent ($TOOL) — ran scenarios 1-8 incl. compact/promote + agent policy${N}\n"
else
  printf "${B}  Mode: --no-agent — ran scenarios 1-6 (deterministic only)${N}\n"
  printf "${B}  Run with --agent to also test compact/promote (scenarios 7-8, needs LLM)${N}\n"
fi
printf "${B}════════════════════════════════════════════════════════════${N}\n"
[ "$FAIL" -eq 0 ] && printf "${G}ALL SCENARIOS GREEN${N}\n" || printf "${R}FAILURES PRESENT${N}\n"
exit $FAIL
