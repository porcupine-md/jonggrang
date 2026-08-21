'use strict';

// Local-sandbox devices: the agent runs on a jonggrang server, the code stays on
// the developer's machine, and a REVERSE ssh tunnel lets the server reach back in.
// See docs/plans/2026-07-07-local-sandbox-remote-agent.md — this module is P0
// (registration + two-way key exchange) and P1 (tunnel lifecycle). The agent
// transport (P2+) is deliberately not here yet.
//
// Two sides, two state files:
//   server  ~/.jonggrang/web/devices.json   registry: id → { port, pubkey, … }
//   local   ~/.jonggrang/device.json        this machine's own registration
//
// Registration runs over SSH rather than HTTP. The dashboard usually listens on
// loopback (or the docker bridge) and is not reachable from the developer's
// machine, while local→server SSH has to work anyway or the tunnel cannot be
// opened at all. So `device register` uses the trust it already needs.

const { execFileSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// Reverse-tunnel ports live on the SERVER loopback, one reserved per device.
// Chosen high and out of the way; a device keeps its port across re-registration
// so the server's config for it never has to change.
const PORT_MIN = 22000;
const PORT_MAX = 22999;

function jonggrangHome() {
  return path.join(os.homedir(), '.jonggrang');
}

// ── server side: the device registry ─────────────────────────────

function registryPath() {
  return path.join(process.env.JONGGRANG_WEB_HOME || path.join(jonggrangHome(), 'web'), 'devices.json');
}

function readRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    if (raw && typeof raw.devices === 'object' && raw.devices) return raw;
  } catch { /* absent or unreadable — start empty */ }
  return { version: 1, devices: {} };
}

function writeRegistry(registry) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

/**
 * Lowest free port in the range. A device that re-registers keeps the port it
 * already has (callers pass its current value through), so the server-side
 * config for a device is stable.
 */
function reservePort(registry, exceptId = null) {
  const taken = new Set(
    Object.entries(registry.devices)
      .filter(([id]) => id !== exceptId)
      .map(([, d]) => d.port)
  );
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!taken.has(p)) return p;
  throw new Error(`no free tunnel port in ${PORT_MIN}-${PORT_MAX} (${taken.size} devices registered)`);
}

// ── server side: the key the agent uses to enter a device ─────────

function serverKeyPath() {
  return path.join(jonggrangHome(), 'web', 'ssh', 'device-agent.key');
}

/**
 * The server's own keypair for reaching INTO devices. One key for all devices:
 * the developer pastes its public half into their authorized_keys once, and it
 * keeps working when they re-register. Returns { path, pub }.
 */
function ensureServerKey() {
  const keyPath = serverKeyPath();
  const pubPath = `${keyPath}.pub`;
  if (!fs.existsSync(keyPath) || !fs.existsSync(pubPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    try { fs.unlinkSync(keyPath); } catch { /* nothing to remove */ }
    try { fs.unlinkSync(pubPath); } catch { /* nothing to remove */ }
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'jonggrang-device-agent', '-f', keyPath],
      { stdio: 'pipe' });
    fs.chmodSync(keyPath, 0o600);
  }
  return { path: keyPath, pub: fs.readFileSync(pubPath, 'utf8').trim() };
}

// ── authorized_keys, both directions ─────────────────────────────

function authorizedKeysPath() {
  return path.join(os.homedir(), '.ssh', 'authorized_keys');
}

/**
 * Append an authorized_keys entry unless its key material is already present.
 * Matching is on the key body, not the whole line: the same key with different
 * options must not be added twice, and the caller's options win.
 */
function addAuthorizedKey(entry) {
  const body = keyBody(entry);
  if (!body) throw new Error('not an ssh public key');
  const p = authorizedKeysPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  let existing = '';
  try { existing = fs.readFileSync(p, 'utf8'); } catch { /* first key */ }
  if (existing.split('\n').some(line => keyBody(line) === body)) return false;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(p, `${sep}${entry.trim()}\n`);
  fs.chmodSync(p, 0o600);
  return true;
}

// The `type base64` pair, ignoring any leading options and trailing comment.
function keyBody(line) {
  const parts = String(line || '').trim().split(/\s+/);
  const i = parts.findIndex(t => /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-\S+)$/.test(t));
  if (i < 0 || !parts[i + 1]) return null;
  return `${parts[i]} ${parts[i + 1]}`;
}

/**
 * What the DEVICE's key is allowed to do on the server: open its own reverse
 * tunnel, nothing else.
 *
 * `restrict` alone is not enough, and the e2e caught it: it disables the pty and
 * the forwardings, but a non-interactive `ssh server <cmd>` still RUNS — the
 * device key got a shell. A forced `command` is what refuses execution. It does
 * not interfere with the tunnel, because `ssh -N` never asks for a session, so
 * the forced command is never reached.
 *
 * `permitlisten` (OpenSSH 7.5+, 2017) is what confines the key to its own port;
 * verified by a rejected attempt to bind a different one.
 */
function tunnelKeyEntry(pubkey, port) {
  return 'restrict,port-forwarding,'
    + `permitlisten="localhost:${port}",`
    + 'command="/bin/false # jonggrang device tunnel: forwarding only" '
    + pubkey.trim();
}

// ── server side: provisioning ────────────────────────────────────

function deviceIdFor(label) {
  const slug = String(label || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `dev_${slug || 'device'}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Register (or re-register) a device on this server. Idempotent by id: the port
 * and token survive, so a device that re-runs registration keeps working.
 *
 * Returns what the device needs to finish setup: its id, the reserved port, its
 * token, and the server's public key to authorize inbound.
 */
function provisionDevice({ id, label, pubkey, localuser, workdir, owner }) {
  if (!pubkey || !keyBody(pubkey)) throw new Error('a device public key is required');
  const registry = readRegistry();
  const deviceId = id && registry.devices[id] ? id : (id || deviceIdFor(label));
  const existing = registry.devices[deviceId] || null;

  const port = existing?.port || reservePort(registry, deviceId);
  const token = existing?.token || crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();

  registry.devices[deviceId] = {
    label: label || existing?.label || deviceId,
    pubkey: keyBody(pubkey),
    port,
    token,
    localuser: localuser || existing?.localuser || null,
    workdir: workdir || existing?.workdir || null,
    owner: owner || existing?.owner || os.userInfo().username,
    created_at: existing?.created_at || now,
    updated_at: now,
    last_seen: existing?.last_seen || null,
  };
  writeRegistry(registry);

  // Inbound trust: the device opens the reverse tunnel with this key.
  addAuthorizedKey(tunnelKeyEntry(pubkey, port));

  const server = ensureServerKey();
  return { device_id: deviceId, port, token, server_pubkey: server.pub };
}

function listDevices() {
  const registry = readRegistry();
  return Object.entries(registry.devices).map(([id, d]) => ({
    id,
    label: d.label,
    port: d.port,
    localuser: d.localuser,
    workdir: d.workdir,
    owner: d.owner,
    created_at: d.created_at,
    last_seen: d.last_seen,
    // The tunnel is up when something is listening on the device's reserved
    // loopback port. Cheap, and true regardless of which process opened it.
    online: false,
  }));
}

function removeDevice(id) {
  const registry = readRegistry();
  if (!registry.devices[id]) return false;
  delete registry.devices[id];
  writeRegistry(registry);
  return true;
}

function touchDevice(id) {
  const registry = readRegistry();
  if (!registry.devices[id]) return false;
  registry.devices[id].last_seen = new Date().toISOString();
  writeRegistry(registry);
  return true;
}

/** Is anything listening on this loopback port? (server-side liveness probe) */
function portListening(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function listDevicesLive() {
  const devices = listDevices();
  for (const d of devices) d.online = await portListening(d.port);
  return devices;
}

// ── server side: reaching into a device (P2 transport) ───────────

/**
 * How the server runs something ON a device: an ssh session through that
 * device's reserved loopback port, authenticated with the server's agent key.
 * Returns argv for `ssh`, suitable for node-pty — the plan's §3 note that the
 * transport is "just a PTY whose child is ssh".
 *
 * Two details the e2e forced:
 *
 * - The command runs under the device's **login shell**, not directly. A device's
 *   toolchain usually lives behind a version manager sourced from an rc file that
 *   a plain `ssh host cmd` never reads — `node` was simply not found until this
 *   went through a shell that loads it. `-i` matters as much as `-l`: zsh reads
 *   .zshrc only when interactive, and that is where nvm normally is.
 * - `-tt` forces a pty on the remote side even though ssh's own stdin is one,
 *   which is what makes interactive tools (and Ctrl-C) behave.
 */
function buildSshExecArgs(device, cwd, cmd, args = [], envVars = {}) {
  const key = serverKeyPath();
  const remote = [];
  if (cwd) remote.push(`cd ${shellQuote(cwd)} || exit 1`);

  const assigns = Object.entries(envVars || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${shellQuote(String(v))}`);

  // No command means "give me a shell" — the Terminal tab's case.
  const bare = !cmd || /(^|\/)(sh|bash|zsh|fish)$/.test(String(cmd));
  if (bare) {
    remote.push(`${assigns.join(' ')} exec "$SHELL" -l`.trim());
  } else {
    const inner = [...assigns, shellQuote(cmd), ...args.map(shellQuote)].join(' ');
    remote.push(`exec "$SHELL" -lic ${shellQuote(inner)}`);
  }

  return [
    '-tt',
    '-p', String(device.port),
    '-i', key,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    `${device.localuser}@localhost`,
    remote.join(' && '),
  ];
}

/** The registry entry for a project's device, or null when it is gone. */
function deviceFor(deviceId) {
  if (!deviceId) return null;
  return readRegistry().devices[deviceId] || null;
}

// ── local side: this machine's registration ──────────────────────

function deviceConfigPath() {
  return path.join(jonggrangHome(), 'device.json');
}

function readDeviceConfig() {
  try { return JSON.parse(fs.readFileSync(deviceConfigPath(), 'utf8')); } catch { return null; }
}

function writeDeviceConfig(cfg) {
  const p = deviceConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

/**
 * The key this machine opens the tunnel with — always a dedicated one, never the
 * developer's personal key.
 *
 * Reusing a personal key cannot work: the server authorizes the tunnel key as
 * `permitlisten` for one port and nothing else. If that key were also the one
 * the developer ssh's in with, either sshd matches the unrestricted entry first
 * and the restriction is decoration, or the developer loses their own shell
 * access. A separate key is the only shape where both hold.
 */
function ensureDeviceKey() {
  const keyPath = path.join(jonggrangHome(), 'device.key');
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `jonggrang-device-${os.hostname()}`, '-f', keyPath],
      { stdio: 'pipe' });
    fs.chmodSync(keyPath, 0o600);
  }
  return { path: keyPath, pub: fs.readFileSync(`${keyPath}.pub`, 'utf8').trim(), generated: true };
}

/**
 * Ask the server to provision this device, by running `jonggrang device
 * provision` there over SSH. Returns the parsed JSON the server printed.
 *
 * The remote command reads the pubkey from stdin: a public key is one long line
 * that would otherwise have to survive shell quoting on the way over.
 */
function requestProvision({ server, pubkey, label, localuser, workdir, id, sshArgs = [], remoteBin }) {
  // A non-interactive ssh session gets a minimal PATH, so the server's
  // jonggrang is not always on it — `ssh host jonggrang` can fail on a machine
  // where the interactive shell finds it fine. Callers can name the binary (or
  // any command that runs it) instead of guessing.
  const remote = String(remoteBin || process.env.JONGGRANG_REMOTE_BIN || 'jonggrang').trim().split(/\s+/);
  const argv = [
    ...sshArgs, server,
    ...remote, 'device', 'provision',
    '--label', shellQuote(label),
    '--localuser', shellQuote(localuser),
    '--pubkey-stdin', '--json',
  ];
  if (workdir) argv.push('--workdir', shellQuote(workdir));
  if (id) argv.push('--id', shellQuote(id));

  const res = spawnSync('ssh', argv, { input: `${pubkey}\n`, encoding: 'utf8' });
  if (res.error) throw new Error(`ssh failed: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`server refused registration (exit ${res.status}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  const line = String(res.stdout || '').split('\n').reverse().find(l => l.trim().startsWith('{'));
  if (!line) throw new Error(`server did not return registration JSON: ${(res.stdout || '').trim()}`);
  return JSON.parse(line);
}

// Single-quote for the remote shell. The values are a hostname, a username and
// a path, but they cross a shell boundary, so they get quoted rather than trusted.
function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

// ── local side: tunnel lifecycle (P1) ────────────────────────────

function tunnelPidPath() {
  return path.join(jonggrangHome(), 'tunnel.pid');
}

function hasAutossh() {
  const res = spawnSync('sh', ['-c', 'command -v autossh'], { encoding: 'utf8' });
  return res.status === 0 && Boolean(String(res.stdout || '').trim());
}

/**
 * The reverse tunnel: bind the device's reserved port on the SERVER's loopback
 * and forward it to sshd here. `-R` on loopback is why the port is not exposed
 * to the internet — only processes on the server can use it.
 *
 * autossh when present (it re-dials on drop), plain ssh with keepalives
 * otherwise. `-N` because the tunnel carries no command of its own.
 */
function tunnelArgv(cfg, { useAutossh = hasAutossh() } = {}) {
  const ssh = [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];
  // Offer ONLY the registered key. Without this ssh may authenticate with some
  // other key the server happens to accept, and the `permitlisten` restriction
  // attached to the registered one never applies — the tunnel would work while
  // the restriction quietly did nothing.
  if (cfg.key_path) ssh.push('-i', cfg.key_path, '-o', 'IdentitiesOnly=yes');
  ssh.push('-R', `${cfg.port}:localhost:${cfg.local_ssh_port || 22}`, cfg.server);
  return useAutossh
    ? { cmd: 'autossh', args: ['-M', '0', ...ssh] }
    : { cmd: 'ssh', args: ssh };
}

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(tunnelPidPath(), 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function tunnelUp(cfg, { detach = true } = {}) {
  const running = readPid();
  if (pidAlive(running)) return { started: false, pid: running };

  const { cmd, args } = tunnelArgv(cfg);
  const child = spawn(cmd, args, {
    detached: detach,
    stdio: detach ? 'ignore' : 'inherit',
  });
  if (detach) child.unref();
  fs.mkdirSync(path.dirname(tunnelPidPath()), { recursive: true });
  fs.writeFileSync(tunnelPidPath(), `${child.pid}\n`);
  return { started: true, pid: child.pid, cmd, args };
}

function tunnelDown() {
  const pid = readPid();
  if (!pidAlive(pid)) {
    try { fs.unlinkSync(tunnelPidPath()); } catch { /* already gone */ }
    return { stopped: false };
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* raced with its own exit */ }
  try { fs.unlinkSync(tunnelPidPath()); } catch { /* already gone */ }
  return { stopped: true, pid };
}

/**
 * Tunnel state as this machine can see it. The pid says a client is running;
 * whether the far end is actually forwarding is only knowable from the server,
 * so that is reported separately (see listDevicesLive).
 */
function tunnelStatus(cfg) {
  const pid = readPid();
  return {
    configured: Boolean(cfg),
    server: cfg?.server || null,
    port: cfg?.port || null,
    pid: pidAlive(pid) ? pid : null,
    running: pidAlive(pid),
    supervisor: hasAutossh() ? 'autossh' : 'ssh',
  };
}

module.exports = {
  PORT_MIN, PORT_MAX,
  // server
  registryPath, readRegistry, writeRegistry, reservePort,
  serverKeyPath, ensureServerKey,
  provisionDevice, listDevices, listDevicesLive, removeDevice, touchDevice,
  buildSshExecArgs, deviceFor,
  portListening,
  // keys
  authorizedKeysPath, addAuthorizedKey, keyBody, tunnelKeyEntry,
  // local
  deviceConfigPath, readDeviceConfig, writeDeviceConfig,
  ensureDeviceKey, requestProvision,
  // tunnel
  tunnelPidPath, tunnelArgv, tunnelUp, tunnelDown, tunnelStatus, hasAutossh,
};
