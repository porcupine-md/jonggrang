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
 * The key this server uses to reach ONE device.
 *
 * Originally there was a single key for every device, which made rotation a
 * footgun: replacing it would silently lock out every other registered machine.
 * A device gets its own key from the moment it rotates (or registers on a version
 * that does this); until then it keeps using the shared one, so existing
 * registrations are unaffected.
 *
 * Per-device also limits the blast radius: a device that reads its own
 * authorized_keys learns nothing about how to reach anyone else's.
 */
function serverKeyFor(device) {
  return device?.agent_key || serverKeyPath();
}

/**
 * Give a device a fresh key of its own and return its public half. The old key
 * file is left on disk — the device stops trusting it the moment its
 * authorized_keys is rewritten, and keeping it costs nothing and makes a botched
 * rotation recoverable by hand.
 */
function rotateDeviceKey(deviceId) {
  const registry = readRegistry();
  const device = registry.devices[deviceId];
  if (!device) throw new Error(`no such device: ${deviceId}`);

  const keyPath = path.join(jonggrangHome(), 'web', 'ssh', `device-agent-${deviceId}.key`);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  for (const p of [keyPath, `${keyPath}.pub`]) {
    try { fs.unlinkSync(p); } catch { /* nothing there */ }
  }
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `jonggrang-device-agent-${deviceId}`, '-f', keyPath],
    { stdio: 'pipe' });
  fs.chmodSync(keyPath, 0o600);

  device.agent_key = keyPath;
  device.agent_key_rotated_at = new Date().toISOString();
  writeRegistry(registry);
  return { path: keyPath, pub: fs.readFileSync(`${keyPath}.pub`, 'utf8').trim() };
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

/**
 * Add or REPLACE the entry for a key. addAuthorizedKey leaves an existing line
 * alone, which is right for "make sure this is allowed" and wrong for "these are
 * now the options" — a device registered before the restrictions existed would
 * keep its unrestricted line forever.
 */
function setAuthorizedKey(entry) {
  const body = keyBody(entry);
  if (!body) throw new Error('not an ssh public key');
  const p = authorizedKeysPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  let lines = [];
  try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { /* first key */ }
  const kept = lines.filter(l => l.trim() && keyBody(l) !== body);
  const changed = kept.length !== lines.filter(Boolean).length;
  kept.push(entry.trim());
  fs.writeFileSync(p, `${kept.join('\n')}\n`);
  fs.chmodSync(p, 0o600);
  return { replaced: changed };
}

/** Where the audit wrapper lives on the device. */
function auditShellPath() {
  return path.join(jonggrangHome(), 'device-audit-shell.sh');
}

function auditLogPath() {
  return path.join(jonggrangHome(), 'device-audit.log');
}

/**
 * Install the audit wrapper on THIS machine (the device). Every command the
 * server sends arrives as `$SSH_ORIGINAL_COMMAND` to this script, which records
 * it here before running it — on the developer's own machine, because a log kept
 * on the server is a log the server can rewrite.
 */
function installAuditShell(jonggrangHomeDir) {
  const src = path.join(jonggrangHomeDir, 'hooks', 'device', 'audit-shell.sh');
  if (!fs.existsSync(src)) throw new Error(`audit wrapper missing at ${src}`);
  const dst = auditShellPath();
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
  return dst;
}

/**
 * What the SERVER's key may do on the device.
 *
 * The grant cannot be removed — running the agent's commands there IS the
 * feature — but everything around it can. `restrict` turns off port forwarding,
 * agent forwarding, X11 and user-rc; `pty` is added back because the Terminal
 * needs one. So a compromised server can run commands as this user, and cannot
 * additionally use the laptop as a jump host or hijack its ssh-agent.
 *
 * And with a wrapper as the forced command, every one of those commands is
 * *recorded on the device* before it runs. Not a restriction — visibility, which
 * is the part §7 left entirely open. The rest of §7 (a scoped account, ephemeral
 * keys) is what actually narrows the grant; see the warning at registration.
 */
function agentKeyEntry(pubkey, wrapper) {
  const forced = wrapper ? `,command="${wrapper}"` : '';
  return `restrict,pty${forced} ${pubkey.trim()}`;
}

/**
 * Revoke a key: drop every entry whose key material matches.
 *
 * Rotation is not rotation without this. `setAuthorizedKey` replaces the entry for
 * the SAME key, so a new key is simply appended and the old one keeps working —
 * which is what happened on the first attempt, while the CLI cheerfully reported
 * that the previous key no longer worked.
 */
function removeAuthorizedKey(pubkey) {
  const body = keyBody(pubkey);
  if (!body) return false;
  const p = authorizedKeysPath();
  let lines;
  try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { return false; }
  const kept = lines.filter(l => l.trim() && keyBody(l) !== body);
  if (kept.length === lines.filter(Boolean).length) return false;
  fs.writeFileSync(p, `${kept.join('\n')}\n`);
  fs.chmodSync(p, 0o600);
  return true;
}

// Comment jonggrang stamps on the keys a server uses to enter a device. It is how
// an old entry can be recognised later — including ones installed before this
// machine started recording which key it trusted.
const AGENT_KEY_COMMENT = 'jonggrang-device-agent';

/**
 * Drop every jonggrang agent key except the one being kept.
 *
 * Revoking by record only works for keys installed after the record existed. A
 * device registered earlier has an entry nothing knows about, so a rotation would
 * leave the old key working while reporting success — measured, after the
 * revoke-by-record fix: the original shared key still opened a session.
 *
 * Scoped to our own comment, so a hand-added key of the user's is never touched.
 */
function revokeOtherAgentKeys(keepPubkey) {
  const keep = keyBody(keepPubkey);
  const p = authorizedKeysPath();
  let lines;
  try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { return 0; }
  const kept = lines.filter((l) => {
    if (!l.trim()) return false;
    const ours = l.includes(AGENT_KEY_COMMENT);
    return !ours || keyBody(l) === keep;
  });
  const dropped = lines.filter(Boolean).length - kept.length;
  if (dropped > 0) {
    fs.writeFileSync(p, `${kept.join('\n')}\n`);
    fs.chmodSync(p, 0o600);
  }
  return dropped;
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
function provisionDevice({ id, label, pubkey, localuser, workdir, owner, platform, rotate }) {
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
    // What `uname -sm` says on the device. The agent runs on the server but its
    // commands run here, so it has to write for THIS platform — see
    // devicePlatformPrompt().
    platform: platform || existing?.platform || null,
    agent_key: existing?.agent_key || null,
    agent_key_rotated_at: existing?.agent_key_rotated_at || null,
    owner: owner || existing?.owner || os.userInfo().username,
    created_at: existing?.created_at || now,
    updated_at: now,
    last_seen: existing?.last_seen || null,
  };
  writeRegistry(registry);

  // Inbound trust: the device opens the reverse tunnel with this key.
  addAuthorizedKey(tunnelKeyEntry(pubkey, port));

  // A device that asks to rotate gets a key of its own; otherwise it keeps
  // whatever it was already trusting.
  if (rotate) {
    const fresh = rotateDeviceKey(deviceId);
    return { device_id: deviceId, port, token, server_pubkey: fresh.pub, rotated: true };
  }
  const existingKey = registry.devices[deviceId].agent_key;
  if (existingKey && fs.existsSync(`${existingKey}.pub`)) {
    return { device_id: deviceId, port, token, server_pubkey: fs.readFileSync(`${existingKey}.pub`, 'utf8').trim() };
  }
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
function buildSshExecArgs(device, cwd, cmd, args = [], envVars = {}, opts = {}) {
  // Two shapes, and using the wrong one hangs.
  //
  // interactive (default) — for the agent and the Terminal: force a pty (-tt) and
  // an interactive login shell (-lic), so TUIs behave and a version manager
  // sourced from .zshrc is on PATH.
  //
  // NON-interactive — for programmatic calls like git: no pty, login shell
  // without -i. With the interactive shape, `git diff --cached` sat on the device
  // for six minutes with a pty nobody was typing into, and because the caller is
  // synchronous the entire dashboard froze behind it. Measured, painfully.
  const interactive = opts.interactive !== false;
  const key = serverKeyFor(device);
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
    remote.push(`exec "$SHELL" ${interactive ? '-lic' : '-lc'} ${shellQuote(inner)}`);
  }

  return [
    ...(interactive ? ['-tt'] : ['-T']),
    '-p', String(device.port),
    '-i', key,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    // Without this every command's output ends with "Connection to localhost
    // closed." — noise in the agent's context, and a tell that it is not running
    // where it thinks it is.
    '-o', 'LogLevel=QUIET',
    `${device.localuser}@localhost`,
    remote.join(' && '),
  ];
}

/**
 * Env the agent needs so the redirect hook can reach the device. The hook is
 * deliberately dumb: everything it needs arrives here, so a copy of it anywhere
 * else is inert.
 */
function deviceRedirectEnv(device, workdir) {
  return {
    JONGGRANG_DEVICE_PORT: String(device.port),
    JONGGRANG_DEVICE_USER: device.localuser,
    JONGGRANG_DEVICE_WORKDIR: workdir || device.workdir || '.',
    JONGGRANG_DEVICE_KEY: serverKeyFor(device),
  };
}

/** Where the server-side redirect bundle lives for a project. */
function deviceBundleDir(projectPath) {
  return path.join(projectPath, '.jonggrang-device');
}

function deviceSettingsPath(projectPath) {
  return path.join(deviceBundleDir(projectPath), 'settings.json');
}

/**
 * Install the server-side redirect bundle for a device project.
 *
 * In a directory of its own — NOT `.claude/` — for two reasons, one of them
 * learned the hard way. `jonggrang init --force` writes the project's
 * `.claude/settings.json`, so a hook merged in there is silently overwritten the
 * first time a device project is initialised; the redirect then stops happening
 * and the agent's commands run on the SERVER, which is exactly the failure this
 * bundle exists to prevent. And `.claude` is seeded into every worktree, which
 * would carry the bundle onto the device — the thing §4 forbids.
 *
 * It is passed to the agent with `--settings` instead, so nothing owns it but us.
 */
function installDeviceHooks(projectPath, jonggrangHome) {
  const src = path.join(jonggrangHome, 'hooks', 'device', 'redirect-bash.sh');
  if (!fs.existsSync(src)) throw new Error(`device hook bundle missing at ${src}`);

  const dir = deviceBundleDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'redirect-bash.sh');
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);

  const settingsPath = deviceSettingsPath(projectPath);
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash "${dst}"` }] }],
    },
  }, null, 2)}\n`);
  return { hook: dst, settings: settingsPath, installed: true };
}

// ── the mount: the agent's files ARE the device's files (§5) ─────
//
// The Bash redirect alone gives a split view — commands run on the device while
// the agent's own Read/Edit act on the server — and a real agent notices and
// says so. The mount closes it: the device's project is sshfs'd onto the server,
// so the file tools operate on the same bytes Bash does.
//
// Mounted at the SAME ABSOLUTE PATH as on the device, which matters more than it
// looks. Mounted anywhere else the files agree but the paths do not, and a path
// the agent reads from one tool is invalid in the other — measured: an agent
// asked to compare them reported "a naked path string is not portable between my
// file tools and Bash". Same path, and the two are indistinguishable.

function mountPointFor(device, workdir) {
  return workdir || device.workdir;
}

/**
 * Is a mount actually usable, or is it the corpse of one?
 *
 * When the tunnel dies the sshfs mount stays registered and every access returns
 * EIO. For an agent that is worse than no mount at all: instead of "the laptop is
 * offline" it gets `Input/output error` on every file and sets about diagnosing a
 * broken filesystem. So health is a separate question from presence.
 *
 * Probed out-of-process with a timeout: a hung FUSE mount would block a sync fs
 * call, and this runs inside the dashboard.
 */
function mountHealthy(mountPoint, timeoutSec = 3) {
  // spawnSync's own timeout, not timeout(1) — that binary does not exist on
  // macOS, where this returned false for every mount including healthy ones.
  const res = spawnSync('ls', ['-1', mountPoint], { encoding: 'utf8', timeout: timeoutSec * 1000 });
  return !res.error && res.status === 0;
}

function isMounted(mountPoint) {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .some(line => line.split(' ')[1] === mountPoint && /fuse/.test(line));
  } catch {
    // No /proc (macOS): fall back to asking mount(8).
    const res = spawnSync('sh', ['-c', `mount | grep -F ${shellQuote(mountPoint)}`], { encoding: 'utf8' });
    return res.status === 0 && Boolean(String(res.stdout || '').trim());
  }
}

/**
 * sshfs the device's project onto this server at the same path. Idempotent.
 *
 * Refuses when that path already holds something of the server's own — a device
 * whose workdir collides with a real server directory would otherwise have its
 * mount shadow it, and the failure would look like missing files rather than a
 * name clash.
 */
function mountDevice(device, workdir) {
  const mountPoint = mountPointFor(device, workdir);
  if (!mountPoint) throw new Error('device has no workdir to mount');

  if (isMounted(mountPoint)) {
    if (mountHealthy(mountPoint)) return { mountPoint, mounted: false, reused: true };
    // Present but dead — the tunnel dropped under it. Clear it and mount again,
    // rather than handing the agent a directory that answers EIO.
    if (!unmountDevice(device, workdir)) {
      throw new Error(`${mountPoint} is mounted but unusable, and could not be unmounted`);
    }
  }

  if (fs.existsSync(mountPoint)) {
    const entries = fs.readdirSync(mountPoint);
    if (entries.length) {
      throw new Error(`${mountPoint} already exists on this server and is not empty — a device mount there would shadow it`);
    }
  } else {
    fs.mkdirSync(mountPoint, { recursive: true });
  }

  const opts = [
    `IdentityFile=${serverKeyFor(device)}`,
    'IdentitiesOnly=yes',
    'StrictHostKeyChecking=accept-new',
    'BatchMode=yes',
    'reconnect',
    'ServerAliveInterval=15',
    // Follow the device's own symlinks rather than exposing them as broken.
    'follow_symlinks',
  ].join(',');

  const res = spawnSync('sshfs', [
    '-p', String(device.port),
    '-o', opts,
    `${device.localuser}@localhost:${mountPoint}`,
    mountPoint,
  ], { encoding: 'utf8' });

  if (res.error) throw new Error(`sshfs failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`sshfs failed: ${(res.stderr || res.stdout || '').trim()}`);

  // sshfs daemonises: the command returns as soon as it forks, and the mount is
  // not usable for a moment after. A caller that looks immediately sees an empty
  // directory — which is how a resumed run concluded its worktree was gone and
  // tried to create one that already existed, three error messages away from the
  // real cause. Wait for it to answer before saying it is mounted.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (mountHealthy(mountPoint, 2)) return { mountPoint, mounted: true };
    spawnSync('sleep', ['0.2']);
  }
  throw new Error(`${mountPoint} was mounted but never became readable`);
}

function unmountDevice(device, workdir) {
  const mountPoint = mountPointFor(device, workdir);
  if (!mountPoint || !isMounted(mountPoint)) return false;
  // A mount whose far end is gone will not unmount cleanly, so the lazy forms
  // are here on purpose — otherwise the dead mount is unremovable and the next
  // mount attempt has nowhere to go.
  const attempts = [
    ['fusermount', '-u', mountPoint],
    ['fusermount', '-uz', mountPoint],
    ['umount', mountPoint],
    ['umount', '-l', mountPoint],
  ];
  for (const argv of attempts) {
    const res = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    if (!res.error && res.status === 0) return true;
  }
  return false;
}

/**
 * The device's platform (`uname -sm`), learned once and remembered.
 *
 * Registration reports it, but a device registered before that did not — and
 * getting this wrong has teeth: an agent that assumes the server's platform
 * writes `sed -i 's/x/y/'` for GNU sed and gets "invalid command code" from the
 * BSD one on a Mac. Measured, not hypothetical.
 */
function devicePlatform(deviceId) {
  const registry = readRegistry();
  const device = registry.devices[deviceId];
  if (!device) return null;
  if (device.platform) return device.platform;

  const res = spawnSync('ssh', buildSshExecArgs(device, null, 'uname', ['-sm']), { encoding: 'utf8' });
  const out = String(res.stdout || '').split('\n').map(l => l.trim()).filter(Boolean).pop();
  if (!out || res.status !== 0) return null;

  registry.devices[deviceId].platform = out;
  writeRegistry(registry);
  return out;
}

/**
 * What the agent needs to know that it cannot see: its Bash does not run where
 * it does. Without this it writes commands for its own platform — GNU coreutils
 * syntax against BSD userland — and they fail for reasons it cannot diagnose.
 */
function devicePlatformPrompt(device, platform, workdir) {
  const where = platform ? `${platform.trim()}` : 'a different machine';
  return [
    'EXECUTION CONTEXT: your Bash tool does not run on this host.',
    `Every shell command is executed on the device "${device.label}" (${where}) in ${workdir}, over ssh.`,
    'Your file tools read and write those same files through a mount at the same paths, so paths are portable.',
    'Write shell commands for the DEVICE\'s platform — e.g. BSD utilities on Darwin (`sed -i \'\'`), not GNU syntax — regardless of what this host runs.',
  ].join(' ');
}

/** The registry entry for a project's device, or null when it is gone. */
function deviceFor(deviceId) {
  if (!deviceId) return null;
  const device = readRegistry().devices[deviceId];
  // The registry is keyed by id, so the entry itself does not carry one — and
  // callers need it (worktree paths are keyed by id precisely because it cannot
  // change under them).
  return device ? { id: deviceId, ...device } : null;
}

/**
 * Point this server's copy of a device project at the device's own state.
 *
 * jonggrang reads and writes project state (drafts, features, tasks) through
 * `project.path` in twenty-odd places. For a device project that state belongs
 * WITH the code — on the device — so rather than thread a second path through all
 * of them, `<project.path>/.jonggrang` becomes a symlink to `<workdir>/.jonggrang`
 * on the mount. Every existing read lands on the device, and the agent, whose cwd
 * is the device path, sees the same directory by its own name.
 *
 * Only `.jonggrang` is linked. The redirect bundle stays server-side
 * (`<project.path>/.claude`, `/hooks`), because per §4 it must never end up on
 * the device.
 *
 * A dangling link (device unmounted) reads as ENOENT, which is the honest answer
 * — "not there right now" rather than an EIO nobody can interpret.
 */
function linkProjectState(project, workdir) {
  const link = path.join(project.path, '.jonggrang');
  const target = path.join(workdir, '.jonggrang');

  let current = null;
  try { current = fs.readlinkSync(link); } catch { /* not a link */ }
  if (current === target) return { link, target, created: false };

  if (current !== null) {
    fs.unlinkSync(link);
  } else if (fs.existsSync(link)) {
    // A real directory here means state was written server-side before the
    // project was device-bound. Moving it silently would be worse than saying so.
    const entries = fs.readdirSync(link);
    if (entries.length) throw new Error(`${link} holds server-side state; move it onto the device before linking`);
    fs.rmdirSync(link);
  }

  fs.mkdirSync(project.path, { recursive: true });
  try { fs.mkdirSync(target, { recursive: true }); } catch { /* unmounted; the link may dangle */ }
  fs.symlinkSync(target, link);
  return { link, target, created: true };
}

// ── worktrees on the device (P5) ─────────────────────────────────
//
// The repo is on the device, so its worktrees are too: `git worktree add` has to
// run where the repository is. The orchestrator and the agent still run on the
// server, over a mount of that worktree at the same absolute path — the same
// arrangement as a single-project mount, one per plan.

/**
 * Where a plan's worktree lives ON THE DEVICE.
 *
 * Keyed by device ID, not label. The first version used the label and it broke the
 * moment one changed — re-registering without `--label` defaults to the hostname,
 * so `anak10thn-mini` became `anak10thn-mini.local`, every existing worktree path
 * moved, and the mount failed with a "No such file or directory" three error
 * messages away from the cause. A path derived from a mutable name is a path that
 * will move under you.
 */
function deviceWorktreePath(device, featureId) {
  const id = String(device.id || device.device_id || device.label || 'device').replace(/[^A-Za-z0-9._-]/g, '_');
  return `/tmp/jonggrang-worktrees/${id}/${featureId}`;
}

/** Run a command on the device and return its stdout, throwing on failure. */
function deviceExec(device, cwd, cmd, args = [], { timeoutSec = 120 } = {}) {
  const argv = buildSshExecArgs(device, cwd, cmd, args, {}, { interactive: false });
  // A timeout as well as the right shape: this is called synchronously from the
  // dashboard, so a command that never returns takes the whole server with it.
  const res = spawnSync('ssh', argv, { encoding: 'utf8', timeout: timeoutSec * 1000 });
  if (res.error) throw new Error(`ssh to ${device.label} failed: ${res.error.message}`);
  const out = String(res.stdout || '');
  if (res.status !== 0) {
    throw new Error(`${cmd} on ${device.label} failed (${res.status}): ${(res.stderr || out).trim().slice(-400)}`);
  }
  return out;
}

/**
 * Create (or adopt) a git worktree for a plan, on the device, and mount it here.
 *
 * `git worktree add` is idempotent only if you check first: a second add on the
 * same path fails, and so does one on an existing branch. Both are normal when a
 * run is resumed, so both are treated as "already there".
 */
function ensureDeviceWorktree(device, repoDir, featureId, branch, baseRef) {
  const wt = deviceWorktreePath(device, featureId);
  const exists = (() => {
    try { deviceExec(device, wt, 'git', ['rev-parse', '--git-dir']); return true; } catch { return false; }
  })();

  if (!exists) {
    const hasBranch = (() => {
      try { deviceExec(device, repoDir, 'git', ['rev-parse', '--verify', `refs/heads/${branch}`]); return true; } catch { return false; }
    })();
    const argv = hasBranch
      ? ['worktree', 'add', wt, branch]
      : ['worktree', 'add', '-b', branch, wt, baseRef || 'HEAD'];
    deviceExec(device, repoDir, 'git', argv);
  }

  const baseSha = deviceExec(device, wt, 'git', ['rev-parse', 'HEAD']).trim().split('\n').pop();
  const mount = mountDevice(device, wt);
  return { worktreePath: wt, branch, baseSha, created: !exists, mountPoint: mount.mountPoint };
}

/** Drop the mount, then the worktree itself. Order matters — a mounted worktree cannot be removed. */
function removeDeviceWorktree(device, repoDir, featureId) {
  const wt = deviceWorktreePath(device, featureId);
  unmountDevice(device, wt);
  try { deviceExec(device, repoDir, 'git', ['worktree', 'remove', '--force', wt]); return true; }
  catch { return false; }
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
function requestProvision({ server, pubkey, label, localuser, workdir, id, sshArgs = [], remoteBin, platform, rotate }) {
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
  if (platform) argv.push('--platform', shellQuote(platform));
  if (rotate) argv.push('--rotate');
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
  serverKeyPath, serverKeyFor, ensureServerKey, rotateDeviceKey,
  provisionDevice, listDevices, listDevicesLive, removeDevice, touchDevice,
  buildSshExecArgs, deviceFor, deviceRedirectEnv, installDeviceHooks,
  deviceBundleDir, deviceSettingsPath,
  mountDevice, unmountDevice, isMounted, mountHealthy, mountPointFor,
  devicePlatform, devicePlatformPrompt,
  deviceWorktreePath, deviceExec, ensureDeviceWorktree, removeDeviceWorktree,
  linkProjectState,
  portListening,
  // keys
  authorizedKeysPath, addAuthorizedKey, setAuthorizedKey, removeAuthorizedKey, revokeOtherAgentKeys,
  AGENT_KEY_COMMENT, keyBody, tunnelKeyEntry, agentKeyEntry,
  auditShellPath, auditLogPath, installAuditShell,
  // local
  deviceConfigPath, readDeviceConfig, writeDeviceConfig,
  ensureDeviceKey, requestProvision,
  // tunnel
  tunnelPidPath, tunnelArgv, tunnelUp, tunnelDown, tunnelStatus, hasAutossh,
};
