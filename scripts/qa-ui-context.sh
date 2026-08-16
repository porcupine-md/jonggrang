#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jonggrang-ui-smoke.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass() { printf '  ✓ %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

mkdir -p "$TMP/.jonggrang/.output/features/feat-alerts" "$TMP/src/components" "$TMP/src/styles"
printf ':root { --ui-action: blue; }\n' > "$TMP/src/styles/tokens.css"
printf 'export const Button = () => null;\n' > "$TMP/src/components/Button.tsx"
cat > "$TMP/package.json" <<'JSON'
{"name":"ui-smoke","scripts":{"test":"node --test"},"dependencies":{"react":"^19.0.0"}}
JSON
cat > "$TMP/.jonggrang/jonggrang.json" <<'JSON'
{"name":"ui-smoke","project":{"stack":"react"},"tool":"jonggrang"}
JSON

section "Baseline catalog and repository audit"
ROOT_UNDER_TEST="$ROOT" PROJECT_UNDER_TEST="$TMP" node <<'NODE'
const assert = require('assert');
const ui = require(process.env.ROOT_UNDER_TEST + '/lib/ui-context');
const packs = ui.validBaselinePacks();
assert.ok(packs.length >= 3);
assert.deepStrictEqual(ui.baselineKeys(), packs.map(p => p.key));
const audit = ui.auditUiProject(process.env.PROJECT_UNDER_TEST, { userRoot: '/nonexistent' });
assert.equal(audit.guide.status, 'missing');
assert.ok(audit.framework.includes('react'));
assert.ok(audit.token_sources.includes('src/styles/tokens.css'));
assert.equal(ui.recommendBaseline('operations dashboard', audit), 'existing-project');
NODE
pass "valid dynamic packs load; local UI evidence wins over a starter"

section "Approved guide, handoff, and task import"
cat > "$TMP/.jonggrang/UI.md" <<'MD'
---
format: jonggrang-ui-guide/v1
baseline: dashboard-operational@1
ui_framework: react
token_source: src/styles/tokens.css
token_status: ready
component_source: src/components
storybook: none
references: []
---

# UI guide

## Product and UX rationale
Operators resolve alerts repeatedly.
## Visual direction and baseline
Dense, crisp, and quiet.
## Source map
- `src/styles/tokens.css`
- `src/components/Button.tsx`
## Token contract, typography, and spacing
Use semantic tokens.
## Components and layout patterns
Reuse `src/components/Button.tsx`.
## Interaction, responsive, and accessibility rules
Keep focus visible and errors inline.
## References and verification
Run `npm test`.
## Rules summary
Reuse local components first.
MD

DIGEST=$(PROJECT_UNDER_TEST="$TMP" ROOT_UNDER_TEST="$ROOT" node <<'NODE'
const fs = require('fs');
const ui = require(process.env.ROOT_UNDER_TEST + '/lib/ui-context');
process.stdout.write(ui.contentDigest(fs.readFileSync(process.env.PROJECT_UNDER_TEST + '/.jonggrang/UI.md', 'utf8')));
NODE
)
cat > "$TMP/.jonggrang/.output/features/feat-alerts/UI_HANDOFF.md" <<MD
# UI handoff: alerts

Guide: .jonggrang/UI.md
Guide revision: $DIGEST
Baseline: dashboard-operational@1
Token source: src/styles/tokens.css (ready)
Guide status: unchanged

## Feature intent
Operators save alert preferences without leaving their queue.

## Shared direction
Reuse the local button and show feedback inline.

## References
- .jonggrang/UI.md#components-and-layout-patterns
- src/components/Button.tsx

## Task task-001
Objective: save alert preferences.
Use: existing Button.
Change: submit without navigation.
States: loading, saved, save-error.
Do not: add a toast system.
Acceptance: focus stays visible and errors remain inline.
Sources: src/components/Button.tsx.
Check: npm test
MD

TASKS=$(cat <<JSON
[{"id":"task-001","title":"Save alert preferences","description":"Persist the form and render inline feedback.","priority":1,"files":["src/Alerts.tsx"],"blocked_by":[],"ui_context":{"handoff":".jonggrang/.output/features/feat-alerts/UI_HANDOFF.md","sections":["Feature intent","Shared direction","Task task-001"],"guide":".jonggrang/UI.md","guide_revision":"$DIGEST","guide_sections":["Components and layout patterns","Interaction, responsive, and accessibility rules"],"baseline":"dashboard-operational@1","read_order":["handoff","guide_sections","source_files"],"on_conflict":"report UI_GUIDE_DRIFT","token_source":"src/styles/tokens.css","source_files":["src/components/Button.tsx"],"states":["loading","saved","save-error"],"verification":["npm test"]}}]
JSON
)
(cd "$TMP" && node "$ROOT/bin/jonggrang.js" task import --feature feat-alerts --input "$TASKS" --json >/dev/null)
pass "CLI preserves ui_context in per-feature task state"

section "Delivery validation and bounded prompt"
ROOT_UNDER_TEST="$ROOT" PROJECT_UNDER_TEST="$TMP" EXPECTED_DIGEST="$DIGEST" node <<'NODE'
const assert = require('assert');
const fs = require('fs');
const ui = require(process.env.ROOT_UNDER_TEST + '/lib/ui-context');
const lib = require(process.env.ROOT_UNDER_TEST + '/lib/jonggrang');
const root = process.env.PROJECT_UNDER_TEST;
const guide = fs.readFileSync(root + '/.jonggrang/UI.md', 'utf8');
const guideCheck = ui.validateUiGuide(root, guide, { allowPlanned: false });
assert.equal(guideCheck.valid, true, guideCheck.errors.join('; '));
const tasksFile = root + '/.jonggrang/.output/features/feat-alerts/jonggrang-tasks.json';
const tasks = lib.getTasks(tasksFile).tasks;
const delivery = ui.validateUiHandoff(root, ui.featureHandoffPath(root, 'feat-alerts'), tasks, {
  featureId: 'feat-alerts', guideDigest: process.env.EXPECTED_DIGEST,
  baseline: 'dashboard-operational@1', tokenStatus: 'ready', guideContent: guide,
});
assert.equal(delivery.valid, true, delivery.errors.join('; '));
const prompt = lib.buildWorkPrompt('task-001', tasksFile, 'execute');
assert.match(prompt, /UI Task Context \(bounded\)/);
assert.match(prompt, /Operators save alert preferences/);
assert.match(prompt, /UI_GUIDE_DRIFT/);
assert.doesNotMatch(prompt, /Token contract, typography, and spacing\nUse semantic tokens/);
NODE
pass "guide/handoff/task contract validates and work prompt stays bounded"

section "Planned token foundation promotes atomically on task done"
mkdir -p "$TMP/.jonggrang/.output/features/feat-foundation"
python3 - "$TMP/.jonggrang/UI.md" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text().replace('token_source: src/styles/tokens.css', 'token_source: src/styles/new-tokens.css')
s = s.replace('token_status: ready', 'token_status: planned\ntoken_owner_task: task-001')
s = s.replace('`src/styles/tokens.css`', '`src/styles/new-tokens.css`')
p.write_text(s)
PY
PLANNED_DIGEST=$(PROJECT_UNDER_TEST="$TMP" ROOT_UNDER_TEST="$ROOT" node <<'NODE'
const fs = require('fs');
const ui = require(process.env.ROOT_UNDER_TEST + '/lib/ui-context');
process.stdout.write(ui.contentDigest(fs.readFileSync(process.env.PROJECT_UNDER_TEST + '/.jonggrang/UI.md', 'utf8')));
NODE
)
cat > "$TMP/.jonggrang/.output/features/feat-foundation/UI_HANDOFF.md" <<MD
# UI handoff: foundation

Guide: .jonggrang/UI.md
Guide revision: $PLANNED_DIGEST
Baseline: dashboard-operational@1
Token source: src/styles/new-tokens.css (planned)
Guide status: update proposed

## Feature intent
Establish the approved UI foundation.
## Shared direction
Use the approved semantic token contract.
## References
- .jonggrang/UI.md#token-contract-typography-and-spacing
## Task task-001
Objective: create the token source.
Use: approved baseline template.
Change: materialize semantic tokens.
States: ready.
Do not: add component-local raw values.
Acceptance: token source exists.
Sources: src/styles/new-tokens.css.
Check: npm test
MD
FOUNDATION_TASKS=$(cat <<JSON
[{"id":"task-001","title":"Create UI token foundation","files":["src/styles/new-tokens.css"],"ui_context":{"foundation":true,"handoff":".jonggrang/.output/features/feat-foundation/UI_HANDOFF.md","sections":["Feature intent","Shared direction","Task task-001"],"guide":".jonggrang/UI.md","guide_revision":"$PLANNED_DIGEST","guide_sections":["Token contract, typography, and spacing"],"baseline":"dashboard-operational@1","read_order":["handoff","guide_sections","source_files"],"on_conflict":"report UI_GUIDE_DRIFT","token_source":"src/styles/new-tokens.css","source_files":["src/styles/new-tokens.css"],"states":["ready"],"verification":["npm test"]}}]
JSON
)
(cd "$TMP" && node "$ROOT/bin/jonggrang.js" task import --feature feat-foundation --input "$FOUNDATION_TASKS" --json >/dev/null)
printf ':root { --ui-action: blue; }\n' > "$TMP/src/styles/new-tokens.css"
(cd "$TMP" && node "$ROOT/bin/jonggrang.js" task done task-001 --feature feat-foundation --json >/dev/null)
grep -q 'token_status: ready' "$TMP/.jonggrang/UI.md"
grep -q 'Token source: src/styles/new-tokens.css (ready)' "$TMP/.jonggrang/.output/features/feat-foundation/UI_HANDOFF.md"
pass "task completion verifies the source and promotes guide, handoff, and task digest"

section "Drift fails closed"
printf '\n## Task task-999\nUNRELATED\n' >> "$TMP/.jonggrang/.output/features/feat-alerts/UI_HANDOFF.md"
ROOT_UNDER_TEST="$ROOT" PROJECT_UNDER_TEST="$TMP" node <<'NODE'
const assert = require('assert');
const ui = require(process.env.ROOT_UNDER_TEST + '/lib/ui-context');
const prompt = ui.buildTaskUiPrompt(process.env.PROJECT_UNDER_TEST, {
  id: 'task-001', ui_context: {
    handoff: '.jonggrang/.output/features/feat-alerts/UI_HANDOFF.md',
    sections: ['Feature intent', 'Shared direction', 'Task task-001'],
    guide: '.jonggrang/UI.md', guide_sections: [], source_files: [], states: [], verification: [],
    on_conflict: 'report UI_GUIDE_DRIFT',
  },
});
assert.doesNotMatch(prompt, /UNRELATED/);
assert.match(prompt, /report `UI_GUIDE_DRIFT`/);
NODE
pass "unselected task text is excluded; conflicts instruct UI_GUIDE_DRIFT"

printf '\nUI context smoke passed: %s\n' "$TMP"
