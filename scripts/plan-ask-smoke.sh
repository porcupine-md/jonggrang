#!/usr/bin/env bash
set -euo pipefail

# Deterministic smoke tests for `jonggrang plan ask`.
#
# This intentionally avoids live LLM calls. It validates the CLI intake contract,
# persisted sidecar files, answer formatting, and prompt injection by creating a
# disposable project in /tmp and running the repo-local Jonggrang binary.
#
# Usage:
#   bash scripts/plan-ask-smoke.sh
#
# Optional env:
#   TEST_REPO=/tmp/my-repo                 # default: mktemp -d /tmp/jg-plan-ask-smoke.XXXXXX
#   JONGGRANG_HOME=/tmp/my-jonggrang-home  # default: /tmp/jg-plan-ask-smoke-home

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JG=(node "$ROOT_DIR/bin/jonggrang.js")
export JONGGRANG_HOME="${JONGGRANG_HOME:-/tmp/jg-plan-ask-smoke-home}"

TEST_REPO="${TEST_REPO:-$(mktemp -d /tmp/jg-plan-ask-smoke.XXXXXX)}"
rm -rf "$JONGGRANG_HOME"
mkdir -p "$TEST_REPO"

# `plan ask` now persists Q&A PER-DRAFT under .drafts/<session>/ (not a root
# singleton). In production cmdPlan exports JONGGRANG_DRAFT_SESSION before running
# the planning agent; emulate that here so standalone `plan ask` targets a draft.
export JONGGRANG_DRAFT_SESSION="draft-plan-ask-smoke"
DRAFT_REL=".jonggrang/.drafts/$JONGGRANG_DRAFT_SESSION"
export QFILE="$DRAFT_REL/plan-questions.json"
export AFILE="$DRAFT_REL/plan-answers.json"

pass() { printf '\033[0;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[0;36m==> %s\033[0m\n' "$*"; }

step "Using repo-local Jonggrang binary"
"${JG[@]}" version

step "Initialize disposable repo: $TEST_REPO"
cd "$TEST_REPO"
git init -b main >/dev/null
git config user.email "manual-test@example.com"
git config user.name "Manual Test"

"${JG[@]}" init \
  --name plan-ask-smoke \
  --type cli \
  --work-mode work-loop \
  --team-size solo \
  --state existing \
  --stack node \
  --autonomy autonomous \
  --ci none \
  --testing npm \
  --tool claude \
  --force >/tmp/jg-plan-ask-smoke-init.log

cat > package.json <<'JSON'
{"name":"plan-ask-smoke","version":"1.0.0","type":"commonjs","scripts":{"test":"node test/smoke.test.js"}}
JSON
cat > index.js <<'JS'
function greet(name) { return `hello ${name}`; }
module.exports = { greet };
JS
mkdir -p test
cat > test/smoke.test.js <<'JS'
const { greet } = require('../index');
if (greet('jonggrang') !== 'hello jonggrang') throw new Error('greet failed');
console.log('ok');
JS
git add . >/dev/null
git commit -m "chore: setup plan ask smoke repo" >/dev/null
pass "repo initialized"

clean_plan() {
  rm -f .jonggrang/plan.md "$QFILE" "$AFILE"
  rm -rf .jonggrang/.ephemeral
}

step "Test 1: plan ask saves normalized questions"
clean_plan
"${JG[@]}" plan ask --json --input '{
  "goal_analysis": "Need clarify",
  "questions": [
    {
      "question": "UI-nya mau seperti apa?",
      "type": "single_choice",
      "options": [
        {"value":"modal","label":"Modal","rationale":"lebih cepat"},
        {"value":"page","label":"Page","rationale":"lebih fleksibel"}
      ]
    },
    {"question":"Ada constraint khusus?","type":"text"}
  ]
}' >/tmp/jg-plan-ask-smoke-valid.json

test -f "$QFILE" || fail "plan-questions.json missing (expected at $QFILE)"
node - <<'NODE'
const fs = require('fs');
const q = JSON.parse(fs.readFileSync(process.env.QFILE, 'utf8'));
if (q.goal_analysis !== 'Need clarify') throw new Error('goal_analysis mismatch');
if (!Array.isArray(q.questions) || q.questions.length !== 2) throw new Error('questions length mismatch');
if (q.questions[0].id !== 'q1' || q.questions[1].id !== 'q2') throw new Error('auto ids missing');
if (q.questions[0].allow_freetext !== true) throw new Error('allow_freetext default missing');
if (q.questions[0].options.length !== 2) throw new Error('options mismatch');
NODE
pass "questions normalized and persisted"

step "Test 2: plan ask accepts stdin and --goal override"
printf '%s' '[{"question":"Pick one","type":"single_choice","options":[{"value":"a"},{"value":"b"}]}]' \
  | "${JG[@]}" plan ask --json --goal "Override goal" >/tmp/jg-plan-ask-smoke-stdin.json
node - <<'NODE'
const fs = require('fs');
const q = JSON.parse(fs.readFileSync(process.env.QFILE, 'utf8'));
if (q.goal_analysis !== 'Override goal') throw new Error('goal override failed');
if (q.questions[0].question !== 'Pick one') throw new Error('stdin question not saved');
NODE
pass "stdin + goal override works"

step "Test 3: invalid single_choice is rejected"
set +e
bad_out=$("${JG[@]}" plan ask --json --input '{"questions":[{"question":"Bad","type":"single_choice","options":[{"value":"only"}]}]}' 2>&1)
bad_code=$?
set -e
[[ $bad_code -ne 0 ]] || fail "invalid schema unexpectedly succeeded"
grep -q "needs at least 2 options" <<<"$bad_out" || fail "invalid schema error message mismatch: $bad_out"
pass "invalid schema rejected"

step "Test 4: library answer persistence + clarification formatting"
node - "$ROOT_DIR" <<'NODE'
const path = require('path');
const fs = require('fs');
const repo = process.argv[2];
const lib = require(path.join(repo, 'lib/jonggrang'));
const answersFile = path.resolve(process.env.AFILE);
fs.mkdirSync(path.dirname(answersFile), { recursive: true });
lib.savePlanAnswers(answersFile, {
  goal_analysis: 'Goal',
  answers: [
    { id: 'q1', question: 'Which UI?', type: 'single_choice', value: 'modal', label: 'Modal' },
    { id: 'q2', question: 'Constraints?', type: 'text', value: 'Keep MVP', freetext: 'Keep MVP' }
  ]
});
const data = lib.getPlanAnswers(answersFile);
const md = lib.formatClarifications(data);
if (!md.includes('Goal: Goal')) throw new Error('goal missing from clarifications');
if (!md.includes('**Which UI?** → Modal')) throw new Error('choice missing from clarifications');
if (!md.includes('**Constraints?** → Keep MVP')) throw new Error('text missing from clarifications');
fs.writeFileSync('/tmp/jg-plan-ask-smoke-clarifications.md', md);
NODE
test -f "$AFILE" || fail "plan-answers.json missing (expected at $AFILE)"
pass "answers persisted and formatted"

step "Test 5: prompt builders include clarifications"
node - "$ROOT_DIR" <<'NODE'
const path = require('path');
const repo = process.argv[2];
const lib = require(path.join(repo, 'lib/jonggrang'));
const clarifications = '- **Which UI?** → Modal';
const draftPath = '.jonggrang/.drafts/smoke/plan.md';
const draft = lib.buildDraftPlanPrompt('feature', '.jonggrang/jonggrang.json', process.cwd(), draftPath, { clarifications });
const revise = lib.buildRevisePlanPrompt('# Plan', 'revise', draftPath, { clarifications });
const deep1 = lib.buildDeepPlanDiscoveryPrompt('feature', '.jonggrang/jonggrang.json', '.jonggrang/.drafts/smoke/discovery.md', { clarifications });
const deep3 = lib.buildDeepPlanCondensePrompt('feature', 'discovery', 'analysis', '.jonggrang/jonggrang.json', process.cwd(), draftPath, { clarifications });
for (const [name, text] of Object.entries({ draft, revise, deep1, deep3 })) {
  if (!text.includes(clarifications)) throw new Error(`${name} missing clarifications`);
}
NODE
pass "prompt builders inject clarifications"

step "Summary"
echo "Disposable repo: $TEST_REPO"
echo "JONGGRANG_HOME: $JONGGRANG_HOME"
echo "Init log: /tmp/jg-plan-ask-smoke-init.log"
echo "Clarifications sample: /tmp/jg-plan-ask-smoke-clarifications.md"
echo
pass "All deterministic plan ask smoke tests passed"
