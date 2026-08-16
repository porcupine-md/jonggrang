'use strict';

// Where the design store lives. JONGGRANG_HOME means the INSTALL directory to
// server.js and bin/jonggrang.js, but the design store is user data under
// ~/.jonggrang — the path the studio container bind-mounts. Conflating the two
// scattered new templates into the checkout, so the studio listed none and
// opening a session crashed on a container cwd that did not exist.

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

// The module caches nothing about the home, but it is required fresh per case
// so an env change cannot be masked by module state.
function freshDesign() {
  delete require.cache[require.resolve('../lib/design')];
  return require('../lib/design');
}

function makeInstallDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-install-'));
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'AGENTS.md.template'), '# marker\n');
  return dir;
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

console.log('\ndesign store path — install dir vs data dir\n');

test('an install directory is never used as the design store', () => {
  const install = makeInstallDir();
  withEnv({ JONGGRANG_HOME: install, JONGGRANG_DESIGN_HOME: undefined }, () => {
    const root = freshDesign().designRoot();
    assert.strictEqual(root, path.join(os.homedir(), '.jonggrang', 'design'),
      `the store must fall back to the data home, got ${root}`);
    assert.ok(!root.startsWith(install), 'the store must never land inside the checkout');
  });
});

test('a JONGGRANG_HOME that is a data dir is still honoured', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-data-'));
  withEnv({ JONGGRANG_HOME: data, JONGGRANG_DESIGN_HOME: undefined }, () => {
    assert.strictEqual(freshDesign().designRoot(), path.join(data, 'design'));
  });
});

test('no JONGGRANG_HOME → the data home', () => {
  withEnv({ JONGGRANG_HOME: undefined, JONGGRANG_DESIGN_HOME: undefined }, () => {
    assert.strictEqual(freshDesign().designRoot(), path.join(os.homedir(), '.jonggrang', 'design'));
  });
});

test('JONGGRANG_DESIGN_HOME overrides everything', () => {
  const install = makeInstallDir();
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-design-'));
  withEnv({ JONGGRANG_HOME: install, JONGGRANG_DESIGN_HOME: explicit }, () => {
    assert.strictEqual(freshDesign().designRoot(), explicit);
  });
});

test('a template created under an install-dir JONGGRANG_HOME lands in the real store', () => {
  const install = makeInstallDir();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-store-'));
  withEnv({ JONGGRANG_HOME: install, JONGGRANG_DESIGN_HOME: store }, () => {
    const design = freshDesign();
    const created = design.newTemplate('probe-template', { intent: 'regression probe', force: true });
    assert.ok(created.dir.startsWith(store), `template landed outside the store: ${created.dir}`);
    assert.ok(!created.dir.startsWith(install), 'template must not be written into the checkout');
    assert.ok(fs.existsSync(created.dir), 'template directory should exist');
    // …and it must be visible to the very next listing, which is what the studio reads.
    assert.ok(design.listTemplates().some(t => t.key === 'probe-template' || t.id?.startsWith('probe-template')),
      'a freshly created template must appear in the studio listing');
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
