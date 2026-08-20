'use strict';

// Saving project settings from the dashboard silently did nothing.
//
// A sandbox container runs as root on a bind-mounted project, so anything it
// writes there stays root-owned — including `.jonggrang/jonggrang.json`. The
// dashboard runs as the host user, so its in-place `fs.writeFileSync` returned
// EACCES, the PUT answered 500, and the UI reverted the dropdown. Switching
// Claude to interactive execution looked like it saved and never did; the run
// kept starting headless.
//
// The fix has two halves. A sandbox project's files belong to its container, so
// the write goes through it — that is where those files are written from
// everywhere else. And when there is no container to write through, the host
// fallback is atomic (temp file plus rename), which needs only the DIRECTORY to
// be writable, so it still succeeds against a target the container took over.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const registerSettings = require('../apis/projects/settings');
const lib = require('../lib/jonggrang');
const sandboxLib = require('../lib/sandbox');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-settings-'));
const PROJECT = path.join(TMP, 'project');
const CONFIG_DIR = path.join(PROJECT, '.jonggrang');
const CONFIG = path.join(CONFIG_DIR, 'jonggrang.json');

fs.mkdirSync(CONFIG_DIR, { recursive: true });

const webState = {
  getProject: (id) => (id === 'proj_test' ? { id, path: PROJECT, secrets: [], sandbox: {} } : null),
  updateProject: () => {},
};

let server, base;

async function put(body) {
  const res = await fetch(`${base}/api/projects/proj_test/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('settings survive a config file the sandbox container took over', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', registerSettings({ webState }));
  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  t.after(() => server.close());

  // Stand-in for a root-owned file: one this process cannot open for writing.
  // An in-place fs.writeFileSync on it is exactly the EACCES the dashboard hit.
  fs.writeFileSync(CONFIG, JSON.stringify({ name: 'probe', tool: 'claude' }, null, 2));
  fs.chmodSync(CONFIG, 0o444);
  assert.throws(() => fs.writeFileSync(CONFIG, 'x'), /EACCES/,
    'the fixture must actually reproduce an unwritable target');

  const res = await put({ jonggrang_config: { tools: { claude: { execution: 'interactive' } } } });
  assert.equal(res.status, 200, `PUT should succeed, got ${res.status} ${JSON.stringify(res.body)}`);

  const saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(saved.tools.claude.execution, 'interactive', 'the setting must land on disk');
  assert.equal(saved.name, 'probe', 'and the rest of the config must be preserved');
});

test('a fresh project with no config file still saves', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-settings-new-'));
  const state = {
    getProject: (id) => (id === 'proj_test' ? { id, path: dir, secrets: [], sandbox: {} } : null),
    updateProject: () => {},
  };
  const app = express();
  app.use(express.json());
  app.use('/api/projects', registerSettings({ webState: state }));
  let srv, b;
  await new Promise(r => { srv = app.listen(0, () => { b = `http://127.0.0.1:${srv.address().port}`; r(); }); });
  t.after(() => srv.close());

  const res = await fetch(`${b}/api/projects/proj_test/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jonggrang_config: { orchestration: { pipeline_mode: 'compact' } } }),
  });
  assert.equal(res.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.jonggrang', 'jonggrang.json'), 'utf8'));
  assert.equal(saved.orchestration.pipeline_mode, 'compact');
});

// Guard the pattern, not just this one call site.
test('neither the settings nor the plan route writes project files in place', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', f), 'utf8');
  const settings = read('settings.js');
  assert.match(settings, /sandbox\.writeProjectFile\(project/, 'config goes through the sandbox-aware writer');
  assert.ok(!/writeFileSync\(configPath/.test(settings), 'no in-place write to the config path');
  const plan = read('plan.js');
  assert.match(plan, /sandbox\.writeProjectFile\(project/, 'an edited draft plan goes through it too');
  assert.ok(!/writeFileSync\(planPath/.test(plan), 'no in-place write to the draft plan');
});

// The routing decision itself: a sandbox project must not be written host-side
// while its container is up, and must still be writable when it is not.
test('writeProjectFile routes to the container for a sandbox project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-route-'));
  const project = { id: 'proj_nope', name: 'route probe', path: dir, sandbox: { enabled: true } };
  // No container named jonggrang-proj_nope exists, so the container attempt
  // fails and the host fallback takes over — the file must still land.
  const where = sandboxLib.writeProjectFile(project, path.join('.jonggrang', 'jonggrang.json'), '{"a":1}\n');
  assert.equal(where, 'host', 'with no container to write through, the host write happens');
  assert.equal(fs.readFileSync(path.join(dir, '.jonggrang', 'jonggrang.json'), 'utf8'), '{"a":1}\n');
});

test('writeProjectFile writes host-side for a non-sandbox project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-route-host-'));
  const project = { id: 'proj_host', name: 'plain', path: dir, sandbox: { enabled: false } };
  assert.equal(sandboxLib.writeProjectFile(project, 'notes.txt', 'hi'), 'host');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'hi');
});

test('writeProjectFile replaces a file it cannot open for writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-route-locked-'));
  const project = { id: 'proj_locked', name: 'locked', path: dir, sandbox: { enabled: false } };
  const target = path.join(dir, 'locked.json');
  fs.writeFileSync(target, '{"old":true}');
  fs.chmodSync(target, 0o444);
  sandboxLib.writeProjectFile(project, 'locked.json', '{"replaced":true}');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { replaced: true });
});

test('writeJSON itself replaces an unwritable file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-writejson-'));
  const target = path.join(dir, 'locked.json');
  fs.writeFileSync(target, '{"old":true}');
  fs.chmodSync(target, 0o444);
  lib.writeJSON(target, { replaced: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { replaced: true });
});
