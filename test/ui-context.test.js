'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ui = require('../lib/ui-context');
const lib = require('../lib/jonggrang');

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jonggrang-ui-'));
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init'], { cwd: root, stdio: 'ignore' });
  fs.mkdirSync(path.join(root, '.jonggrang', '.output', 'features', 'feat-ui'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'styles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'styles', 'tokens.css'), ':root { --ui-action: blue; }\n');
  fs.writeFileSync(path.join(root, 'src', 'components', 'Button.tsx'), 'export const Button = () => null;\n');
  return root;
}

// The default baseline catalog merges the built-in packs with the user's
// personal design store (designCatalogPath — ~/.jonggrang/design by default).
// Unit tests must not depend on what a developer has installed there: a
// personal pack that predates the built-in `avoid` contract (this machine's
// `ans-lab` has no avoid list at all) made the "every default pack carries a
// do-not list" assertion fail locally while CI — with a fresh HOME — stayed
// green. Point the design catalog at an empty temp dir so the file is hermetic.
process.env.JONGGRANG_DESIGN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-ui-design-'));

function guide(overrides = {}) {
  const baseline = overrides.baseline || 'dashboard-operational@1';
  const tokenSource = overrides.tokenSource || 'src/styles/tokens.css';
  const tokenStatus = overrides.tokenStatus || 'ready';
  const owner = overrides.owner ? `token_owner_task: ${overrides.owner}\n` : '';
  return `---
format: jonggrang-ui-guide/v1
baseline: ${baseline}
ui_framework: react
component_source: src/components
token_source: ${tokenSource}
token_status: ${tokenStatus}
${owner}storybook: none
references: []
---

# UI guide

## Product and UX rationale
Operators resolve exceptions.

## Visual direction and baseline
Dense, crisp, and quiet.

## Source map
- Tokens: \`src/styles/tokens.css\`
- Components: \`src/components/\`

## Token contract, typography, and spacing
Use semantic tokens.

## Components and layout patterns
### Button
Source: \`src/components/Button.tsx\`.

## Interaction, responsive, and accessibility rules
Keep focus visible.

## References and verification
Run npm test.

## Rules summary
Reuse local components.
`;
}

function handoff(digest, extra = '') {
  return `# UI handoff: settings

Guide: .jonggrang/UI.md
Guide revision: ${digest}
Baseline: dashboard-operational@1
Token source: src/styles/tokens.css (ready)
Guide status: unchanged

## Feature intent
Operators change alert settings.

## Shared direction
Reuse the existing button.

## References
- .jonggrang/UI.md#components-and-layout-patterns
- src/components/Button.tsx

## Task task-001
Objective: save settings.
Use: existing Button.
Change: wire save.
States: loading, saved, error.
Do not: add a toast system.
Acceptance: focus remains visible.
Sources: src/components/Button.tsx.
Check: npm test

${extra}`;
}

(function baselineCatalogIsDynamicAndVersioned() {
  const packs = ui.validBaselinePacks();
  assert.deepStrictEqual(ui.baselineKeys(), packs.map(pack => pack.key));
  assert.ok(packs.length >= 3);
  assert.ok(packs.every(pack => Array.isArray(pack.avoid) && pack.avoid.length >= 4));
  for (const pack of packs) {
    const loaded = ui.loadBaselinePack(pack.key);
    assert.equal(`${loaded.manifest.id}@${loaded.manifest.version}`, pack.key);
    assert.match(loaded.guideFragment, /## Visual direction and baseline/);
    assert.match(loaded.tokenTemplate, /--ui-action:/);
    assert.match(loaded.semanticTokenContract, /semantic roles/i);
  }

  const catalog = tempRoot();
  fs.mkdirSync(path.join(catalog, 'core'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'core', 'guide-sections.md'), 'guide sections');
  fs.writeFileSync(path.join(catalog, 'core', 'semantic-token-contract.md'), 'semantic roles');
  const packDir = path.join(catalog, 'form-workflow');
  fs.mkdirSync(packDir);
  fs.writeFileSync(path.join(packDir, 'manifest.yml'), `id: form-workflow
version: 1
intent: Focused data-entry workflows.
product_shapes: [form]
recommend_keywords: [workflow, intake]
recommend_priority: 5
guide_fragment: guide-fragment.md
token_template: tokens.css.template
`);
  fs.writeFileSync(path.join(packDir, 'guide-fragment.md'), '## Visual direction and baseline\nFocused forms.');
  fs.writeFileSync(path.join(packDir, 'tokens.css.template'), ':root { --ui-action: blue; }');

  assert.deepStrictEqual(ui.baselineKeys(catalog), ['form-workflow@1']);
  assert.equal(ui.recommendBaseline('create an intake workflow', {}, ui.validBaselinePacks(catalog)), 'form-workflow@1');
  assert.equal(ui.loadBaselinePack('form-workflow@1', catalog).key, 'form-workflow@1');
  assert.deepStrictEqual(
    ui.buildUiPreferenceQuestion({ baseline: null, availableBaselines: ui.baselineKeys(catalog) }).options.map(option => option.value),
    ['use:form-workflow@1', 'no-starter'],
  );

  fs.cpSync(packDir, path.join(catalog, 'form-workflow-copy'), { recursive: true });
  assert.deepStrictEqual(ui.baselineKeys(catalog), [], 'duplicate id@version entries must fail closed');
})();

(function detectsUiWorkAndRecommendsProductShape() {
  assert.equal(ui.detectUiWork('Add a keyboard-accessible settings dialog'), true);
  assert.equal(ui.detectUiWork('Add database retry handling'), false);
  assert.equal(ui.recommendBaseline('Build a focused campaign landing page'), 'landing-page-minimalist@1');
  assert.equal(ui.recommendBaseline('Create an operations dashboard'), 'dashboard-operational@1');
  assert.equal(ui.recommendBaseline('Build an Expo mobile app'), 'mobile-app-minimalist@1');
})();

(function auditsLocalEvidenceWithoutInventingOptionalTools() {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { react: '^19.0.0' },
    scripts: { test: 'node --test' },
  }));
  const audit = ui.auditUiProject(root, { userRoot: path.join(root, 'missing-home') });
  assert.deepStrictEqual(audit.framework, ['react']);
  assert.ok(audit.token_sources.includes('src/styles/tokens.css'));
  assert.ok(audit.components.includes('src/components/Button.tsx'));
  assert.deepStrictEqual(audit.references, []);
  assert.equal(audit.guide.status, 'missing');

  fs.unlinkSync(path.join(root, 'src/styles/tokens.css'));
  fs.writeFileSync(path.join(root, 'src/main.js'), 'import { createApp } from "vue";\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
  const withoutTokens = ui.auditUiProject(root, { userRoot: path.join(root, 'missing-home') });
  assert.ok(!withoutTokens.token_sources.includes('src/main.js'));
  assert.equal(ui.recommendBaseline('add a settings form', withoutTokens), null);
})();

(function validatesGuideContract() {
  const root = tempRoot();
  const valid = ui.validateUiGuide(root, guide(), { allowPlanned: false });
  assert.equal(valid.valid, true, valid.errors.join('; '));
  const invalid = ui.validateUiGuide(root, guide().replace('## Rules summary', '## Notes'), { allowPlanned: false });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.includes('missing section: Rules summary'));
  const planned = ui.validateUiGuide(root, guide({ tokenSource: 'src/styles/new-tokens.css', tokenStatus: 'planned', owner: 'task-001' }), { allowPlanned: false });
  assert.equal(planned.valid, true, planned.errors.join('; '));
  const escaping = ui.validateUiGuide(root, guide({ tokenSource: '../../outside.css', tokenStatus: 'planned', owner: 'task-001' }), { allowPlanned: false });
  assert.equal(escaping.valid, false);
  assert.ok(escaping.errors.some(error => error.includes('escapes project root')));

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jonggrang-ui-outside-'));
  fs.symlinkSync(outside, path.join(root, 'src', 'linked-outside'));
  const symlinkEscape = ui.validateUiGuide(root, guide({ tokenSource: 'src/linked-outside/tokens.css', tokenStatus: 'planned', owner: 'task-001' }), { allowPlanned: false });
  assert.equal(symlinkEscape.valid, false);
  assert.ok(symlinkEscape.errors.some(error => error.includes('escapes project root')));
  fs.rmSync(outside, { recursive: true, force: true });
})();

(function asksForPreferenceBeforeApplyingAStarterPack() {
  const root = tempRoot();
  const audit = {
    guide: { status: 'missing' }, user_guide: null,
    token_sources: [], components: [], framework: [],
  };
  const planning = ui.buildPlanningContext(root, 'draft-ui', 'operations dashboard', audit);
  assert.equal(planning.baseline, 'dashboard-operational@1');
  assert.equal(planning.requiresBaselineConsent, true);
  assert.equal(planning.preferenceQuestion.id, 'ui-preference');
  assert.match(planning.prompt, /not permission to apply it/i);
  assert.match(planning.prompt, /--ui-action:/);

  const custom = ui.resolveUiPreference(planning, {
    answers: [{ id: 'ui-preference', value: '__freetext__', freetext: 'Use our Figma file at https://example.com/design' }],
  });
  assert.equal(custom.baseline, 'existing-project');
  assert.equal(custom.baselinePack, null);
  assert.match(custom.prompt, /Do not copy any starter guide fragment/);
  assert.doesNotMatch(custom.prompt, /--ui-row-height:/);

  const explicit = ui.buildPlanningContext(root, 'draft-explicit', 'use dashboard-operational@1', audit);
  assert.equal(explicit.requiresBaselineConsent, false);
  assert.match(explicit.prompt, /Approved starter baseline/);

  const personal = ui.buildPlanningContext(root, 'draft-personal', 'operations dashboard', {
    ...audit,
    user_guide: path.join(root, 'personal-UI.md'),
  });
  assert.equal(personal.baseline, 'existing-project');
  assert.equal(personal.baselinePack, null);
  assert.equal(personal.requiresBaselineConsent, false);

  const uncertain = ui.buildPlanningContext(root, 'draft-uncertain', 'add a settings form', audit);
  assert.equal(uncertain.baseline, null);
  assert.equal(uncertain.requiresBaselineConsent, true);
  assert.deepStrictEqual(
    uncertain.preferenceQuestion.options.slice(0, -1).map(option => option.value),
    ui.baselineKeys().map(id => `use:${id}`),
  );
  const selected = ui.resolveUiPreference(uncertain, {
    answers: [{ id: 'ui-preference', value: 'use:mobile-app-minimalist@1', freetext: null }],
  });
  assert.equal(selected.baseline, 'mobile-app-minimalist@1');
  assert.match(selected.prompt, /Approved starter baseline/);
  assert.match(selected.prompt, /--ui-target-min: 2\.75rem/);
})();

(function extractsSectionsWithoutLeakingFencedHeadings() {
  const markdown = '## One\ntext\n```md\n## Fake\n```\n## Two\nend\n';
  assert.equal(ui.extractMarkdownSection(markdown, 'One'), '## One\ntext\n```md\n## Fake\n```');
  assert.equal(ui.extractMarkdownSection(markdown, 'Fake'), '');
})();

(function injectsOnlySelectedHandoffSections() {
  const root = tempRoot();
  const guideContent = guide();
  const digest = ui.contentDigest(guideContent);
  fs.writeFileSync(ui.projectGuidePath(root), guideContent);
  const hp = ui.featureHandoffPath(root, 'feat-ui');
  fs.writeFileSync(hp, handoff(digest, '## Task task-002\nSECRET UNRELATED TASK\n'));
  const task = {
    id: 'task-001',
    feature_id: 'feat-ui',
    files: [],
    ui_context: {
      handoff: '.jonggrang/.output/features/feat-ui/UI_HANDOFF.md',
      sections: ['Feature intent', 'Shared direction', 'Task task-001'],
      guide: '.jonggrang/UI.md',
      guide_revision: digest,
      guide_sections: ['Components and layout patterns'],
      baseline: 'dashboard-operational@1',
      read_order: ['handoff', 'guide_sections', 'source_files'],
      on_conflict: 'report UI_GUIDE_DRIFT',
      token_source: 'src/styles/tokens.css',
      source_files: ['src/components/Button.tsx'],
      states: ['loading', 'saved', 'error'],
      verification: ['npm test'],
    },
  };
  const prompt = ui.buildTaskUiPrompt(root, task);
  assert.match(prompt, /UI Task Context \(bounded\)/);
  assert.match(prompt, /Operators change alert settings/);
  assert.match(prompt, /Objective: save settings/);
  assert.doesNotMatch(prompt, /SECRET UNRELATED TASK/);
  assert.doesNotMatch(prompt, /Token contract, typography/);
  assert.match(prompt, /UI_GUIDE_DRIFT/);

  const validated = ui.validateUiHandoff(root, hp, [task], {
    featureId: 'feat-ui', guideDigest: digest,
    baseline: 'dashboard-operational@1', tokenStatus: 'ready', guideContent,
  });
  assert.equal(validated.valid, true, validated.errors.join('; '));
})();

(function enforcesFoundationDependencyForPlannedTokens() {
  const root = tempRoot();
  const guideContent = guide({ tokenSource: 'src/styles/new-tokens.css', tokenStatus: 'planned', owner: 'task-001' });
  const digest = ui.contentDigest(guideContent);
  const hp = ui.featureHandoffPath(root, 'feat-ui');
  fs.writeFileSync(hp, handoff(digest).replace('src/styles/tokens.css (ready)', 'src/styles/new-tokens.css (planned)') + '\n## Task task-002\nObjective: render UI.\n');
  const baseContext = {
    handoff: '.jonggrang/.output/features/feat-ui/UI_HANDOFF.md',
    guide: '.jonggrang/UI.md', guide_revision: digest,
    guide_sections: ['Components and layout patterns'], baseline: 'dashboard-operational@1',
    read_order: ['handoff', 'guide_sections', 'source_files'], on_conflict: 'report UI_GUIDE_DRIFT',
    token_source: 'src/styles/new-tokens.css', states: ['ready'], verification: ['npm test'],
  };
  const foundation = {
    id: 'task-001', files: ['src/styles/new-tokens.css'], blocked_by: [],
    ui_context: { ...baseContext, foundation: true, sections: ['Feature intent', 'Shared direction', 'Task task-001'], source_files: ['src/styles/new-tokens.css'] },
  };
  const dependent = {
    id: 'task-002', files: [], blocked_by: [],
    ui_context: { ...baseContext, sections: ['Feature intent', 'Shared direction', 'Task task-002'], source_files: ['src/components/Button.tsx'] },
  };
  const invalid = ui.validateUiHandoff(root, hp, [foundation, dependent], {
    featureId: 'feat-ui', guideDigest: digest, baseline: 'dashboard-operational@1',
    tokenStatus: 'planned', guideContent,
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => error.includes('must be blocked by UI-foundation')));
  dependent.blocked_by = ['task-001'];
  const valid = ui.validateUiHandoff(root, hp, [foundation, dependent], {
    featureId: 'feat-ui', guideDigest: digest, baseline: 'dashboard-operational@1',
    tokenStatus: 'planned', guideContent,
  });
  assert.equal(valid.valid, true, valid.errors.join('; '));

  const template = ui.loadBaselinePack('dashboard-operational@1').tokenTemplate.trim();
  const missingTemplate = ui.validateUiHandoff(root, hp, [foundation, dependent], {
    featureId: 'feat-ui', guideDigest: digest, baseline: 'dashboard-operational@1',
    tokenStatus: 'planned', tokenTemplate: template, guideContent,
  });
  assert.equal(missingTemplate.valid, false);
  const handoffWithTemplate = fs.readFileSync(hp, 'utf8').replace(
    '\n## Task task-002',
    `\n\`\`\`css\n${template}\n\`\`\`\n\n## Task task-002`,
  );
  fs.writeFileSync(hp, handoffWithTemplate);
  const withTemplate = ui.validateUiHandoff(root, hp, [foundation, dependent], {
    featureId: 'feat-ui', guideDigest: digest, baseline: 'dashboard-operational@1',
    tokenStatus: 'planned', tokenTemplate: template, guideContent,
  });
  assert.equal(withTemplate.valid, true, withTemplate.errors.join('; '));
})();

(function transactionRestoresEveryFileWhenAReplacementFails() {
  const root = tempRoot();
  const files = ['one', 'two', 'three'].map(name => path.join(root, `${name}.txt`));
  for (const file of files) fs.writeFileSync(file, `old:${path.basename(file)}\n`);
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  let renames = 0;
  assert.throws(() => ui.writeFilesTransaction(
    files.map(file => ({ file, content: `new:${path.basename(file)}\n` })),
    {
      renameSync(from, to) {
        renames += 1;
        if (renames === 5) throw new Error('injected rename failure');
        fs.renameSync(from, to);
      },
    },
  ), /injected rename failure/);
  assert.deepStrictEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.deepStrictEqual(fs.readdirSync(root).filter(file => /\.(?:tmp|bak)\./.test(file)), []);
})();

(function foundationCompletionPromotesGuideHandoffAndTaskRevisions() {
  const root = tempRoot();
  const plannedGuide = guide({ tokenSource: 'src/styles/new-tokens.css', tokenStatus: 'planned', owner: 'task-001' });
  const initialDigest = ui.contentDigest(plannedGuide);
  fs.writeFileSync(ui.projectGuidePath(root), plannedGuide);
  const hp = ui.featureHandoffPath(root, 'feat-ui');
  fs.writeFileSync(hp, handoff(initialDigest).replace('src/styles/tokens.css (ready)', 'src/styles/new-tokens.css (planned)'));
  const context = {
    foundation: true,
    handoff: '.jonggrang/.output/features/feat-ui/UI_HANDOFF.md',
    sections: ['Feature intent', 'Shared direction', 'Task task-001'],
    guide: '.jonggrang/UI.md', guide_revision: initialDigest,
    guide_sections: ['Components and layout patterns'], baseline: 'dashboard-operational@1',
    read_order: ['handoff', 'guide_sections', 'source_files'], on_conflict: 'report UI_GUIDE_DRIFT',
    token_source: 'src/styles/new-tokens.css', source_files: ['src/styles/new-tokens.css'],
    states: ['ready'], verification: ['npm test'],
  };
  lib.writeJSON(lib.tasksFileFor(root, 'feat-ui'), { tasks: [{ id: 'task-001', ui_context: context }] });
  fs.writeFileSync(path.join(root, 'src/styles/new-tokens.css'), ':root {}\n');
  const result = ui.promoteUiFoundation(root, 'feat-ui', 'task-001');
  const promotedGuide = fs.readFileSync(ui.projectGuidePath(root), 'utf8');
  assert.match(promotedGuide, /token_status: ready/);
  assert.equal(result.guideRevision, ui.contentDigest(promotedGuide));
  assert.match(fs.readFileSync(hp, 'utf8'), new RegExp(`Guide revision: ${result.guideRevision}`));
  assert.match(fs.readFileSync(hp, 'utf8'), /Token source: src\/styles\/new-tokens\.css \(ready\)/);
  assert.equal(lib.getTask(lib.tasksFileFor(root, 'feat-ui'), 'task-001').ui_context.guide_revision, result.guideRevision);
})();

(function taskSchemaAndPromptsCarryUiContext() {
  const root = tempRoot();
  const context = { handoff: 'x', sections: [] };
  const [created] = lib.addTasksBulk(root, 'feat-ui', [{ title: 'UI task', ui_context: context }]);
  assert.deepStrictEqual(created.ui_context, context);
  const planning = ui.buildPlanningContext(root, 'draft-a', 'operations dashboard', ui.auditUiProject(root));
  const prompt = lib.buildDraftPlanPrompt('operations dashboard', null, root, path.join(root, 'plan.md'), null, { ui: planning });
  assert.match(prompt, /ui: true/);
  assert.match(prompt, /UI_HANDOFF\.md/);
  const taskPrompt = lib.buildTasksFromPlanPrompt('# Plan', null, root, 'feat-ui', null, {
    ui: {
      guideContent: guide(), guideRevision: 'sha256:test', baseline: 'dashboard-operational@1',
      tokenSource: 'src/styles/tokens.css', tokenStatus: 'ready', handoffDraftContent: '# draft',
      handoffPath: '.jonggrang/.output/features/feat-ui/UI_HANDOFF.md',
      handoffAbsolutePath: ui.featureHandoffPath(root, 'feat-ui'),
    },
  });
  assert.match(taskPrompt, /ui_context/);
  assert.match(taskPrompt, /Objective,\nUse, Change, States, Do not, Acceptance, Sources, and Check/);

  const pack = ui.loadBaselinePack('dashboard-operational@1');
  const plannedTaskPrompt = lib.buildTasksFromPlanPrompt('# Plan', null, root, 'feat-ui', null, {
    ui: {
      guideContent: guide({ tokenSource: 'src/styles/new-tokens.css', tokenStatus: 'planned' }),
      guideRevision: 'sha256:test', baseline: 'dashboard-operational@1',
      tokenSource: 'src/styles/new-tokens.css', tokenStatus: 'planned',
      baselineTokenTemplate: pack.tokenTemplate, handoffDraftContent: '# draft',
      handoffPath: '.jonggrang/.output/features/feat-ui/UI_HANDOFF.md',
      handoffAbsolutePath: ui.featureHandoffPath(root, 'feat-ui'),
    },
  });
  assert.match(plannedTaskPrompt, /must copy this exact/);
  assert.match(plannedTaskPrompt, /--ui-row-height: 2\.25rem/);

  const deepPrompt = lib.buildDeepPlanAnalysisPrompt(
    'operations dashboard',
    '# Discovery',
    path.join(root, 'analysis.md'),
    null,
    { ui: { prompt: 'UI planning contract' } },
  );
  assert.match(deepPrompt, /```\n\nUI planning contract\n\n## Your Task/);
})();

console.log('ui-context tests: ok');
