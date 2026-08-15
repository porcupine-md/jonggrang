#!/usr/bin/env bash
set -euo pipefail

# Starter-pack consent → approve → UI.md + UI_HANDOFF.md + template (end-to-end)
#
# Covers the gap that smoke-ui-plan-lifecycle.sh does not: a project with NO
# existing token source or component library, where a built-in starter pack is
# recommended and the user must explicitly consent (or provide a preference)
# before the pack is applied. Verifies that the approved pack's exact token
# template reaches the UI-foundation task's bounded handoff section.
#
# Uses the same fake-agent pattern as smoke-ui-plan-lifecycle.sh. No real model.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jonggrang-ui-starter.XXXXXX")"
FAKE_BIN="$TMP/fake-bin"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$FAKE_BIN" "$TMP/project/src" "$TMP/project/.jonggrang"

# Fake agent: handles plan generation + decompose with starter-pack template.
cat > "$FAKE_BIN/opencode" <<'NODE'
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const prompt = process.argv[process.argv.length - 1] || '';
const cwd = process.cwd();
const cli = process.env.JONGGRANG_SMOKE_CLI;
const emit = (text) => process.stdout.write(JSON.stringify({ type: 'text', part: { text } }) + '\n');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const match = (re, label) => { const found = prompt.match(re); if (!found) throw new Error(`fake agent: missing ${label}`); return found[1]; };

if (prompt.includes('Clarify Before Planning')) {
  emit('NO_QUESTIONS\n');
  process.exit(0);
}

if (prompt.includes('Generate Draft Plan')) {
  const planPath = match(/Write it to `([^`]+\/plan\.md)`/, 'plan path');
  const sessionDir = path.dirname(planPath);
  const guidePath = path.join(sessionDir, 'UI.md');
  const handoffPath = path.join(sessionDir, 'UI_HANDOFF.md');
  write(planPath, `---
feature: dashboard-alert-console
branch: feat/dashboard-alert-console
base: "main"
work_type: SMALL
description: Add a dashboard alert console
created_at: 2026-07-17T00:00:00.000Z
ui: true
ui_guide_status: update proposed
ui_baseline: dashboard-operational@1
ui_token_status: planned
---

# Plan: Dashboard Alert Console

## Approach
Create the token source from the approved starter pack, then build the console.

## Phases
1. Create token source and UI-foundation task.
2. Build alert console using the new tokens.

## Key Decisions
- Use dashboard-operational@1 starter pack tokens.

## Out of Scope
- New component library.

## Dependencies
Starter pack token template.
`);
  write(guidePath, `---
format: jonggrang-ui-guide/v1
baseline: dashboard-operational@1
ui_framework: react
token_source: src/styles/new-tokens.css
token_status: planned
token_owner_task: task-001
component_source: none
storybook: none
references: []
---

# UI guide

## Product and UX rationale
Operators resolve alerts repeatedly.

## Visual direction and baseline
Use the dashboard-operational starter pack.

## Source map
- Tokens: \`src/styles/new-tokens.css\` (planned)

## Token contract, typography, and spacing
Use semantic tokens from the starter pack.

## Components and layout patterns
Build a compact alert table.

## Interaction, responsive, and accessibility rules
Keep focus visible and preserve input on errors.

## References and verification
Run \`npm test\`. Storybook: none.

## Rules summary
Use the approved starter pack tokens first.
`);
  write(handoffPath, `# UI handoff draft: dashboard alert console

Guide: .jonggrang/UI.md
Baseline: dashboard-operational@1
Token source: src/styles/new-tokens.css (planned)
Guide status: update proposed

## Feature intent
Operators resolve alerts without leaving their queue.

## Shared direction
Use the starter pack tokens; keep feedback inline.

## References
- .jonggrang/UI.md#components-and-layout-patterns
`);
  emit(`Draft plan written to ${planPath}\n`);
  process.exit(0);
}

if (prompt.includes('Decompose Approved Plan to Tasks')) {
  const featureId = match(/jonggrang task import --feature ([a-zA-Z0-9._-]+)/, 'feature id');
  const handoffAbsolute = match(/After importing tasks, write the complete handoff to `([^`]+)`/, 'handoff path');
  const digest = match(/Approved guide revision: `([^`]+)`/, 'guide digest');
  const tokenSource = match(/Token source: `([^`]+)`/, 'token source');
  // Extract the starter token template from the prompt.
  const templateMatch = prompt.match(/Approved starter token template[\s\S]*?```css\n([\s\S]*?)```/);
  if (!templateMatch) throw new Error('fake agent: missing starter token template in decompose prompt');
  const template = templateMatch[1].trim();

  const task = [{
    id: 'task-001',
    title: 'Create token source from starter pack (UI-foundation)',
    description: 'Copy the approved starter token template to the planned destination.',
    priority: 1,
    files: [tokenSource],
    blocked_by: [],
    ui_context: {
      handoff: `.jonggrang/.output/features/${featureId}/UI_HANDOFF.md`,
      sections: ['Feature intent', 'Shared direction', 'Task task-001'],
      guide: '.jonggrang/UI.md',
      guide_revision: digest,
      guide_sections: ['Token contract, typography, and spacing', 'Components and layout patterns'],
      baseline: 'dashboard-operational@1',
      read_order: ['handoff', 'guide_sections', 'source_files'],
      on_conflict: 'report UI_GUIDE_DRIFT',
      token_source: tokenSource,
      foundation: true,
      source_files: [],
      states: ['ready'],
      verification: ['npm test'],
    },
  }];
  const imported = spawnSync(process.execPath, [cli, 'task', 'import', '--feature', featureId, '--input', JSON.stringify(task), '--json'], {
    cwd, env: process.env, encoding: 'utf8',
  });
  if (imported.status !== 0) throw new Error(imported.stderr || imported.stdout || 'task import failed');
  write(handoffAbsolute, `# UI handoff: dashboard alert console

Guide: .jonggrang/UI.md
Guide revision: ${digest}
Baseline: dashboard-operational@1
Token source: ${tokenSource} (planned)
Guide status: update proposed

## Feature intent
Operators resolve alerts without leaving their queue.

## Shared direction
Use the starter pack tokens; keep feedback inline.

## References
- .jonggrang/UI.md#components-and-layout-patterns

## Task task-001
Objective: create the token source from the starter pack.
Use: the approved starter token template verbatim.
Change: copy the template to \`${tokenSource}\`.
States: ready.
Do not: paraphrase or regenerate token values.
Acceptance: token source exists and matches the template.
Sources: starter pack token template.
Check: npm test

\`\`\`css
${template}
\`\`\`
`);
  emit('Imported 1 task and wrote UI_HANDOFF.md\n');
  process.exit(0);
}

throw new Error('fake agent received an unexpected prompt');
NODE
chmod +x "$FAKE_BIN/opencode"

# Fixture: React dep, NO tokens, NO components → consent gate triggers.
cat > "$TMP/project/package.json" <<'JSON'
{"name":"starter-pack-test","scripts":{"test":"node --test"},"dependencies":{"react":"^19.0.0"}}
JSON
cat > "$TMP/project/.jonggrang/jonggrang.json" <<'JSON'
{"name":"starter-pack-test","project":{"stack":"react"},"tool":"opencode","mode":{"autonomy":"autonomous"},"work":{"max_iterations":1}}
JSON
printf '# Starter pack test\n' > "$TMP/project/AGENTS.md"
(
  cd "$TMP/project"
  git init -q
  git config user.name Smoke
  git config user.email smoke@example.com
  git add .
  git commit -qm 'chore: starter fixture'
)

export PATH="$FAKE_BIN:$PATH"
export JONGGRANG_SMOKE_CLI="$ROOT/bin/jonggrang.js"
export JONGGRANG_TOOL=opencode

printf '\n== Starter-pack consent → approve → UI.md + UI_HANDOFF.md + template ==\n'

DESCRIPTION="build an operations dashboard alert console"

# Pass A must stop at a persisted preference gate. No starter artifact may be
# generated until the user explicitly answers the question.
(
  cd "$TMP/project"
  node "$ROOT/bin/jonggrang.js" plan "$DESCRIPTION" >"$TMP/plan-pass-a.log" 2>&1
)
SESSION_DIR=$(find "$TMP/project/.jonggrang/.drafts" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$SESSION_DIR" ]
SESSION_ID=$(basename "$SESSION_DIR")
[ -f "$SESSION_DIR/plan-questions.json" ]
[ ! -f "$SESSION_DIR/plan-answers.json" ]
[ ! -f "$SESSION_DIR/plan.md" ]
[ ! -f "$SESSION_DIR/UI.md" ]
[ ! -f "$SESSION_DIR/UI_HANDOFF.md" ]
node - "$SESSION_DIR/plan-questions.json" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(data.questions[0].id, 'ui-preference');
assert.ok(data.questions[0].options.some(option => option.value === 'use:dashboard-operational@1'));
assert.equal(data.questions[0].allow_freetext, true);
console.log('  ✓ Pass A persisted ui-preference and generated no starter artifacts');
NODE

# Pass B resumes the same draft after explicit starter consent.
ANSWERS=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({goal_analysis:"",answers:[{id:"ui-preference",value:"use:dashboard-operational@1",freetext:null}]})).toString("base64"))')
(
  cd "$TMP/project"
  node "$ROOT/bin/jonggrang.js" plan "$DESCRIPTION" --session "$SESSION_ID" --answers-inline "$ANSWERS" >"$TMP/plan-pass-b.log" 2>&1
)

[ ! -f "$SESSION_DIR/plan-questions.json" ]
[ -f "$SESSION_DIR/plan-answers.json" ]
echo "=== assert draft artifacts exist after explicit consent ==="
[ -f "$SESSION_DIR/plan.md" ]
printf '  ✓ draft plan.md exists\n'
[ -f "$SESSION_DIR/UI.md" ]
printf '  ✓ draft UI.md exists\n'
[ -f "$SESSION_DIR/UI_HANDOFF.md" ]
printf '  ✓ draft UI_HANDOFF.md exists\n'

echo "=== approve ==="
(
  cd "$TMP/project"
  node "$ROOT/bin/jonggrang.js" approve --session "$SESSION_ID" --yes >"$TMP/approve.log" 2>&1
)

FEATURE_DIR=$(find "$TMP/project/.jonggrang/.output/features" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$FEATURE_DIR" ]
FEATURE_ID=$(basename "$FEATURE_DIR")

echo "=== assert canonical artifacts exist ==="
[ -f "$TMP/project/.jonggrang/UI.md" ]
printf '  ✓ .jonggrang/UI.md exists (canonical)\n'
[ -f "$FEATURE_DIR/UI_HANDOFF.md" ]
printf '  ✓ %s/UI_HANDOFF.md exists\n' "$FEATURE_ID"
[ -f "$FEATURE_DIR/jonggrang-tasks.json" ]
printf '  ✓ jonggrang-tasks.json exists\n'

echo "=== assert ui_context + baseline + foundation ==="
node - "$FEATURE_DIR/jonggrang-tasks.json" "$FEATURE_ID" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const [file, featureId] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const tasks = data.tasks;
assert.equal(tasks.length, 1, 'expected 1 task');
assert.equal(tasks[0].ui_context.baseline, 'dashboard-operational@1', 'baseline must be starter pack');
assert.equal(tasks[0].ui_context.handoff, `.jonggrang/.output/features/${featureId}/UI_HANDOFF.md`);
assert.equal(tasks[0].ui_context.foundation, true, 'task must be foundation');
assert.equal(tasks[0].ui_context.token_source, 'src/styles/new-tokens.css', 'planned token source');
console.log('  ✓ ui_context.baseline = dashboard-operational@1');
console.log('  ✓ ui_context.foundation = true');
console.log('  ✓ ui_context.token_source = src/styles/new-tokens.css');
NODE

echo "=== assert token template in foundation handoff section ==="
ROOT_UNDER_TEST="$ROOT" node - "$FEATURE_DIR/UI_HANDOFF.md" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const ui = require(process.env.ROOT_UNDER_TEST + '/lib/ui-context');
const content = fs.readFileSync(process.argv[2], 'utf8');
const section = ui.extractMarkdownSection(content, 'Task task-001');
const template = ui.loadBaselinePack('dashboard-operational@1').tokenTemplate.trim();
assert.ok(section, 'foundation task section exists');
assert.ok(section.includes(template), 'foundation task section must contain the complete starter template verbatim');
console.log('  ✓ foundation handoff section contains the complete starter token template verbatim');
NODE

echo "=== assert UI.md canonical has starter baseline ==="
node - "$TMP/project/.jonggrang/UI.md" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const content = fs.readFileSync(process.argv[2], 'utf8');
assert.match(content, /baseline: dashboard-operational@1/, 'canonical guide pins starter baseline');
assert.match(content, /token_source: src\/styles\/new-tokens\.css/, 'canonical guide has planned token source');
console.log('  ✓ canonical UI.md pins dashboard-operational@1 + planned token source');
NODE

echo "=== assert task prompt (bounded, no full guide leak) ==="
PROMPT=$(cd "$TMP/project" && node "$ROOT/bin/jonggrang.js" work --feature "$FEATURE_ID" --dry-run --max-iterations 1 2>/dev/null)
grep -q 'UI Task Context (bounded)' <<<"$PROMPT" && printf '  ✓ task prompt has bounded UI context\n'
grep -q 'report `UI_GUIDE_DRIFT`' <<<"$PROMPT" && printf '  ✓ task prompt has drift reporting\n'
# 'Token contract, typography, and spacing' IS a selected guide_section — not a leak.
# Check that a NON-selected section (e.g. 'Product and UX rationale') is absent.
if grep -q 'Product and UX rationale' <<<"$PROMPT"; then
  echo '  ✗ full guide leaked into task prompt (non-selected section present)' >&2
  exit 1
fi
printf '  ✓ full guide did NOT leak (non-selected sections absent)\n'

echo "=== materialize token + task done → foundation promotion ==="
# Simulate the UI-foundation agent doing its work: copy the approved starter
# token template to the planned destination. promoteUiFoundation validates
# that this file exists before promoting the guide from planned to ready.
TOKEN_DEST="$TMP/project/src/styles/new-tokens.css"
mkdir -p "$(dirname "$TOKEN_DEST")"
ROOT_UNDER_TEST="$ROOT" TOKEN_DEST="$TOKEN_DEST" node <<'NODE'
const ui = require(process.env.ROOT_UNDER_TEST + '/lib/ui-context');
const fs = require('fs');
const pack = ui.loadBaselinePack('dashboard-operational@1');
fs.writeFileSync(process.env.TOKEN_DEST, pack.tokenTemplate, 'utf8');
NODE
[ -f "$TOKEN_DEST" ]
printf '  ✓ token source materialized at src/styles/new-tokens.css\n'

# Mark the foundation task done → promoteUiFoundation runs atomically.
( cd "$TMP/project" && node "$ROOT/bin/jonggrang.js" task done task-001 --feature "$FEATURE_ID" --yes >"$TMP/task-done.log" 2>&1 )
tail -2 "$TMP/task-done.log"

echo "=== assert guide promoted planned → ready ==="
node - "$TMP/project/.jonggrang/UI.md" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const content = fs.readFileSync(process.argv[2], 'utf8');
assert.match(content, /token_status: ready/, 'guide token_status must be promoted to ready');
assert.match(content, /token_owner_task: task-001/, 'guide must pin the foundation owner task');
console.log('  ✓ canonical UI.md promoted: token_status ready, token_owner_task task-001');
NODE

echo "=== assert handoff + tasks guide_revision updated ==="
node - "$FEATURE_DIR/UI_HANDOFF.md" "$FEATURE_DIR/jonggrang-tasks.json" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const [handoffFile, tasksFile] = process.argv.slice(2);
const handoff = fs.readFileSync(handoffFile, 'utf8');
assert.match(handoff, /Token source: src\/styles\/new-tokens\.css \(ready\)/, 'handoff must mark token source ready');
const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
assert.equal(tasks.tasks[0].status, 'completed', 'foundation task must be marked completed');
assert.match(tasks.tasks[0].ui_context.guide_revision, /^sha256:/, 'guide_revision must be a pinned digest');
console.log('  ✓ handoff Token source (ready) + task done + guide_revision pinned');
NODE

printf '\n== PASS: starter-pack consent → approve → UI.md + UI_HANDOFF.md + template → foundation ready ==\n'
