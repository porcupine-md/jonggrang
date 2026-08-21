'use strict';

// Local-sandbox devices — P0 (registration + key exchange) and P1 (tunnel
// lifecycle) of docs/plans/2026-07-07-local-sandbox-remote-agent.md.
//
// The properties worth pinning are the ones a second device or a re-run would
// break: a port belongs to one device and survives re-registration, a key is
// authorized once and only for its own port, and the tunnel argv actually binds
// the server's loopback (the whole reason the port is not internet-exposed).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

// The module resolves both state files from HOME, so each test file gets its own.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-device-'));
process.env.HOME = HOME;
delete process.env.JONGGRANG_WEB_HOME;
const tunnel = require('../lib/tunnel');

const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA alice@mac';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB bob@mac';

// ── the registry ─────────────────────────────────────────────────

test('provisioning reserves a port, a token, and an agent key', () => {
  const r = tunnel.provisionDevice({ label: 'alice mac', pubkey: KEY_A, localuser: 'alice', workdir: '/Users/alice/app' });
  assert.match(r.device_id, /^dev_alice-mac_[0-9a-f]{6}$/);
  assert.ok(r.port >= tunnel.PORT_MIN && r.port <= tunnel.PORT_MAX, 'port is inside the reserved range');
  assert.match(r.token, /^[0-9a-f]{48}$/);
  assert.match(r.server_pubkey, /^ssh-ed25519 /, 'the server gets a keypair for reaching into devices');
});

test('re-registering the same device keeps its port and token', () => {
  const first = tunnel.provisionDevice({ label: 'stable', pubkey: KEY_A, localuser: 'alice' });
  const again = tunnel.provisionDevice({ id: first.device_id, label: 'stable renamed', pubkey: KEY_A, localuser: 'alice' });
  assert.equal(again.device_id, first.device_id);
  assert.equal(again.port, first.port, 'the port a device was told to use must not move under it');
  assert.equal(again.token, first.token);
  assert.equal(again.server_pubkey, first.server_pubkey, 'one agent key, reused across registrations');
});

test('a second device gets a different port', () => {
  const a = tunnel.provisionDevice({ label: 'one', pubkey: KEY_A, localuser: 'alice' });
  const b = tunnel.provisionDevice({ label: 'two', pubkey: KEY_B, localuser: 'bob' });
  assert.notEqual(a.port, b.port);
});

test('the registry never hands the same port to two devices', () => {
  const seen = new Set(tunnel.listDevices().map(d => d.port));
  assert.equal(seen.size, tunnel.listDevices().length, 'ports are unique across the registry');
});

test('reservePort skips ports already taken', () => {
  const registry = { version: 1, devices: { a: { port: tunnel.PORT_MIN }, b: { port: tunnel.PORT_MIN + 1 } } };
  assert.equal(tunnel.reservePort(registry), tunnel.PORT_MIN + 2);
  // The device being re-provisioned does not block its own port.
  assert.equal(tunnel.reservePort(registry, 'a'), tunnel.PORT_MIN);
});

test('removing a device frees its port for the next one', () => {
  const doomed = tunnel.provisionDevice({ label: 'doomed', pubkey: KEY_B, localuser: 'bob' });
  assert.equal(tunnel.removeDevice(doomed.device_id), true);
  assert.equal(tunnel.removeDevice(doomed.device_id), false, 'removing twice is not an error the caller must handle');
  const next = tunnel.provisionDevice({ label: 'reuse', pubkey: KEY_B, localuser: 'bob' });
  assert.equal(next.port, doomed.port, 'the freed port is handed out again');
});

test('listDevices reports the registry without leaking tokens', () => {
  const listed = tunnel.listDevices();
  assert.ok(listed.length > 0);
  for (const d of listed) {
    assert.ok(d.id && d.port, 'each entry identifies a device and its port');
    assert.equal(d.token, undefined, 'a token must never reach a listing');
  }
});

test('provisioning refuses anything that is not a public key', () => {
  assert.throws(() => tunnel.provisionDevice({ label: 'x', pubkey: 'not a key' }), /public key/);
  assert.throws(() => tunnel.provisionDevice({ label: 'x', pubkey: '' }), /public key/);
});

// ── authorized_keys, both directions ─────────────────────────────

test('a device key is authorized once, restricted to its own port', () => {
  const p = tunnel.authorizedKeysPath();
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const forA = lines.filter(l => tunnel.keyBody(l) === tunnel.keyBody(KEY_A));
  assert.equal(forA.length, 1, 'the same key must not be authorized twice');
  assert.match(forA[0], /^restrict,port-forwarding,permitlisten="localhost:\d+"/,
    'a device key opens its tunnel and nothing else — no shell');
});

test('re-adding the same key with different options does not duplicate it', () => {
  const before = fs.readFileSync(tunnel.authorizedKeysPath(), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(tunnel.addAuthorizedKey(`restrict,permitlisten="localhost:9999" ${KEY_A}`), false);
  const after = fs.readFileSync(tunnel.authorizedKeysPath(), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before);
});

test('keyBody ignores options and comments so matching is on key material', () => {
  const body = tunnel.keyBody(KEY_A);
  assert.equal(tunnel.keyBody(`restrict,port-forwarding ${KEY_A}`), body);
  assert.equal(tunnel.keyBody(`${body} a-different-comment`), body);
  assert.equal(tunnel.keyBody('# just a comment'), null);
  assert.equal(tunnel.keyBody(''), null);
});

// ── the device's own config ──────────────────────────────────────

test('device.json round-trips and starts absent', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-dev-cfg-'));
  const prev = process.env.HOME;
  process.env.HOME = fresh;
  try {
    assert.equal(tunnel.readDeviceConfig(), null, 'an unregistered machine has no device config');
    tunnel.writeDeviceConfig({ device_id: 'dev_x', server: 'sj', port: 22042, localuser: 'me' });
    assert.deepEqual(tunnel.readDeviceConfig(), { device_id: 'dev_x', server: 'sj', port: 22042, localuser: 'me' });
  } finally { process.env.HOME = prev; }
});

// ── the tunnel itself ────────────────────────────────────────────

test('the tunnel binds the SERVER loopback, which is why the port is not exposed', () => {
  const { cmd, args } = tunnel.tunnelArgv({ server: 'sj', port: 22042 }, { useAutossh: false });
  assert.equal(cmd, 'ssh');
  const r = args[args.indexOf('-R') + 1];
  assert.equal(r, '22042:localhost:22', 'forward the reserved port to sshd on this machine');
  assert.ok(args.includes('-N'), 'no remote command — the tunnel carries no shell');
  assert.equal(args[args.length - 1], 'sj', 'destination last, so ssh parses the options');
  assert.ok(args.includes('ExitOnForwardFailure=yes'),
    'a tunnel that could not bind must fail loudly, not sit there looking connected');
});

test('autossh is used for reconnection when available', () => {
  const { cmd, args } = tunnel.tunnelArgv({ server: 'sj', port: 22042 }, { useAutossh: true });
  assert.equal(cmd, 'autossh');
  assert.deepEqual(args.slice(0, 2), ['-M', '0'], 'no monitoring port — keepalives do the work');
  assert.ok(args.includes('-R'));
});

test('a custom local sshd port is honoured', () => {
  const { args } = tunnel.tunnelArgv({ server: 'sj', port: 22042, local_ssh_port: 2222 }, { useAutossh: false });
  assert.equal(args[args.indexOf('-R') + 1], '22042:localhost:2222');
});

test('status on an unregistered machine says so instead of guessing', () => {
  const st = tunnel.tunnelStatus(null);
  assert.equal(st.configured, false);
  assert.equal(st.running, false);
});

test('portListening answers truthfully for a live and a dead port', async () => {
  const server = net.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.equal(await tunnel.portListening(port), true);
  await new Promise(r => server.close(r));
  assert.equal(await tunnel.portListening(port), false,
    'a closed port must read as offline — this is what the dashboard shows as tunnel state');
});
