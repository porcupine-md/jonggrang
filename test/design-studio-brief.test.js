'use strict';

// The studio drops an agent into a template directory. Before this, that
// directory held design files and nothing else — no brief, no mention of the
// rendered preview, no mention of the browser sitting on PATH — so the agent
// reviewed CSS source and called it a design review.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-studio-'));
process.env.JONGGRANG_DESIGN_HOME = store;
const design = require('../lib/design');

console.log('\ndesign studio brief — the agent must know it can validate visually\n');

test('a new template is scaffolded with the brief for both backends', () => {
  const { dir } = design.newTemplate('brief-probe', { intent: 'probe', force: true });
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} should be scaffolded`);
  }
});

test('the brief names anoa, the preview URL and the session step', () => {
  const body = design.scaffoldStudioInstructions('brief-probe');
  assert.ok(/anoa --headless --port 9222/.test(body), 'must show how to start the browser once');
  assert.ok(body.includes('JONGGRANG_DESIGN_PREVIEW'), 'must point at the injected preview URL');
  assert.ok(/anoa screenshot/.test(body), 'must tell the agent to capture the rendered page');
  assert.ok(/anoa set media dark/.test(body), 'dark mode is a design decision worth checking');
  assert.ok(/anoa status/.test(body), 'must explain how a missing browser reports itself');
});

test('an existing template gets the brief on first open, without clobbering edits', () => {
  const dir = path.join(store, 'legacy-template');
  fs.mkdirSync(dir, { recursive: true });

  const wrote = design.writeStudioInstructions(dir, 'legacy-template');
  assert.strictEqual(wrote, 2, 'both files should be created for a template that had none');

  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# hand-tuned brief\n');
  const again = design.writeStudioInstructions(dir, 'legacy-template');
  assert.strictEqual(again, 0, 'an existing brief must never be overwritten');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# hand-tuned brief\n');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
