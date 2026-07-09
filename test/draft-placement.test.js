'use strict';

// Guards for the per-session draft placement safety net (PR #66, fixes the
// karindralinux bug report: plan prompts hardcoded .jonggrang/plan.md so
// multiple drafts overwrote each other at the root).
//
// Two layers are locked here:
//   1. Prompt correctness — every plan-writing builder must reference the
//      per-session draftPath/draftFile variable and must NOT hardcode the
//      legacy root .jonggrang/plan.md. This is the regression class that
//      reopened once already.
//   2. Outcome correctness — verifyDraftWritten() must ensure the draft lands
//      at the session path after the agent runs, self-healing (auto-move from
//      root) when the agent strays, and reporting 'missing' when nothing was
//      written anywhere.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../lib/jonggrang');

// ── Layer 1: prompt builders reference the session path, never the root ──

const FAKE_DRAFT = path.join(os.tmpdir(), 'fake-session', 'plan.md');

test('buildDraftPlanPrompt references draftPath and never the root plan.md', () => {
  const prompt = lib.buildDraftPlanPrompt('a feature', null, os.tmpdir(), FAKE_DRAFT);
  assert.ok(prompt.includes(FAKE_DRAFT), 'prompt must reference the per-session draftPath');
  assert.ok(!prompt.includes('.jonggrang/plan.md'),
    'prompt must not hardcode the legacy root .jonggrang/plan.md');
});

test('buildRevisePlanPrompt references draftFile and never the root plan.md', () => {
  const prompt = lib.buildRevisePlanPrompt('---\nfeature: x\n---\n# plan', 'feedback', FAKE_DRAFT);
  assert.ok(prompt.includes(FAKE_DRAFT), 'prompt must reference the per-session draftFile');
  assert.ok(!prompt.includes('.jonggrang/plan.md'),
    'prompt must not hardcode the legacy root .jonggrang/plan.md');
});

test('buildDeepPlanCondensePrompt references draftPath and never the root plan.md', () => {
  const prompt = lib.buildDeepPlanCondensePrompt('a feature', 'discovery', 'analysis', null, os.tmpdir(), FAKE_DRAFT);
  assert.ok(prompt.includes(FAKE_DRAFT), 'prompt must reference the per-session draftPath');
  assert.ok(!prompt.includes('.jonggrang/plan.md'),
    'prompt must not hardcode the legacy root .jonggrang/plan.md');
});

test('buildDraftPlanPrompt includes base branch instructions and frontmatter entry', () => {
  const prompt = lib.buildDraftPlanPrompt('a feature', null, os.tmpdir(), FAKE_DRAFT, null, { baseBranch: 'my-custom-branch' });
  assert.ok(prompt.includes('base branch `my-custom-branch`'), 'prompt should mention the base branch');
  assert.ok(prompt.includes('base: "my-custom-branch"'), 'prompt should specify the base branch in the frontmatter template');
});

test('buildDeepPlanDiscoveryPrompt includes base branch instructions', () => {
  const prompt = lib.buildDeepPlanDiscoveryPrompt('a feature', null, FAKE_DRAFT, null, { baseBranch: 'my-custom-branch' });
  assert.ok(prompt.includes('base branch `my-custom-branch`'), 'prompt should mention the base branch in discovery');
});

test('buildDeepPlanCondensePrompt includes base branch instructions and frontmatter entry', () => {
  const prompt = lib.buildDeepPlanCondensePrompt('a feature', 'discovery', 'analysis', null, os.tmpdir(), FAKE_DRAFT, null, { baseBranch: 'my-custom-branch' });
  assert.ok(prompt.includes('base branch for this feature is `my-custom-branch`'), 'prompt should mention the base branch in condense');
  assert.ok(prompt.includes('base: "my-custom-branch"'), 'prompt should specify the base branch in the frontmatter template');
});

test('buildPlanQuestionsPrompt includes base branch instructions', () => {
  const prompt = lib.buildPlanQuestionsPrompt('a feature', null, null, 'my-custom-branch');
  assert.ok(prompt.includes('base branch `my-custom-branch`'), 'prompt should mention the base branch in questions');
});

test('buildAppendPlanPrompt includes base branch instructions and frontmatter entry', () => {
  // Scenario 1: Base branch passed through options overrides everything
  const prompt1 = lib.buildAppendPlanPrompt(
    'additional scope',
    '---\nfeature: my-feat\nbase: "old-base"\n---\n# plan',
    [],
    null,
    os.tmpdir(),
    FAKE_DRAFT,
    'my-feat',
    { baseBranch: 'my-custom-branch' }
  );
  assert.ok(prompt1.includes('base branch `my-custom-branch`'), 'prompt should mention the custom base branch');
  assert.ok(prompt1.includes('base: "my-custom-branch"'), 'prompt should specify the custom base branch in the frontmatter template');

  // Scenario 2: Base branch is inherited from the existing plan frontmatter when option is not set
  const prompt2 = lib.buildAppendPlanPrompt(
    'additional scope',
    '---\nfeature: my-feat\nbase: "my-inherited-branch"\n---\n# plan',
    [],
    null,
    os.tmpdir(),
    FAKE_DRAFT,
    'my-feat'
  );
  assert.ok(prompt2.includes('base branch `my-inherited-branch`'), 'prompt should inherit the base branch from the existing plan');
  assert.ok(prompt2.includes('base: "my-inherited-branch"'), 'prompt should specify the inherited base branch in the frontmatter template');
});

// ── Layer 2: verifyDraftWritten self-heals stray agent writes ────────────

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-verify-'));
  fs.mkdirSync(path.join(root, '.jonggrang', '.drafts', 'draft-test'), { recursive: true });
  fs.mkdirSync(path.join(root, '.jonggrang'), { recursive: true });
  return root;
}

test('verifyDraftWritten returns "ok" when the draft is already at the session path', () => {
  const root = tempProject();
  try {
    const draftFile = path.join(root, '.jonggrang', '.drafts', 'draft-test', 'plan.md');
    fs.writeFileSync(draftFile, '# plan v1');
    assert.equal(lib.verifyDraftWritten(root, draftFile), 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyDraftWritten auto-moves a stray root plan.md into the session path', () => {
  const root = tempProject();
  try {
    const draftFile = path.join(root, '.jonggrang', '.drafts', 'draft-test', 'plan.md');
    const rootPlan = path.join(root, '.jonggrang', 'plan.md');
    // Agent wrote to the legacy root instead of the session path.
    fs.writeFileSync(rootPlan, '# plan from root');

    assert.equal(lib.verifyDraftWritten(root, draftFile), 'moved');
    assert.ok(fs.existsSync(draftFile), 'draft must now exist at the session path');
    assert.ok(!fs.existsSync(rootPlan), 'stray root plan.md must be cleaned up');
    assert.equal(fs.readFileSync(draftFile, 'utf8'), '# plan from root',
      'content must be preserved across the move');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyDraftWritten returns "missing" when nothing was written anywhere', () => {
  const root = tempProject();
  try {
    const draftFile = path.join(root, '.jonggrang', '.drafts', 'draft-test', 'plan.md');
    assert.equal(lib.verifyDraftWritten(root, draftFile), 'missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifyDraftWritten does not move an unrelated root plan.md when the draft is present', () => {
  const root = tempProject();
  try {
    const draftFile = path.join(root, '.jonggrang', '.drafts', 'draft-test', 'plan.md');
    const rootPlan = path.join(root, '.jonggrang', 'plan.md');
    fs.writeFileSync(draftFile, '# real session plan');
    fs.writeFileSync(rootPlan, '# unrelated leftover');

    // Draft already present → 'ok'; the stray root file must be left untouched
    // (we only self-heal when the session draft is genuinely missing).
    assert.equal(lib.verifyDraftWritten(root, draftFile), 'ok');
    assert.ok(fs.existsSync(rootPlan), 'existing root plan.md must not be touched');
    assert.equal(fs.readFileSync(draftFile, 'utf8'), '# real session plan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
