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
// Renaming a temp file into the directory needs only the DIRECTORY to be
// writable, which it is — so the write survives a target the container took
// over. `lib.writeJSON` already does exactly that; the settings route was the
// one place still writing in place.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const registerSettings = require('../apis/projects/settings');
const lib = require('../lib/jonggrang');

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

// The route is the only host-side config writer that was not atomic; guard the
// pattern rather than just this one call.
test('the settings route does not write config in place', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'settings.js'), 'utf8');
  assert.match(src, /lib\.writeJSON\(configPath/, 'config is written atomically');
  assert.ok(!/writeFileSync\(configPath/.test(src), 'no in-place write to the config path');
});

test('writeJSON itself replaces an unwritable file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-writejson-'));
  const target = path.join(dir, 'locked.json');
  fs.writeFileSync(target, '{"old":true}');
  fs.chmodSync(target, 0o444);
  lib.writeJSON(target, { replaced: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { replaced: true });
});
