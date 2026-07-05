#!/usr/bin/env bash
# Scenario-based QA for the repo-tracked memory layer (#79, PR #80).
#
# Design philosophy: each scenario PRINTS its output so you can inspect the
# memory lifecycle with your own eyes, not just see pass/fail. Assertions are
# secondary — visibility is primary.
#
# Two modes:
#   bash scripts/qa-memory-scenarios.sh            # default: --no-agent (deterministic)
#   bash scripts/qa-memory-scenarios.sh --agent    # also runs compact/promote (needs LLM)
#   bash scripts/qa-memory-scenarios.sh --agent --tool codex   # pick backend
#
# What you need:
#   --no-agent mode: nothing (no API key, no agent CLI)
#   --agent mode:    a configured agent CLI (claude by default) + API key
#
# Each scenario uses a FRESH temp repo so state never bleeds.

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
JG="node $REPO/bin/jonggrang.js"

# ── args ──
MODE="no-agent"
TOOL="claude"
for a in "$@"; do
  case "$a" in
    --agent)    MODE="agent" ;;
    --no-agent) MODE="no-agent" ;;
    --tool)     : ;; # value consumed below
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
  # $1 = repo, $2 = feature_id, $3 = task_id
  local repo="$1" fid="$2" tid="$3"
  mkdir -p "$repo/.jonggrang/.output/features/$fid"
  echo '{"name":"qa","project":{"stack":"node"}}' > "$repo/.jonggrang/jonggrang.json"
  echo "{\"tasks\":[{\"id\":\"$tid\",\"title\":\"test task\",\"status\":\"completed\",\"feature_id\":\"$fid\"}]}" \
    > "$repo/.jonggrang/.output/features/$fid/jonggrang-tasks.json"
}

# ════════════════════════════════════════════════════════════════
# SCENARIO 1: Empty repo — what does memory look like before anything?
# ════════════════════════════════════════════════════════════════
section "1" "Empty repo — inspect memory state before any compaction"
T=$(newrepo); cd "$T"
show "Fresh repo. No MEMORY.md anywhere yet. Let's see what the CLI shows."

step "memory read (no flag) — project view + feature index"
$JG memory read
assert "exits 0"                                 "[ $? -eq 0 ]"
assert "no project MEMORY.md file exists yet"    "! [ -f .jonggrang/MEMORY.md ]"

step "memory recall — empty memory should be empty-safe"
$JG memory recall --phase plan --query "anything"
assert "recall exits 0 (not crash on empty)"     "[ $? -eq 0 ]"

step "memory read --feature feat-x — missing feature, clean error"
$JG memory read --feature feat-x
assert "exits 1 (clean error, not crash)"        "[ $? -eq 1 ]"

printf "\n${Y}What to look for:${N} read shows 'not initialized' message. recall shows '0 snippets'.\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 2: Task agent submits a fragment — staging only
# ════════════════════════════════════════════════════════════════
section "2" "Task fragment — staging only, canonical memory untouched"
T=$(newrepo); cd "$T"
setup_feature "$T" "feat-billing" "task-001"

step "Create a fragment file (what a task agent would write at completion)"
cat > /tmp/qa-frag.md << 'EOF'
## What Done
- Added job-level idempotency key to reconciliation job

## Why
Retries were duplicating invoices — without a key, the same settlement
could be processed twice if the cron retried mid-failure.

## Tradeoffs
- Slight write amplification (extra index lookup per job)
- Chose job-boundary key over row-level: simpler, covers the race window

## Lessons / Promotion Candidates
- For financial/background jobs, require idempotency at job boundary
  BEFORE adding retry logic. Retries + no idempotency = silent duplicates.
EOF
show "Fragment written to /tmp/qa-frag.md. Now stage it."

step "memory fragment add — stage to ephemeral"
$JG memory fragment add --feature feat-billing --task task-001 --file /tmp/qa-frag.md
assert "fragment staged under .ephemeral/"           "find .jonggrang/.ephemeral/memory/fragments/feat-billing -name '*.md' | grep -q ."
assert "canonical feature MEMORY.md NOT created"     "! [ -f .jonggrang/.output/features/feat-billing/MEMORY.md ]"
assert "project MEMORY.md NOT created"               "! [ -f .jonggrang/MEMORY.md ]"

step "Inspect: where did the fragment land?"
show "ls .jonggrang/.ephemeral/memory/fragments/feat-billing/"
ls .jonggrang/.ephemeral/memory/fragments/feat-billing/

step "Inspect: fragment content preserved?"
FRAG=$(find .jonggrang/.ephemeral/memory/fragments/feat-billing -name '*.md' | head -1)
show "cat $FRAG"
cat "$FRAG"

printf "\n${Y}What to look for:${N} fragment is under .ephemeral/ (gitignored), NOT under .output/.\n"
printf "${Y}Canonical MEMORY.md files do NOT exist yet — fragment is staging only.${N}\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 3: Git tracking — what's committed vs ignored?
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

## Context
Billing reconciliation module.

## Lessons Learned
- Idempotency at job boundary required for retry safety.
EOF

step "Simulate: create a fragment (ephemeral staging)"
mkdir -p .jonggrang/.ephemeral/memory/fragments/feat-billing
echo "## What Done\n- test" > .jonggrang/.ephemeral/memory/fragments/feat-billing/task-001-x.md

step "git status — what would be committed?"
show "git status --short"
git status --short

step "Verify git tracking decisions"
git check-ignore -q .jonggrang/.output/features/feat-billing/MEMORY.md 2>/dev/null
assert "feature MEMORY.md is TRACKED (not ignored)"   "[ $? -ne 0 ]"
git check-ignore -q .jonggrang/.ephemeral/memory/fragments/feat-billing/task-001-x.md 2>/dev/null
assert "fragment is IGNORED (ephemeral)"              "[ $? -eq 0 ]"

printf "\n${Y}What to look for:${N} .output/features/.../MEMORY.md appears in git status (untracked, will be added).\n"
printf "${Y}Fragment does NOT appear in git status (ignored).${N}\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 4: Policy injection — does the prompt actually contain it?
# ════════════════════════════════════════════════════════════════
section "4" "Policy injection — verify prompts contain memory policy + recall guide"
step "This proves the agent WILL see the policy. No agent needed — we inspect the prompt directly."

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

for (const [label, prompt] of samples) {
  console.log("\n── " + label + " ──");
  // Extract just the memory policy block to show it is present
  const m = prompt.match(/## Jonggrang Memory Policy[\s\S]*?(?=\n## |\n$|$)/);
  if (m) {
    console.log(m[0].trim());
  } else {
    console.log("❌ NO MEMORY POLICY FOUND IN PROMPT");
  }
}
fs.rmSync(tmp, {recursive:true, force:true});
'

printf "\n${Y}What to look for:${N} each phase shows the policy block + a recall command.\n"
printf "${Y}Work phase should ALSO show the fragment-add command (task completion).${N}\n"

# ════════════════════════════════════════════════════════════════
# SCENARIO 5: Read-only contract — read never mutates files
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
show "project hash:  $H1"
show "feature hash:  $H2"

step "memory read (renders project + index)"
$JG memory read

step "memory read --feature feat-billing"
$JG memory read --feature feat-billing

step "Hash files AFTER read — must be unchanged"
H1b=$(shasum .jonggrang/MEMORY.md | cut -d' ' -f1)
H2b=$(shasum .jonggrang/.output/features/feat-billing/MEMORY.md | cut -d' ' -f1)
show "project hash:  $H1b"
show "feature hash:  $H2b"
assert "project MEMORY.md hash unchanged (read-only)"  "[ '$H1' = '$H1b' ]"
assert "feature MEMORY.md hash unchanged (read-only)"  "[ '$H2' = '$H2b' ]"

printf "\n${Y}What to look for:${N} hashes identical before/after. read renders, never mutates.${N}\n"
cd "$REPO"; rm -rf "$T"

# ════════════════════════════════════════════════════════════════
# SCENARIO 6 (agent mode only): Full lifecycle — compact + promote
# ════════════════════════════════════════════════════════════════
if [ "$MODE" = "agent" ]; then
section "6" "Full lifecycle (LLM) — fragment → compact → feature MEMORY → promote → project MEMORY"
T=$(newrepo); cd "$T"
setup_feature "$T" "feat-billing" "task-001"
# set tool for compact/promote to use
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
show "This calls the $TOOL agent. May take 30-120s..."
$JG memory compact --feature feat-billing
if [ -f .jonggrang/.output/features/feat-billing/MEMORY.md ]; then
  assert "feature MEMORY.md created by compact"   "[ -f .jonggrang/.output/features/feat-billing/MEMORY.md ]"
  step "Inspect feature MEMORY.md content"
  show "cat .jonggrang/.output/features/feat-billing/MEMORY.md"
  cat .jonggrang/.output/features/feat-billing/MEMORY.md
  step "Fragment should be archived now"
  show "ls .jonggrang/.ephemeral/memory/archive/feat-billing/"
  ls .jonggrang/.ephemeral/memory/archive/feat-billing/ 2>/dev/null || echo "(no archive dir — check if fragments existed)"
else
  printf "  ${R}✗ compact did not produce MEMORY.md (agent may have failed)${N}\n"; FAIL=$((FAIL+1))
fi

step "PROMOTE (LLM) — distill feature → project MEMORY.md"
show "This calls the $TOOL agent. May take 30-120s..."
$JG memory promote --feature feat-billing
if [ -f .jonggrang/MEMORY.md ]; then
  assert "project MEMORY.md created by promote"   "[ -f .jonggrang/MEMORY.md ]"
  step "Inspect project MEMORY.md content"
  show "cat .jonggrang/MEMORY.md"
  cat .jonggrang/MEMORY.md
  printf "\n${Y}What to look for:${N} project memory should be MORE abstract than feature memory.\n"
  printf "${Y}Feature = specific (idempotency key on reconciliation job).${N}\n"
  printf "${Y}Project = abstracted (idempotency at job boundary for financial jobs).${N}\n"
else
  printf "  ${R}✗ promote did not produce MEMORY.md (agent may have failed)${N}\n"; FAIL=$((FAIL+1))
fi

step "Final: memory read — project + feature index now populated"
$JG memory read

cd "$REPO"; rm -rf "$T"
fi

# ════════════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════════════
printf "\n${B}════════════════════════════════════════════════════════════${N}\n"
printf "${B}  QA SUMMARY: %s passed, %s failed${N}\n" "$PASS" "$FAIL"
if [ "$MODE" = "agent" ]; then
  printf "${B}  Mode: --agent (LLM compact/promote via $TOOL)${N}\n"
else
  printf "${B}  Mode: --no-agent (deterministic only)${N}\n"
  printf "${B}  Run with --agent to also test compact/promote (needs LLM)${N}\n"
fi
printf "${B}════════════════════════════════════════════════════════════${N}\n"
[ "$FAIL" -eq 0 ] && printf "${G}ALL SCENARIOS GREEN${N}\n" || printf "${R}FAILURES PRESENT${N}\n"
exit $FAIL
