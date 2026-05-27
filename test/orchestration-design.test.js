'use strict';
const assert = require('assert');
const o = require('../lib/orchestration');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\norchestration.js — design flow\n');

// ── classifyHasUi ─────────────────────────────────────────────
test('classifyHasUi: true for frontend/UI keywords', () => {
  assert.strictEqual(o.classifyHasUi('Build a settings page with a form and modal'), true);
  assert.strictEqual(o.classifyHasUi('Add a React dashboard component'), true);
});
test('classifyHasUi: false for pure backend work', () => {
  assert.strictEqual(o.classifyHasUi('Add a webhook handler and a queue worker'), false);
  assert.strictEqual(o.classifyHasUi('Optimize the database migration'), false);
});
test('classifyHasUi: hint overrides heuristic', () => {
  assert.strictEqual(o.classifyHasUi('Add a queue worker', { hasUi: true }), true);
  assert.strictEqual(o.classifyHasUi('Build a UI page', { hasUi: false }), false);
});

// ── phase constants ───────────────────────────────────────────
test('design phase constants are fractional and registered in PHASES', () => {
  assert.strictEqual(o.DESIGN_SYSTEM_PHASE, 6.5);
  assert.strictEqual(o.DESIGN_VERIFY_UI_PHASE, 11.5);
  assert.ok(o.PHASES[6.5] && o.PHASES[6.5].name === 'design-system');
  assert.ok(o.PHASES[11.5] && o.PHASES[11.5].name === 'design-verify-ui');
});

// ── getActivePhases gating ────────────────────────────────────
test('getActivePhases: excludes design phases when hasUi is false', () => {
  const phases = o.getActivePhases('MEDIUM', { hasUi: false });
  assert.ok(!phases.includes(6.5));
  assert.ok(!phases.includes(11.5));
});
test('getActivePhases: includes design phases when hasUi is true', () => {
  const phases = o.getActivePhases('MEDIUM', { hasUi: true });
  assert.ok(phases.includes(6.5));
  assert.ok(phases.includes(11.5));
  // ordering: 6.5 sits between 6 and 7; 11.5 between 11 and 12
  assert.ok(phases.indexOf(6.5) > phases.indexOf(6));
  assert.ok(phases.indexOf(6.5) < phases.indexOf(7));
  assert.ok(phases.indexOf(11.5) > phases.indexOf(11));
  assert.ok(phases.indexOf(11.5) < phases.indexOf(12));
});
test('getActivePhases: default (no opts) excludes design phases — backward compatible', () => {
  const phases = o.getActivePhases('MEDIUM');
  assert.ok(!phases.includes(6.5));
  assert.ok(!phases.includes(11.5));
});

// ── prompt builders ───────────────────────────────────────────
const manifestStub = {
  feature_id: 'settings-page-abc', description: 'Build a settings page', work_type: 'MEDIUM',
  has_ui: true, design_artifact: './DESIGN.md', active_phases: [6.5, 7, 8, 11.5],
  phases: { 6.5: { name: 'design-system', status: 'pending' }, 11.5: { name: 'design-verify-ui', status: 'pending' } },
};
test('buildDesignSystemPrompt mentions DESIGN.md, lint, Designer, and DESIGN_COMPLETE', () => {
  const p = o.buildDesignSystemPrompt(manifestStub, process.cwd());
  assert.match(p, /DESIGN\.md/);
  assert.match(p, /DESIGN_COMPLETE/);
  assert.match(p, /lint/i);
  assert.match(p, /Designer/);
});
test('buildDesignVerifyUiPrompt mentions token compliance and DESIGN_UI_VERIFIED', () => {
  const p = o.buildDesignVerifyUiPrompt(manifestStub, process.cwd());
  assert.match(p, /DESIGN_UI_VERIFIED/);
  assert.match(p, /DESIGN\.md/);
  assert.match(p, /token/i);
});

process.exit(failed === 0 ? 0 : 1);
