'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const fb = require('../lib/feedback');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jg-fb-'));
}

console.log('\nfeedback.js — design gate\n');

test('frontend with hasUi requires design=PASS to exit', () => {
  const root = tmpRoot();
  fb.activateFeedbackLoop(root, 'frontend', { hasUi: true });
  fb.recordPhaseResult(root, 'frontend', 'review', 'PASS', 'reviewer');
  fb.recordPhaseResult(root, 'frontend', 'testing', 'PASS', 'tester');
  let gate = fb.checkExitGate(root);
  assert.strictEqual(gate.allowed, false, 'should block: design still PENDING');
  fb.recordPhaseResult(root, 'frontend', 'design', 'PASS', 'designer');
  gate = fb.checkExitGate(root);
  assert.strictEqual(gate.allowed, true, 'should allow: all three gates PASS');
});

test('backend domain unaffected — review+testing only', () => {
  const root = tmpRoot();
  fb.activateFeedbackLoop(root, 'backend');
  fb.recordPhaseResult(root, 'backend', 'review', 'PASS', 'reviewer');
  fb.recordPhaseResult(root, 'backend', 'testing', 'PASS', 'tester');
  const gate = fb.checkExitGate(root);
  assert.strictEqual(gate.allowed, true);
});

test('design FAIL resets and blocks exit', () => {
  const root = tmpRoot();
  fb.activateFeedbackLoop(root, 'frontend', { hasUi: true });
  fb.recordPhaseResult(root, 'frontend', 'review', 'PASS', 'reviewer');
  fb.recordPhaseResult(root, 'frontend', 'testing', 'PASS', 'tester');
  const { allPassed } = fb.recordPhaseResult(root, 'frontend', 'design', 'FAIL', 'designer');
  assert.strictEqual(allPassed, false);
  assert.strictEqual(fb.checkExitGate(root).allowed, false);
});

// ── setDirtyBit seeds the design sub-phase from the active manifest ──
const o = require('../lib/orchestration');

test('setDirtyBit seeds design sub-phase for frontend when manifest.has_ui', () => {
  const root = tmpRoot();
  o.createManifest(root, 'feat-ui', 'Build a settings page', 'MEDIUM', { hasUi: true });
  fb.setDirtyBit(root, 'frontend');
  const state = fb.readFeedbackState(root);
  assert.ok(state.domain_phases.frontend.design, 'design sub-phase should be seeded');
  assert.strictEqual(state.domain_phases.frontend.design.status, 'PENDING');
});

test('setDirtyBit does NOT seed design for backend, even with has_ui manifest', () => {
  const root = tmpRoot();
  o.createManifest(root, 'feat-ui', 'Build a settings page', 'MEDIUM', { hasUi: true });
  fb.setDirtyBit(root, 'backend');
  const state = fb.readFeedbackState(root);
  assert.ok(!state.domain_phases.backend.design, 'backend must never get a design gate');
});

test('setDirtyBit does NOT seed design when manifest has no UI', () => {
  const root = tmpRoot();
  o.createManifest(root, 'feat-be', 'Add a queue worker', 'MEDIUM', { hasUi: false });
  fb.setDirtyBit(root, 'frontend');
  const state = fb.readFeedbackState(root);
  assert.ok(!state.domain_phases.frontend.design, 'no design gate when has_ui is false');
});

test('setDirtyBit resets an existing design sub-phase to PENDING on new edits', () => {
  const root = tmpRoot();
  o.createManifest(root, 'feat-ui', 'Build a settings page', 'MEDIUM', { hasUi: true });
  fb.activateFeedbackLoop(root, 'frontend', { hasUi: true });
  fb.recordPhaseResult(root, 'frontend', 'design', 'PASS', 'designer');
  fb.setDirtyBit(root, 'frontend'); // new frontend edit invalidates prior verification
  const state = fb.readFeedbackState(root);
  assert.strictEqual(state.domain_phases.frontend.design.status, 'PENDING');
});

process.exit(failed === 0 ? 0 : 1);
