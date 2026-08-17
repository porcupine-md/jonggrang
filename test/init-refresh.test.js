'use strict';

// `jonggrang init --force` on an already-initialised project. AGENTS.md and
// CLAUDE.md were always rewritten, but the skills and sub-agent definitions were
// skipped whenever the file already existed — so a project initialised before a
// tool changed kept telling agents to use the old one, with no way to refresh
// short of deleting files by hand.

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

const JONGGRANG_HOME = path.join(__dirname, '..');

function initProject(root, opts = {}) {
  return lib.runInit({
    name: 'refresh-probe', type: 'web-app', stack: 'vanilla', tool: 'claude',
    workMode: 'solo', teamSize: '1', autonomy: 'autonomous', testing: 'none',
    testCmd: '', ci: 'none',
  }, JONGGRANG_HOME, root, opts);
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jg-refresh-'));
}

const SKILL = path.join('.claude', 'skills', 'core', 'anoa', 'SKILL.md');
const AGENT = path.join('.claude', 'agents', 'developer.md');

console.log('\ninit --force — refreshing jonggrang-managed files\n');

test('a plain re-init leaves an existing skill untouched', () => {
  const root = tmpProject();
  initProject(root);
  const skill = path.join(root, SKILL);
  assert.ok(fs.existsSync(skill), 'first init should install the skill');

  fs.writeFileSync(skill, '# locally edited, do not clobber\n');
  initProject(root);                       // no force
  assert.strictEqual(fs.readFileSync(skill, 'utf8'), '# locally edited, do not clobber\n',
    'without --force an existing skill must be left alone');
});

test('init --force refreshes a stale skill', () => {
  const root = tmpProject();
  initProject(root);
  const skill = path.join(root, SKILL);
  const shipped = fs.readFileSync(skill, 'utf8');

  fs.writeFileSync(skill, '# stale: tells agents to use a tool that no longer exists\n');
  initProject(root, { force: true });
  assert.strictEqual(fs.readFileSync(skill, 'utf8'), shipped,
    '--force must restore the shipped skill');
});

test('init --force refreshes stale sub-agent definitions', () => {
  const root = tmpProject();
  initProject(root);
  const agent = path.join(root, AGENT);
  assert.ok(fs.existsSync(agent), 'first init should install the sub-agent definition');
  const shipped = fs.readFileSync(agent, 'utf8');

  fs.writeFileSync(agent, '# stale developer definition\n');
  initProject(root, { force: true });
  assert.strictEqual(fs.readFileSync(agent, 'utf8'), shipped,
    '--force must restore the shipped sub-agent definition');
});

test('the browser skill a refreshed project receives names anoa, not agent-browser', () => {
  const root = tmpProject();
  initProject(root, { force: true });
  const skill = fs.readFileSync(path.join(root, SKILL), 'utf8');
  assert.ok(/anoa/.test(skill), 'the core skill should be the anoa one');
  const visual = path.join(root, '.claude', 'skills', 'library', 'frontend', 'validating-visual-design', 'SKILL.md');
  const body = fs.readFileSync(visual, 'utf8');
  assert.ok(!/agent-browser/.test(body), 'the visual-design skill must not still name agent-browser');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
