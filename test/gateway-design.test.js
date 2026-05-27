'use strict';
const assert = require('assert');
const g = require('../lib/gateway');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log('\ngateway.js — design domain\n');

test('design domain registered with gateway-design skill', () => {
  assert.ok(g.DOMAINS.design);
  assert.strictEqual(g.DOMAINS.design.gateway_skill, 'gateway-design');
});
test('design-token intent routes to design-md skill', () => {
  const skills = g.routeToSkills('create a design system with design tokens and a color palette');
  assert.ok(skills.includes('design/design-md'));
});

process.exit(failed === 0 ? 0 : 1);
