'use strict';

const assert = require('assert');
const { github, gitlab, getProvider, preview } = require('../lib/issue-providers');

let passed = 0;
let failed = 0;

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; });
}

// Mock fetch: matches a URL substring → response data, and records calls.
function makeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [pattern, data] of routes) {
      if (url.includes(pattern)) return { ok: true, status: 200, json: async () => data };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  fn.calls = calls;
  return fn;
}

console.log('\nissue-providers.js\n');

// ── preview ───────────────────────────────────────────────────
test('preview: short body unchanged', () => {
  assert.strictEqual(preview('hello'), 'hello');
});
test('preview: long body truncated with ellipsis', () => {
  const out = preview('x'.repeat(500));
  assert.ok(out.length <= 241, `len ${out.length}`);
  assert.ok(out.endsWith('…'));
});

// ── getProvider ───────────────────────────────────────────────
test('getProvider: unknown throws 400', () => {
  try { getProvider('bitbucket'); assert.fail('should throw'); }
  catch (e) { assert.strictEqual(e.status, 400); }
});

// ── GitHub ────────────────────────────────────────────────────
test('github.listIssues: drops pull requests, normalizes fields', async () => {
  const f = makeFetch([['/repos/o/r/issues', [
    { number: 1, title: 'Bug', state: 'open', labels: [{ name: 'bug' }], assignees: [{ login: 'alice' }], user: { login: 'bob' }, body: 'boom', html_url: 'u1', updated_at: 't', comments: 2 },
    { number: 2, title: 'A PR', state: 'open', pull_request: { url: 'x' }, labels: [], assignees: [], user: { login: 'bob' }, body: '', html_url: 'u2' },
  ]]]);
  const issues = await github.listIssues('tok', { repo: 'o/r' }, f);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].provider, 'github');
  assert.strictEqual(issues[0].number, 1);
  assert.deepStrictEqual(issues[0].labels, ['bug']);
  assert.deepStrictEqual(issues[0].assignees, ['alice']);
  assert.strictEqual(issues[0].author, 'bob');
  assert.strictEqual(issues[0].comments_count, 2);
});

test('github.listIssues: state=closed maps to closed param', async () => {
  const f = makeFetch([['/repos/o/r/issues', []]]);
  await github.listIssues('tok', { repo: 'o/r', state: 'closed' }, f);
  assert.ok(f.calls[0].includes('state=closed'), f.calls[0]);
});

test('github.listIssues: q filters by title/body client-side', async () => {
  const f = makeFetch([['/repos/o/r/issues', [
    { number: 1, title: 'auth bug', state: 'open', labels: [], assignees: [], user: {}, body: '' },
    { number: 2, title: 'docs', state: 'open', labels: [], assignees: [], user: {}, body: '' },
  ]]]);
  const issues = await github.listIssues('tok', { repo: 'o/r', q: 'auth' }, f);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].number, 1);
});

test('github.getViewer: returns login', async () => {
  const f = makeFetch([['/user', { login: 'me', name: 'Me' }]]);
  const v = await github.getViewer('tok', f);
  assert.strictEqual(v.login, 'me');
});

test('github: 401 surfaces auth error', async () => {
  const f = async () => ({ ok: false, status: 401, text: async () => 'bad creds' });
  try { await github.listIssues('tok', { repo: 'o/r' }, f); assert.fail('should throw'); }
  catch (e) { assert.strictEqual(e.status, 401); assert.ok(/Authentication/.test(e.message)); }
});

// ── GitLab ────────────────────────────────────────────────────
test('gitlab.listIssues: normalizes + maps opened→open', async () => {
  const f = makeFetch([['/projects/', [
    { iid: 7, title: 'GL issue', state: 'opened', labels: ['feat'], assignees: [{ username: 'carol' }], author: { username: 'dave' }, description: 'desc', web_url: 'w', updated_at: 't', user_notes_count: 3 },
  ]]]);
  const issues = await gitlab.listIssues('tok', { repo: 'group/proj' }, f);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].provider, 'gitlab');
  assert.strictEqual(issues[0].number, 7);
  assert.strictEqual(issues[0].state, 'open');
  assert.deepStrictEqual(issues[0].labels, ['feat']);
  assert.deepStrictEqual(issues[0].assignees, ['carol']);
  assert.strictEqual(issues[0].comments_count, 3);
});

test('gitlab.listIssues: state=open maps to state=opened; path url-encoded', async () => {
  const f = makeFetch([['/projects/', []]]);
  await gitlab.listIssues('tok', { repo: 'group/proj', state: 'open' }, f);
  assert.ok(f.calls[0].includes('state=opened'), f.calls[0]);
  assert.ok(f.calls[0].includes('group%2Fproj'), f.calls[0]);
});

test('gitlab.listIssues: state=all omits state param', async () => {
  const f = makeFetch([['/projects/', []]]);
  await gitlab.listIssues('tok', { repo: 'group/proj', state: 'all' }, f);
  assert.ok(!f.calls[0].includes('state='), f.calls[0]);
});

// ── Summary ───────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}, 200);
