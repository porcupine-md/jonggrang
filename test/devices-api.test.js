'use strict';

// The dashboard-facing half of local-sandbox devices (apis/devices.js).
//
// Read-mostly by design: a device registers over ssh, not HTTP, so these tests
// pin what the dashboard is for — showing the registry, serving the public half
// of the agent key, and removing a device — and the invariant the whole file
// exists for: tokens never leave the server.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-devices-api-'));
process.env.HOME = TMP;
delete process.env.JONGGRANG_WEB_HOME;
const tunnel = require('../lib/tunnel');
const registerDevices = require('../apis/devices');

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA api-test@mac';

let server, base, cleanup;
const events = [];
const io = {
  emit: (name, payload) => events.push({ name, payload }),
  on: () => {},
  to: () => ({ emit: () => {} }),
};

before(async () => {
  const app = express();
  app.use(express.json());
  cleanup = registerDevices(app, io, {});
  await new Promise(resolve => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
after(() => { if (cleanup) cleanup(); if (server) server.close(); });

async function req(method, url) {
  return fetch(base + url, { method });
}

test('the listing is empty and keyless before the first registration', async () => {
  const res = await req('GET', '/api/devices');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.devices, []);
  assert.equal(body.agent_pubkey_present, false, 'no key is minted by a mere GET');
  assert.deepEqual(body.port_range, [tunnel.PORT_MIN, tunnel.PORT_MAX]);
});

test('the agent key answers 404 before any device registered', async () => {
  const res = await req('GET', '/api/devices/agent-key');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'NO_AGENT_KEY');
});

test('a registered device is listed, and its token never is', async () => {
  const r = tunnel.provisionDevice({ label: 'api mac', pubkey: KEY, localuser: 'me', workdir: '/tmp/app' });
  const res = await req('GET', '/api/devices');
  assert.equal(res.status, 200);
  const { devices, agent_pubkey_present } = await res.json();
  const listed = devices.find(d => d.id === r.device_id);
  assert.ok(listed, 'the device appears in the registry');
  assert.equal(listed.port, r.port);
  assert.equal(listed.label, 'api mac');
  assert.equal(listed.token, undefined, 'a token must never reach a listing');
  assert.equal(JSON.stringify(devices).includes(r.token), false, 'nor anywhere in the payload');
  assert.equal(agent_pubkey_present, true, 'registration created the server keypair');
});

test('the agent-key endpoint serves the public half, and only that', async () => {
  const res = await req('GET', '/api/devices/agent-key');
  assert.equal(res.status, 200);
  const { pubkey } = await res.json();
  assert.match(pubkey, /^ssh-ed25519 /, 'the public half of the server keypair');
  assert.ok(!pubkey.includes('PRIVATE'), 'the private half never leaves the server');
});

test('DELETE removes a device, releases its mounts, and says what stays on the device', async () => {
  const r = tunnel.provisionDevice({ label: 'doomed', pubkey: KEY, localuser: 'me' });
  const before_ = events.length;
  const res = await req('DELETE', `/api/devices/${r.device_id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.unmounted, [], 'nothing was mounted in this test, so nothing was released');
  assert.match(body.authorized_keys, /authorized_keys$/);
  assert.match(body.device_side.worktrees, new RegExp(`/${r.device_id}$`));
  assert.match(body.device_side.registration, /device\.json/);
  // The dashboard hears about it, so its Local Devices card can refresh.
  assert.equal(events[before_].name, 'devices.changed');
  assert.deepEqual(events[before_].payload, { removed: r.device_id });
  // And the registry really is rid of it.
  const { devices } = await (await req('GET', '/api/devices')).json();
  assert.equal(devices.some(d => d.id === r.device_id), false);
});

test('DELETE of an unknown device is a 404, not a crash', async () => {
  const res = await req('DELETE', '/api/devices/dev_nope');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'DEVICE_NOT_FOUND');
});
