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

process.exit(failed === 0 ? 0 : 1);
