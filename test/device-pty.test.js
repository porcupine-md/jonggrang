'use strict';

// The device boundary in apis/projects/pty.js — the load-bearing split of the
// whole local-sandbox design:
//
//   terminal sessions  → run ON the device, over the reverse tunnel (ssh argv)
//   agent sessions     → run HERE on the server, with the Bash-redirect env
//                        (JONGGRANG_DEVICE_*), never over ssh
//
// A terminal that did not cross the tunnel would be a shell on the server with
// the device's files mounted under it; an agent that did cross it would quietly
// require the agent CLI installed and logged in on the device — both exactly
// what the design forbids. These tests pin the split through the real HTTP
// routes, with node-pty stubbed so no real ssh is spawned and the tunnel
// module left real (temp HOME) apart from mount/unmount spies.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const express = require('express');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-pty-'));
process.env.HOME = HOME;
delete process.env.JONGGRANG_WEB_HOME;

// ── node-pty stub (must be in place before apis/projects/pty is required) ──
const spawned = [];
function makeFakePty() {
  const p = {
    cmd: null, args: null, opts: null,
    onData(fn) { this._data = fn; return this; },
    onExit(fn) { this._exit = fn; return this; },
    kill() { if (this._exit) this._exit({ exitCode: 0 }); },
    write() {}, resize() {},
  };
  spawned.push(p);
  return p;
}
const ptyStub = {
  spawn: (cmd, args, opts) => { const p = makeFakePty(); p.cmd = cmd; p.args = args; p.opts = opts; return p; },
};
const nodePtyPath = require.resolve('node-pty');
require.cache[nodePtyPath] = { exports: ptyStub, id: nodePtyPath, filename: nodePtyPath, loaded: true };

const tunnel = require('../lib/tunnel');
const registerPty = require('../apis/projects/pty');


let server, base, app, router;
let livePort; // a port that answers — stands in for a device whose tunnel is up
let acceptor; // the server behind livePort; must be closed or the process never exits
const projects = {};
const mounts = { mount: [], unmount: [] };

function registerProject(id, deviceId, workdir) {
  projects[id] = {
    id,
    path: fs.mkdtempSync(path.join(os.tmpdir(), `jg-pty-proj-${id}-`)),
    device: { enabled: true, device_id: deviceId, workdir },
  };
}
// Each device needs a key of its own — the server refuses a shared one, because the
// port restriction lives on the authorized_keys line and that file is keyed by the
// key. These tests provision several devices, so each gets a distinguishable one.
let keySeq = 0;
function freshKey() {
  return `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(keySeq++).padStart(4, '0')}DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD pty-test@mac`;
}
function provision(label, opts = {}) {
  // platform is recorded so devicePlatform() never probes the port with a real ssh.
  return tunnel.provisionDevice({ label, pubkey: freshKey(), localuser: 'me', workdir: '/tmp/dev-app', platform: 'Darwin arm64', ...opts });
}
function setPort(deviceId, port) {
  const reg = tunnel.readRegistry();
  reg.devices[deviceId].port = port;
  tunnel.writeRegistry(reg);
}
function closedPort() {
  // Bind, grab the port, close: a port that is guaranteed not to be listening.
  const srv = net.createServer();
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const lastSpawn = () => spawned[spawned.length - 1];
const deviceEnvKeys = (opts) => Object.keys(opts.env).filter(k => k.startsWith('JONGGRANG_DEVICE_'));

async function req(method, url, body) {
  return fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  // A live stand-in for the tunnel: portListening() connects to it and wins.
  acceptor = net.createServer(() => {});
  await new Promise(r => acceptor.listen(0, '127.0.0.1', r));
  livePort = acceptor.address().port;

  const webState = {
    getProject: (id) => projects[id] || null,
    getProjectSecretVars: () => ({}),
  };
  const io = { on: () => {}, to: () => ({ emit: () => {} }), emit: () => {} };
  app = express();
  app.use(express.json());
  router = registerPty({ io, webState, lastActivity: new Map() });
  app.use('/api/projects', router);

  // mount/unmount are real sshfs/umount calls — spy them so nothing mounts here.
  const origMount = tunnel.mountDevice;
  const origUnmount = tunnel.unmountDevice;
  tunnel.mountDevice = (...a) => { mounts.mount.push(a); return { mounted: true }; };
  tunnel.unmountDevice = (...a) => { mounts.unmount.push(a); return false; };

  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (acceptor) await new Promise(r => acceptor.close(r));
});

// ── the split itself ─────────────────────────────────────────────

test('a terminal on a device project runs over ssh, with no redirect env', async () => {
  const d = provision('term mac');
  setPort(d.device_id, livePort);
  registerProject('term-proj', d.device_id, '/tmp/dev-app');

  const res = await req('POST', '/api/projects/term-proj/terminal/start');
  assert.equal(res.status, 200);
  const p = lastSpawn();
  assert.equal(p.cmd, 'ssh', 'the terminal crosses the tunnel');
  assert.equal(p.args[p.args.indexOf('-p') + 1], String(livePort), 'through the device\'s reserved port');
  assert.ok(p.args.includes('-tt'), 'a pty so interactive tools and Ctrl-C behave');
  assert.ok(p.args.includes('IdentitiesOnly=yes'));
  assert.ok(p.args.includes('me@localhost'), 'through the tunnel, so the far end is loopback');
  assert.ok(p.args[p.args.length - 1].includes('exec "$SHELL" -l'), 'a bare shell in the project dir');
  assert.deepEqual(deviceEnvKeys(p.opts), [], 'a terminal needs no redirect env — it is already ON the device');
  assert.equal(mounts.mount.length, 0, 'a terminal does not mount the device');
});

test('an agent on a device project runs HERE with the redirect env, not over ssh', async () => {
  const d = provision('agent mac');
  setPort(d.device_id, livePort);
  registerProject('agent-proj', d.device_id, '/tmp/dev-app');
  const beforeMounts = mounts.mount.length;

  const res = await req('POST', '/api/projects/agent-proj/agent/start', { tool: 'claude' });
  assert.equal(res.status, 200);
  const p = lastSpawn();
  assert.equal(p.cmd, 'claude', 'the agent CLI runs on the server — the device needs none');
  assert.equal(p.args.includes('ssh'), false, 'the agent itself never crosses the tunnel');
  const settingsIdx = p.args.indexOf('--settings');
  assert.ok(settingsIdx >= 0, 'the redirect hook is passed with --settings');
  assert.match(p.args[settingsIdx + 1], /\.jonggrang-device\/settings\.json$/, 'and it lives in the server-side bundle, not .claude');
  assert.ok(p.args.includes('--append-system-prompt'), 'the agent is told its commands run elsewhere');

  const env = deviceEnvKeys(p.opts);
  assert.ok(env.includes('JONGGRANG_DEVICE_PORT') && env.includes('JONGGRANG_DEVICE_USER')
    && env.includes('JONGGRANG_DEVICE_WORKDIR') && env.includes('JONGGRANG_DEVICE_KEY'),
    `the Bash-redirect env reaches the agent: ${env.join(', ')}`);
  assert.equal(p.opts.env.JONGGRANG_DEVICE_WORKDIR, '/tmp/dev-app');
  // The route mounts twice: once before reading the tool config through the
  // mount, once before spawning. What matters is that the device IS mounted so
  // the agent's file tools see the project.
  assert.equal(mounts.mount.length, beforeMounts + 2, 'the agent start mounted the device so file tools see the project');
});

test('a non-claude agent on a device project is refused before anything runs', async () => {
  const d = provision('opencode mac');
  setPort(d.device_id, livePort);
  registerProject('oc-proj', d.device_id, '/tmp/dev-app');

  const before_ = spawned.length;
  const res = await req('POST', '/api/projects/oc-proj/agent/start', { tool: 'opencode' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'DEVICE_TOOL_UNSUPPORTED');
  assert.match(body.message, /claude-only/);
  assert.equal(spawned.length, before_, 'nothing is spawned for a backend the redirect cannot cover');
});

// ── the guards in front of the split ─────────────────────────────

test('a device project whose device is gone answers 409, not a crash', async () => {
  registerProject('gone-proj', 'dev_not_registered', '/tmp/dev-app');
  const res = await req('POST', '/api/projects/gone-proj/terminal/start');
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'DEVICE_NOT_REGISTERED');
});

test('a device project with the tunnel down answers 503, naming the machine', async () => {
  const d = provision('offline mac');
  setPort(d.device_id, await closedPort());
  registerProject('offline-proj', d.device_id, '/tmp/dev-app');

  const res = await req('POST', '/api/projects/offline-proj/terminal/start');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'DEVICE_TUNNEL_DOWN');
  assert.match(body.message, /offline mac/, 'the message names the device, not just a code');
});

// ── the mount is released when the agent leaves, not the terminal ─

test('terminal exit does not release a device mount; the agent exit does', async () => {
  const d = provision('release mac');
  setPort(d.device_id, livePort);
  registerProject('release-proj', d.device_id, '/tmp/dev-app');

  const startIdx = spawned.length;
  await req('POST', '/api/projects/release-proj/agent/start', { tool: 'claude' });   // mounts, spawns agent
  await req('POST', '/api/projects/release-proj/terminal/start');                    // terminal, no mount
  const agentPty = spawned[startIdx];
  const terminalPty = spawned[startIdx + 1];
  const unmountsBefore = mounts.unmount.length;

  // The terminal leaves first — it never needed the mount, and must not drop it.
  terminalPty.kill();
  assert.equal(mounts.unmount.length, unmountsBefore, 'a terminal exit leaves the mount alone');

  // The agent leaves — the mount was for its file tools; now it is just a hostage.
  agentPty.kill();
  assert.equal(mounts.unmount.length, unmountsBefore + 1, 'the agent exit releases the mount');
  const [device, workdir] = mounts.unmount[mounts.unmount.length - 1];
  assert.equal(device.id, d.device_id, 'the device registry entry, which carries its id');
  assert.equal(workdir, '/tmp/dev-app');
});

test('a device mount survives while another agent session is still running', async () => {
  const d = provision('two-agents mac');
  setPort(d.device_id, livePort);
  registerProject('two-proj', d.device_id, '/tmp/dev-app');
  // The second session is Work Mode (agent:feat-x), whose route refuses to
  // spawn before the plan worktree exists — so make it exist.
  fs.mkdirSync(path.join(os.homedir(), '.jonggrang', 'worktree', 'two-proj', 'feat-x'), { recursive: true });

  const startIdx = spawned.length;
  await req('POST', '/api/projects/two-proj/agent/start', { tool: 'claude' });              // session 'agent'
  await req('POST', '/api/projects/two-proj/agent/start', { tool: 'claude', feature_id: 'feat-x' }); // 'agent:feat-x'
  const first = spawned[startIdx];
  const second = spawned[startIdx + 1];
  const unmountsBefore = mounts.unmount.length;

  first.kill(); // one agent session ends…
  assert.equal(mounts.unmount.length, unmountsBefore, '…but another is still using the mount');

  second.kill(); // now the last one goes
  assert.equal(mounts.unmount.length, unmountsBefore + 1, 'only the last departure releases it');
});
