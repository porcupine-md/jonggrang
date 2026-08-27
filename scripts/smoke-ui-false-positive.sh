#!/usr/bin/env bash
set -euo pipefail

# A plan that the UI keyword guess claims and the decomposition does not.
#
# `detectUiWork` matches the word `page`, so "purge the page cache" reads as UI
# work: the plan gets `ui: true`, the agent dutifully writes a UI handoff draft,
# and then the decomposition — correctly — produces no task needing UI context.
# Approval used to refuse the whole plan there ("UI plan produced no tasks with
# ui_context"), which is how it was reported from a live dashboard.
#
# Fake agent, no real model: the decompose branch writes tasks WITHOUT ui_context
# on purpose, which is the condition the live failure needed and could not be
# reproduced on demand (the same plan produced one UI task on a later run).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jonggrang-ui-falsepos.XXXXXX")"
FAKE_BIN="$TMP/fake-bin"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$FAKE_BIN" "$TMP/project/src/components" "$TMP/project/src/styles" "$TMP/project/.jonggrang"

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

if (prompt.includes('Clarify Before Planning')) { emit('NO_QUESTIONS\n'); process.exit(0); }

if (prompt.includes('Generate Draft Plan')) {
  const planPath = match(/Write it to `([^`]+\/plan\.md)`/, 'plan path');
  const sessionDir = path.dirname(planPath);
  // What the real agent produced for this description: UI flagged, guide
  // untouched, baseline the existing project.
  write(planPath, `---
feature: page-cache-purge
branch: feat/page-cache-purge
base: "main"
work_type: BUGFIX
ui: true
ui_guide_status: unchanged
ui_baseline: existing-project
ui_token_status: ready
description: Purge the nginx page cache when a fundraising edit is saved
---

# Plan: Page Cache Purge

## Approach
Invalidate the cached detail page and both checkout pages after an edit is saved.
`);
  write(path.join(sessionDir, 'UI_HANDOFF.md'), `# UI handoff draft: page cache purge

Guide: .jonggrang/UI.md
Baseline: existing-project
Token source: src/styles/tokens.css (ready)
Guide status: unchanged

## Feature intent
Readers see fresh content after an edit.

## Shared direction
No visual change; the rendered pages stay as they are.

## References
- .jonggrang/UI.md#components-and-layout-patterns
`);
  emit(`Draft plan written to ${planPath}\n`);
  process.exit(0);
}

if (prompt.includes('Decompose Approved Plan to Tasks')) {
  const featureId = match(/jonggrang task import --feature ([a-zA-Z0-9._-]+)/, 'feature id');
  const handoffAbsolute = match(/After importing tasks, write the complete handoff to `([^`]+)`/, 'handoff path');
  // The point of this fixture: cache invalidation needs no UI context, so none
  // of these tasks carries any.
  const tasks = [
    { id: 'task-001', title: 'Purge the detail page cache on save', description: 'Call the purge helper for the subType detail path after a successful edit.', priority: 1, files: ['src/libs/payment-link.js'], blocked_by: [] },
    { id: 'task-002', title: 'Purge both checkout page caches', description: 'Purge the two fundraising checkout paths in the same code path.', priority: 2, files: ['src/libs/payment-link.js'], blocked_by: [] },
  ];
  const imported = spawnSync(process.execPath, [cli, 'task', 'import', '--feature', featureId, '--input', JSON.stringify(tasks), '--json'], {
    cwd, env: process.env, encoding: 'utf8',
  });
  if (imported.status !== 0) throw new Error(`fake agent: task import failed: ${imported.stderr}`);
  // It still writes the handoff it was asked for — approval must clean that up
  // itself rather than leaving a UI artefact on a plan that has no UI task.
  write(handoffAbsolute, `# UI handoff: page cache purge

## Feature intent
Readers see fresh content after an edit.

## Shared direction
No visual change.
`);
  emit('Tasks imported\n');
  process.exit(0);
}

throw new Error('fake agent received an unexpected prompt');
NODE
chmod +x "$FAKE_BIN/opencode"

cat > "$TMP/project/package.json" <<'JSON'
{"name":"page-cache-fixture","dependencies":{"react":"^19.0.0"}}
JSON
cat > "$TMP/project/.jonggrang/jonggrang.json" <<'JSON'
{"name":"page-cache-fixture","project":{"stack":"react"},"tool":"opencode"}
JSON
printf '# Fixture\n' > "$TMP/project/AGENTS.md"
printf ':root { --ui-action: blue; }\n' > "$TMP/project/src/styles/tokens.css"
# Enough evidence for the audit to see an existing UI system, so planning does not
# stop to ask which starter baseline to use.
printf 'export const Button = () => null;\n' > "$TMP/project/src/components/Button.tsx"

# `ui_guide_status: unchanged` means the project guide is the approved one, so it
# has to exist and validate. Borrow the one the lifecycle smoke writes.
cat > "$TMP/project/.jonggrang/UI.md" <<'MD'
---
format: jonggrang-ui-guide/v1
baseline: existing-project
ui_framework: react
token_source: src/styles/tokens.css
token_status: ready
component_source: src/components
storybook: none
references: []
---

# UI guide

## Product and UX rationale
Readers open shared links repeatedly.

## Visual direction and baseline
Keep the existing compact interface.

## Source map
- Tokens: `src/styles/tokens.css`
- Button: `src/components/Button.tsx`

## Token contract, typography, and spacing
Use semantic tokens from the canonical source.

## Components and layout patterns
Reuse `src/components/Button.tsx` for the primary action.

## Interaction, responsive, and accessibility rules
Keep focus visible and preserve input on errors.

## References and verification
Run `npm test`. Storybook: none.

## Rules summary
Reuse local components and semantic tokens first.
MD

export PATH="$FAKE_BIN:$PATH"
export JONGGRANG_SMOKE_CLI="$ROOT/bin/jonggrang.js"
export JONGGRANG_TOOL=opencode

printf '\n== UI keyword guess, non-UI decomposition → still approves ==\n'
(
  cd "$TMP/project"
  git init -q
  git config user.name Smoke
  git config user.email smoke@example.com
  git add .
  git commit -qm 'chore: page cache fixture'
  # A description that genuinely names a UI concern (`theme`), so the classifier is
  # right to flag it and the project's existing guide is used unchanged. The work
  # still turns out to be cache invalidation, so the decomposition needs no UI
  # context — and approval must survive that, not refuse the plan.
  node "$ROOT/bin/jonggrang.js" plan "purge the cached page after a theme change" --yes --no-ask \
    > /tmp/jonggrang-ui-falsepos.log 2>&1
)

grep -q 'approving this as a non-UI plan' /tmp/jonggrang-ui-falsepos.log \
  || { echo 'approval did not report dropping the UI framing' >&2; tail -20 /tmp/jonggrang-ui-falsepos.log >&2; exit 1; }

FEATURE_DIR=$(find "$TMP/project/.jonggrang/.output/features" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$FEATURE_DIR" ] || { echo 'no feature was approved' >&2; exit 1; }
[ -f "$FEATURE_DIR/plan.md" ]
[ -f "$FEATURE_DIR/jonggrang-tasks.json" ]
[ ! -f "$FEATURE_DIR/UI_HANDOFF.md" ] || { echo 'a UI handoff survived on a plan with no UI task' >&2; exit 1; }

node - "$FEATURE_DIR/jonggrang-tasks.json" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const tasks = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).tasks;
assert.equal(tasks.length, 2, 'both tasks survived the approval');
assert.equal(tasks.some(task => task.ui_context), false, 'and none of them pretends to be UI work');
NODE

printf '  ✓ approved into %s with 2 tasks and no UI artefacts\n' "$(basename "$FEATURE_DIR")"
printf '  log: /tmp/jonggrang-ui-falsepos.log\n'
