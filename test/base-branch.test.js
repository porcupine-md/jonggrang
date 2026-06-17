'use strict';

// Guards for the base-branch hardening (PR #57 review, Tier 0/2):
// isSafeBranchName must reject every shell-injection vector, and setPlanBase
// must persist a quoted YAML scalar and refuse unsafe input.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../lib/jonggrang');

test('isSafeBranchName accepts plain branch names', () => {
  for (const ok of ['main', 'develop', 'feat/issuespickup', 'release-1.2.0', 'a_b.c/d-e']) {
    assert.equal(lib.isSafeBranchName(ok), true, ok);
  }
});

test('isSafeBranchName rejects injection + non-string + leading dash/dot', () => {
  for (const bad of [
    'main"; rm -rf ~/.jonggrang; echo "',
    'main && touch /tmp/x',
    'a|b', 'a;b', 'a b', '$(id)', '`id`', 'a(b)', "a'b", 'a"b', 'a\\b',
    '-rf', '.hidden', '', 'a'.repeat(201),
    null, undefined, 123, {},
  ]) {
    assert.equal(lib.isSafeBranchName(bad), false, JSON.stringify(bad));
  }
});

test('setPlanBase writes a quoted scalar and rejects unsafe base', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-base-'));
  const planPath = path.join(dir, 'plan.md');
  fs.writeFileSync(planPath, '---\nbranch: jonggrang/x\n---\n# Title\n');

  assert.equal(lib.setPlanBase(planPath, 'develop'), true);
  let raw = fs.readFileSync(planPath, 'utf8');
  assert.match(raw, /base: "develop"/);
  // js-yaml must parse it back as the string, not coerce.
  assert.equal(lib.parsePlanFrontmatter(planPath).base, 'develop');

  // A YAML-keyword-shaped branch name stays a string thanks to quoting.
  fs.writeFileSync(planPath, '---\nbranch: jonggrang/x\n---\n# Title\n');
  assert.equal(lib.setPlanBase(planPath, 'no'), true);
  assert.strictEqual(lib.parsePlanFrontmatter(planPath).base, 'no');

  // Unsafe input is refused and the file is left untouched.
  fs.writeFileSync(planPath, '---\nbranch: jonggrang/x\n---\n# Title\n');
  assert.equal(lib.setPlanBase(planPath, 'x"; rm -rf /; echo "'), false);
  assert.doesNotMatch(fs.readFileSync(planPath, 'utf8'), /base:/);

  fs.rmSync(dir, { recursive: true, force: true });
});
