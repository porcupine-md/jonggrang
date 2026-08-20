'use strict';

// A worktree is seeded with the project's .jonggrang/jonggrang.json when it is
// CREATED, and used to keep that copy for its whole life. So every later change
// to project settings silently failed to apply: switching Claude to interactive
// execution, or the pipeline to compact, left an existing plan's worker running
// with whatever the worktree was born with. Runs now re-seed the file, which
// depends on the copy OVERWRITING an existing destination — pinned here.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../lib/jonggrang');

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

const REL = path.join('.jonggrang', 'jonggrang.json');

function writeConfig(root, execution) {
  fs.mkdirSync(path.join(root, '.jonggrang'), { recursive: true });
  fs.writeFileSync(path.join(root, REL), JSON.stringify({
    name: 'seed-probe', tool: 'claude', tools: { claude: { execution } },
  }, null, 2));
}

function readExecution(root) {
  const j = JSON.parse(fs.readFileSync(path.join(root, REL), 'utf8'));
  return j.tools?.claude?.execution;
}

function pair() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-seed-'));
  const project = path.join(base, 'project');
  const worktree = path.join(base, 'worktree');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  return { project, worktree };
}

console.log('\nworktree config seeding — project settings must reach an existing worktree\n');

test('a stale worktree config is overwritten by the project one', () => {
  const { project, worktree } = pair();
  writeConfig(project, 'interactive');
  writeConfig(worktree, 'headless');          // seeded before the setting changed

  lib.copyToWorktree(project, worktree, [REL]);

  assert.strictEqual(readExecution(worktree), 'interactive',
    'the worktree must pick up the current project setting, not keep its birth copy');
});

test('a worktree with no config yet receives one', () => {
  const { project, worktree } = pair();
  writeConfig(project, 'interactive');

  lib.copyToWorktree(project, worktree, [REL]);

  assert.ok(fs.existsSync(path.join(worktree, REL)), 'the config should be created');
  assert.strictEqual(readExecution(worktree), 'interactive');
});

test('a missing project config leaves the worktree untouched rather than erasing it', () => {
  const { project, worktree } = pair();
  writeConfig(worktree, 'interactive');       // nothing to copy from the project

  lib.copyToWorktree(project, worktree, [REL]);

  assert.strictEqual(readExecution(worktree), 'interactive',
    'a project without a config must not blank an existing worktree copy');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
