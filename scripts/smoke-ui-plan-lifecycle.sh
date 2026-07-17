#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jonggrang-ui-lifecycle.XXXXXX")"
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
feature: alert-console
branch: feat/alert-console
base: "main"
work_type: SMALL
description: Add an operational alert console
created_at: 2026-07-14T00:00:00.000Z
ui: true
ui_guide_status: update proposed
ui_baseline: existing-project
ui_token_status: ready
---

# Plan: Alert Console

## Approach
Reuse the existing React component and semantic token source.

## Phases
1. Add the alert console UI and states.
2. Verify keyboard and error behavior.

## Key Decisions
- Follow existing project evidence rather than restyling it.

## Out of Scope
- New component library.

## Dependencies
Existing Button and token source.
`);
  write(guidePath, `---
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
Operators resolve alerts repeatedly.

## Visual direction and baseline
Keep the existing compact, crisp interface.

## Source map
- Tokens: \`src/styles/tokens.css\`
- Button: \`src/components/Button.tsx\`

## Token contract, typography, and spacing
Use semantic tokens from the canonical source.

## Components and layout patterns
Reuse \`src/components/Button.tsx\` for the primary action.

## Interaction, responsive, and accessibility rules
Keep focus visible and preserve input on errors.

## References and verification
Run \`npm test\`. Storybook: none.

## Rules summary
Reuse local components and semantic tokens first.
`);
  write(handoffPath, `# UI handoff draft: alert console

Guide: .jonggrang/UI.md
Baseline: existing-project
Token source: src/styles/tokens.css (ready)
Guide status: update proposed

## Feature intent
Operators resolve alerts without leaving their queue.

## Shared direction
Reuse the existing button and semantic tokens; keep feedback inline.

## References
- .jonggrang/UI.md#components-and-layout-patterns
- src/components/Button.tsx
`);
  emit(`Draft plan written to ${planPath}\n`);
  process.exit(0);
}

if (prompt.includes('Decompose Approved Plan to Tasks')) {
  const featureId = match(/jonggrang task import --feature ([a-zA-Z0-9._-]+)/, 'feature id');
  const handoffAbsolute = match(/After importing tasks, write the complete handoff to `([^`]+)`/, 'handoff path');
  const digest = match(/Approved guide revision: `([^`]+)`/, 'guide digest');
  const task = [{
    id: 'task-001',
    title: 'Build the operational alert console',
    description: 'Reuse the existing Button and render loading, empty, error, and ready states.',
    priority: 1,
    files: ['src/AlertConsole.tsx'],
    blocked_by: [],
    ui_context: {
      handoff: `.jonggrang/.output/features/${featureId}/UI_HANDOFF.md`,
      sections: ['Feature intent', 'Shared direction', 'Task task-001'],
      guide: '.jonggrang/UI.md',
      guide_revision: digest,
      guide_sections: ['Components and layout patterns', 'Interaction, responsive, and accessibility rules'],
      baseline: 'existing-project',
      read_order: ['handoff', 'guide_sections', 'source_files'],
      on_conflict: 'report UI_GUIDE_DRIFT',
      token_source: 'src/styles/tokens.css',
      source_files: ['src/components/Button.tsx'],
      states: ['loading', 'empty', 'error', 'ready'],
      verification: ['npm test'],
    },
  }];
  const imported = spawnSync(process.execPath, [cli, 'task', 'import', '--feature', featureId, '--input', JSON.stringify(task), '--json'], {
    cwd, env: process.env, encoding: 'utf8',
  });
  if (imported.status !== 0) throw new Error(imported.stderr || imported.stdout || 'task import failed');
  write(handoffAbsolute, `# UI handoff: alert console

Guide: .jonggrang/UI.md
Guide revision: ${digest}
Baseline: existing-project
Token source: src/styles/tokens.css (ready)
Guide status: update proposed

## Feature intent
Operators resolve alerts without leaving their queue.

## Shared direction
Reuse the existing button and semantic tokens; keep feedback inline.

## References
- .jonggrang/UI.md#components-and-layout-patterns
- src/components/Button.tsx

## Task task-001
Objective: render the operational alert console.
Use: existing Button and semantic tokens.
Change: add loading, empty, error, and ready states.
States: loading, empty, error, ready.
Do not: add a component library or raw colors.
Acceptance: keyboard focus stays visible and errors preserve context.
Sources: src/components/Button.tsx.
Check: npm test
`);
  emit('Imported 1 task and wrote UI_HANDOFF.md\n');
  process.exit(0);
}

throw new Error('fake agent received an unexpected prompt');
NODE
chmod +x "$FAKE_BIN/opencode"

cat > "$TMP/project/package.json" <<'JSON'
{"name":"ui-lifecycle","scripts":{"test":"node --test"},"dependencies":{"react":"^19.0.0"}}
JSON
cat > "$TMP/project/.jonggrang/jonggrang.json" <<'JSON'
{"name":"ui-lifecycle","project":{"stack":"react"},"tool":"opencode","mode":{"autonomy":"autonomous"},"work":{"max_iterations":1}}
JSON
printf ':root { --ui-action: blue; }\n' > "$TMP/project/src/styles/tokens.css"
printf 'export const Button = () => null;\n' > "$TMP/project/src/components/Button.tsx"
printf '# Smoke project\n' > "$TMP/project/AGENTS.md"
(
  cd "$TMP/project"
  git init -q
  git config user.name Smoke
  git config user.email smoke@example.com
  git add .
  git commit -qm 'chore: smoke fixture'
)

export PATH="$FAKE_BIN:$PATH"
export JONGGRANG_SMOKE_CLI="$ROOT/bin/jonggrang.js"
export JONGGRANG_TOOL=opencode

printf '\n== Plan → UI sidecars → approve → bounded task ==\n'
(
  cd "$TMP/project"
  node "$ROOT/bin/jonggrang.js" plan "build an operations dashboard alert console" --yes --no-ask >/tmp/jonggrang-ui-lifecycle.log
)

FEATURE_DIR=$(find "$TMP/project/.jonggrang/.output/features" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$FEATURE_DIR" ]
[ -f "$TMP/project/.jonggrang/UI.md" ]
[ -f "$FEATURE_DIR/UI_HANDOFF.md" ]
[ -f "$FEATURE_DIR/jonggrang-tasks.json" ]
[ -f "$FEATURE_DIR/plan.md" ]
[ ! -d "$TMP/project/.jonggrang/.drafts" ] || [ -z "$(find "$TMP/project/.jonggrang/.drafts" -mindepth 1 -maxdepth 1 2>/dev/null)" ]

FEATURE_ID=$(basename "$FEATURE_DIR")
node - "$FEATURE_DIR/jonggrang-tasks.json" "$FEATURE_ID" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const [file, featureId] = process.argv.slice(2);
const tasks = JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
assert.equal(tasks.length, 1);
assert.equal(tasks[0].ui_context.handoff, `.jonggrang/.output/features/${featureId}/UI_HANDOFF.md`);
assert.deepStrictEqual(tasks[0].ui_context.sections, ['Feature intent', 'Shared direction', 'Task task-001']);
NODE

PROMPT=$(cd "$TMP/project" && node "$ROOT/bin/jonggrang.js" work --feature "$FEATURE_ID" --dry-run --max-iterations 1)
grep -q 'UI Task Context (bounded)' <<<"$PROMPT"
grep -q 'Operators resolve alerts without leaving their queue' <<<"$PROMPT"
grep -q 'report `UI_GUIDE_DRIFT`' <<<"$PROMPT"
if grep -q 'Token contract, typography, and spacing' <<<"$PROMPT"; then
  echo 'full guide leaked into task prompt' >&2
  exit 1
fi

printf '  ✓ UI lifecycle approved into %s\n' "$FEATURE_ID"
printf '  ✓ task prompt contains only selected handoff sections\n'
printf '  log: /tmp/jonggrang-ui-lifecycle.log\n'
