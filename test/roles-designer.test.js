'use strict';
const assert = require('assert');
const r = require('../lib/roles');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\nroles.js — designer role\n');

test('designer role exists with coordinator+verifier tool boundary', () => {
  const d = r.getRole('designer');
  assert.ok(d, 'designer role missing');
  assert.deepStrictEqual(d.tools.slice().sort(), ['Bash', 'Read', 'Task'].sort());
  assert.ok(d.forbidden_tools.includes('Edit'));
  assert.ok(d.forbidden_tools.includes('Write'));
});
test('designer is a coordinator (has Task) and not an executor (no Edit/Write)', () => {
  assert.strictEqual(r.isCoordinator('designer'), true);
  assert.strictEqual(r.isExecutor('designer'), false);
});
test('completion signals registered for designer', () => {
  const signals = r.getCompletionSignals();
  assert.strictEqual(signals['DESIGN_COMPLETE'], 'designer');
  assert.deepStrictEqual(r.detectCompletionSignal('...DESIGN_UI_VERIFIED...'),
    { signal: 'DESIGN_UI_VERIFIED', role: 'designer' });
});

process.exit(failed === 0 ? 0 : 1);
