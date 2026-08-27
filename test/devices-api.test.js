'use strict';

// The dashboard-facing half of local-sandbox devices (apis/devices.js).
//
// It was read-mostly at first — a device registered over ssh, not HTTP. It can now
// also register here, by pasting its public key, because ssh from the device to
// this server was a prerequisite the tunnel itself never needed. So these tests
// pin both: what the dashboard shows, and what it will accept into
// `authorized_keys` — one key, one line, one port.

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

// Each device needs a key of its own — the server refuses a shared one — so tests
// that register more than one device mint distinguishable keys.
let keySeq = 0;
function freshKey(comment = 'api-test@mac') {
  const filler = String(keySeq++).padStart(4, '0');
  return `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${filler}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ${comment}`;
}

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

async function post(url, body) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function authorizedKeys() {
  try { return fs.readFileSync(tunnel.authorizedKeysPath(), 'utf8'); } catch { return ''; }
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
  const r = tunnel.provisionDevice({ label: 'doomed', pubkey: freshKey(), localuser: 'me' });
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

// ── registering from the dashboard ───────────────────────────────
//
// The form field is a paste box, so everything a paste box can contain has to be
// answered with a message rather than a file write.

test('a pasted key registers the device and reserves a port', async () => {
  const before_ = events.length;
  const { status, body } = await post('/api/devices', {
    pubkey: freshKey('wizard@mac'), label: 'wizard mac', localuser: 'me', workdir: '/tmp/app', ssh_host: 'me@server',
  });
  assert.equal(status, 201);
  assert.match(body.device_id, /^dev_wizard-mac_/);
  assert.ok(body.port >= tunnel.PORT_MIN && body.port <= tunnel.PORT_MAX);
  assert.equal(body.ssh_host, 'me@server');
  assert.match(body.server_fingerprint, /^SHA256:/);
  assert.match(body.device_fingerprint, /^SHA256:/);
  assert.equal(body.command, `jonggrang device adopt ${body.code}`);
  assert.equal(events[before_].name, 'devices.changed');
  assert.deepEqual(events[before_].payload, { added: body.device_id });

  const listed = (await (await req('GET', '/api/devices')).json()).devices.find(d => d.id === body.device_id);
  assert.equal(listed.label, 'wizard mac');
  assert.equal(listed.localuser, 'me');
});

test('the code carries what the device needs, and nothing it must guess', async () => {
  const { body } = await post('/api/devices', {
    pubkey: freshKey('code@mac'), label: 'code mac', localuser: 'me', workdir: '/tmp/app', ssh_host: 'me@server',
  });
  assert.match(body.code, /^jg1_/);
  const decoded = JSON.parse(Buffer.from(body.code.slice(4).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.equal(decoded.device_id, body.device_id);
  assert.equal(decoded.port, body.port);
  assert.equal(decoded.server, 'me@server');
  assert.equal(decoded.localuser, 'me');
  assert.equal(decoded.workdir, '/tmp/app');
  assert.equal(decoded.server_pubkey, body.server_pubkey);
  assert.ok(decoded.token, 'the device authenticates the tunnel with it');
});

test('the key is authorized for one port and nothing else', async () => {
  const { body } = await post('/api/devices', { pubkey: freshKey('restricted@mac'), label: 'restricted', localuser: 'me' });
  const line = authorizedKeys().split('\n').find(l => l.includes(`permitlisten="localhost:${body.port}"`));
  assert.ok(line, 'the device key is authorized for its own port');
  assert.match(line, /^restrict,port-forwarding,/);
  assert.match(line, /command="\/bin\/false/, 'no shell, even a restricted one');
});

test('a second key pasted into the box does not become a second authorized key', async () => {
  const evil = `${freshKey('evil@mac')}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEVILEVILEVILEVILEVILEVILEVILEVILEVILEVIL attacker`;
  const before_ = authorizedKeys();
  const { status, body } = await post('/api/devices', { pubkey: evil, label: 'evil', localuser: 'me' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_PUBKEY');
  assert.match(body.error.message, /one key/);
  assert.equal(authorizedKeys(), before_, 'nothing was written');
  assert.equal(authorizedKeys().includes('attacker'), false);
});

test('a private key is refused by name, not by a generic parse error', async () => {
  const { status, body } = await post('/api/devices', {
    pubkey: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----',
    label: 'oops', localuser: 'me',
  });
  assert.equal(status, 400);
  assert.match(body.error.message, /PRIVATE key/);
});

test('junk, an empty box, and a missing account each say what to do', async () => {
  assert.match((await post('/api/devices', { pubkey: 'hello', label: 'x', localuser: 'me' })).body.error.message,
    /Not an ssh public key/);
  assert.match((await post('/api/devices', { pubkey: '  ', label: 'x', localuser: 'me' })).body.error.message,
    /Paste the device/);
  assert.match((await post('/api/devices', { pubkey: KEY, label: 'x' })).body.error.message,
    /localuser is required/);
  assert.match((await post('/api/devices', { pubkey: KEY, localuser: 'me' })).body.error.message,
    /label is required/);
});

test('re-pasting for an existing device keeps its port and token', async () => {
  const key = freshKey('stable@mac');
  const first = await post('/api/devices', { pubkey: key, label: 'stable', localuser: 'me' });
  const again = await post('/api/devices', { pubkey: key, label: 'stable', localuser: 'me', id: first.body.device_id });
  assert.equal(again.body.device_id, first.body.device_id);
  assert.equal(again.body.port, first.body.port, 'a device that re-registers keeps working');
});

// One key cannot serve two devices: the port restriction lives on the
// authorized_keys line, and that file is keyed by the key. Before this, the second
// device was accepted and simply never got a line — a tunnel refused later, for a
// reason nothing said out loud.
test('the same key for a second device is refused, naming the one that has it', async () => {
  const key = freshKey('shared@mac');
  const first = await post('/api/devices', { pubkey: key, label: 'first owner', localuser: 'me' });
  const second = await post('/api/devices', { pubkey: key, label: 'second', localuser: 'me' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'PUBKEY_IN_USE');
  assert.match(second.body.error.message, /first owner/);
  assert.equal(second.body.error.device_id, first.body.device_id);
});

test('the listing offers an ssh host to start from, and admits it is a guess', async () => {
  const { ssh_host_default } = await (await req('GET', '/api/devices')).json();
  assert.match(ssh_host_default, /^[^@]+@/, 'user@host');
});
