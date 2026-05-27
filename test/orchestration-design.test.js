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

process.exit(failed === 0 ? 0 : 1);
