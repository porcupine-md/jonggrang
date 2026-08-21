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
    'the key is confined to forwarding its own port');
  // `restrict` disables the pty and forwardings but still RUNS `ssh host <cmd>`
  // — measured against a real sshd, the device key got a shell. Only a forced
  // command refuses execution, and `ssh -N` never reaches it.
  assert.match(forA[0], /command="\/bin\/false/,
    'a forced command is what actually refuses execution');
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

// Without this the server-side permitlisten restriction is decoration: ssh would
// authenticate with whatever other key the server accepts.
test('the tunnel offers only the registered key', () => {
  const { args } = tunnel.tunnelArgv({ server: 'sj', port: 22042, key_path: '/home/me/.jonggrang/device.key' }, { useAutossh: false });
  assert.equal(args[args.indexOf('-i') + 1], '/home/me/.jonggrang/device.key');
  assert.ok(args.includes('IdentitiesOnly=yes'), 'no other identity may be tried');
});

test('the device key is dedicated, never the personal ssh key', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-dev-key-'));
  const prev = process.env.HOME;
  process.env.HOME = fresh;
  try {
    // A personal key exists and must NOT be picked: the server restricts the
    // registered key to port-forwarding only.
    fs.mkdirSync(path.join(fresh, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.ssh', 'id_ed25519'), 'x');
    fs.writeFileSync(path.join(fresh, '.ssh', 'id_ed25519.pub'), KEY_A);
    const key = tunnel.ensureDeviceKey();
    assert.match(key.path, /\.jonggrang\/device\.key$/);
    assert.equal(key.generated, true);
    assert.notEqual(tunnel.keyBody(key.pub), tunnel.keyBody(KEY_A), 'not the personal key');
  } finally { process.env.HOME = prev; }
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

// ── reaching into a device (the P2 transport) ────────────────────

test('the exec argv reaches the device through its own port with the agent key', () => {
  const args = tunnel.buildSshExecArgs({ port: 22042, localuser: 'me' }, '/tmp/proj', null, [], {});
  assert.equal(args[args.indexOf('-p') + 1], '22042', 'the device is reached on its reserved port');
  assert.match(args[args.indexOf('-i') + 1], /device-agent\.key$/, 'authenticated as the server, not as anyone else');
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('-tt'), 'force a remote pty so interactive tools and Ctrl-C behave');
  assert.equal(args[args.length - 2], 'me@localhost', 'through the tunnel, so the far end is loopback here');
});

test('a bare shell request lands in the project directory as a login shell', () => {
  const args = tunnel.buildSshExecArgs({ port: 1, localuser: 'me' }, '/tmp/proj', '/bin/zsh', [], {});
  const remote = args[args.length - 1];
  assert.match(remote, /^cd '\/tmp\/proj' \|\| exit 1 && exec "\$SHELL" -l$/,
    'the device chooses its own shell, and -l loads its environment');
});

// A device's toolchain usually sits behind a version manager sourced from an rc
// file. zsh reads .zshrc only when interactive, so -i is as load-bearing as -l:
// without it `node` is simply not found, which is what the e2e hit.
//
// The remote string carries two levels of quoting — one so each argv token
// survives, one so the whole command survives being an argument to -lic. That is
// correct but unreadable, so these tests unwrap it with a real shell instead of
// asserting on the escaped text.
function unwrapLic(remote) {
  const payload = remote.slice(remote.indexOf('-lic ') + 5);
  const res = require('child_process').spawnSync('sh', ['-c', `printf '%s' ${payload}`], { encoding: 'utf8' });
  assert.equal(res.status, 0, `the payload must be valid shell: ${payload}`);
  return res.stdout;
}

test('a command runs through an interactive login shell', () => {
  const args = tunnel.buildSshExecArgs({ port: 1, localuser: 'me' }, '/tmp/proj', 'npm', ['test'], {});
  const remote = args[args.length - 1];
  assert.match(remote, /exec "\$SHELL" -lic /);
  assert.equal(unwrapLic(remote), "'npm' 'test'", 'what the login shell is asked to run');
});

test('env vars and paths are quoted, not interpolated', () => {
  const args = tunnel.buildSshExecArgs({ port: 1, localuser: 'me' }, "/tmp/it's here", 'echo', ['a b'], { TOK: "x'y" });
  const remote = args[args.length - 1];
  const q = String.fromCharCode(39), bs = String.fromCharCode(92);
  assert.ok(remote.startsWith("cd " + q + "/tmp/it" + q + bs + q + q + "s here" + q), 'a path with a quote survives');
  // One more unwrap and the tokens are intact — a secret containing a quote
  // cannot end the string early and turn the rest into commands.
  const expected = "TOK=" + q + "x" + q + bs + q + q + "y" + q + " " + q + "echo" + q + " " + q + "a b" + q;
  assert.equal(unwrapLic(remote), expected, 'a secret with a quote cannot end the string early');
});

test('deviceFor returns null for a device that is gone', () => {
  assert.equal(tunnel.deviceFor('dev_nope'), null);
  assert.equal(tunnel.deviceFor(null), null);
});

// ── the mount (§5) ───────────────────────────────────────────────
//
// The redirect alone gave a split view: Bash on the device, Read on the server.
// The mount closes it — and it has to be at the SAME absolute path, or the files
// agree while the paths do not. Measured with a real agent: mounted elsewhere it
// reported "a naked path string is not portable between my file tools and Bash";
// mounted at the same path it read a file and ran the suite without noticing.

test('the mount point is the path the device itself uses', () => {
  assert.equal(tunnel.mountPointFor({ workdir: '/tmp/app' }), '/tmp/app');
  assert.equal(tunnel.mountPointFor({ workdir: '/tmp/app' }, '/tmp/other'), '/tmp/other',
    'an explicit workdir wins, but it is still the device-side path');
});

test('nothing is reported mounted when nothing is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-mnt-'));
  assert.equal(tunnel.isMounted(dir), false);
  assert.equal(tunnel.unmountDevice({ workdir: dir }), false, 'unmounting what is not mounted is not an error');
});

test('mounting refuses to shadow a directory the server already uses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-mnt-busy-'));
  fs.writeFileSync(path.join(dir, 'server-own-file.txt'), 'x');
  assert.throws(
    () => tunnel.mountDevice({ port: 1, localuser: 'me', workdir: dir }),
    /already exists on this server and is not empty/,
    'a workdir colliding with a real server path must fail by name, not by mounting over it'
  );
});

test('mounting a device with no workdir is refused', () => {
  assert.throws(() => tunnel.mountDevice({ port: 1, localuser: 'me' }), /no workdir/);
});

// ── telling the agent where its commands run ─────────────────────
//
// The agent runs on the server and its Bash on the device, and it cannot see
// that. Left to guess it writes for its own platform: believing itself on Linux
// it produced `sed -i 's/x/y/'` and got "invalid command code" from BSD sed on a
// Mac. Told the truth, it wrote `sed -i '' 's/x/y/'` and the file changed.

test('the platform prompt names the device, its platform and the workdir', () => {
  const p = tunnel.devicePlatformPrompt({ label: 'my-mac' }, 'Darwin arm64', '/tmp/app');
  assert.match(p, /does not run on this host/);
  assert.match(p, /"my-mac" \(Darwin arm64\)/);
  assert.match(p, /\/tmp\/app/);
  assert.match(p, /BSD utilities on Darwin/, 'concrete enough to change what it writes');
  assert.match(p, /same paths, so paths are portable/, 'and that paths ARE shared, so it does not work around that too');
});

test('an unknown platform still says the commands run elsewhere', () => {
  const p = tunnel.devicePlatformPrompt({ label: 'my-mac' }, null, '/tmp/app');
  assert.match(p, /a different machine/);
  assert.match(p, /does not run on this host/);
});

test('provisioning remembers the platform the device reported', () => {
  const r = tunnel.provisionDevice({ label: 'plat', pubkey: KEY_A, localuser: 'me', platform: 'Darwin arm64' });
  const listed = tunnel.readRegistry().devices[r.device_id];
  assert.equal(listed.platform, 'Darwin arm64');
  // Re-registering without one must not forget it.
  tunnel.provisionDevice({ id: r.device_id, label: 'plat', pubkey: KEY_A, localuser: 'me' });
  assert.equal(tunnel.readRegistry().devices[r.device_id].platform, 'Darwin arm64');
});

// ── mount lifecycle ─────────────────────────────────────────────
//
// A mount whose tunnel died stays registered and answers EIO on every access.
// For an agent that is worse than no mount: instead of "the laptop is offline" it
// gets Input/output error on every file and starts diagnosing a broken
// filesystem. Measured on the real thing before this was fixed.

test('health is a separate question from presence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-health-'));
  assert.equal(tunnel.mountHealthy(dir), true, 'a readable directory is healthy');
  assert.equal(tunnel.mountHealthy(path.join(dir, 'nope')), false, 'an unreadable one is not');
  assert.equal(tunnel.isMounted(dir), false, 'and neither is a mount at all');
});

test('unmounting is attempted lazily too, since a dead mount will not release cleanly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tunnel.js'), 'utf8');
  assert.match(src, /'fusermount', '-uz'/, 'lazy fusermount, or the corpse is unremovable');
  assert.match(src, /'umount', '-l'/);
});

test('a stale mount is replaced rather than trusted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tunnel.js'), 'utf8');
  assert.match(src, /if \(mountHealthy\(mountPoint\)\) return \{ mountPoint, mounted: false, reused: true \}/);
  assert.match(src, /is mounted but unusable/, 'and a mount that cannot be cleared fails loudly');
});

// ── two ssh shapes, and using the wrong one hangs ────────────────
//
// The agent and the Terminal need a pty and an interactive login shell. A
// programmatic call needs neither — with the interactive shape `git diff
// --cached` sat on the device for six minutes with a pty nobody was typing into,
// and since the caller is synchronous the whole dashboard froze behind it.

test('a programmatic call gets no pty and a non-interactive shell', () => {
  const args = tunnel.buildSshExecArgs({ port: 1, localuser: 'me' }, '/tmp/x', 'git', ['status'], {}, { interactive: false });
  assert.equal(args[0], '-T', 'no pty allocated');
  assert.match(args[args.length - 1], /exec "\$SHELL" -lc /, 'login shell, but not interactive');
});

test('the agent and terminal path keeps the pty and the interactive shell', () => {
  const args = tunnel.buildSshExecArgs({ port: 1, localuser: 'me' }, '/tmp/x', 'npm', ['test']);
  assert.equal(args[0], '-tt');
  assert.match(args[args.length - 1], /exec "\$SHELL" -lic /);
});

test('deviceExec is bounded, so one stuck command cannot take the server', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tunnel.js'), 'utf8');
  assert.match(src, /timeout: timeoutSec \* 1000/);
  assert.match(src, /interactive: false/, 'and it uses the non-interactive shape');
});

test('a plan worktree on a device gets its own path per feature', () => {
  const d = { label: 'my mac' };
  assert.equal(tunnel.deviceWorktreePath(d, 'feat-x'), '/tmp/jonggrang-worktrees/my_mac/feat-x');
  assert.notEqual(tunnel.deviceWorktreePath(d, 'feat-x'), tunnel.deviceWorktreePath(d, 'feat-y'));
});

// ── §7: what the server's key may do on the device ───────────────

test('the server key keeps exec and a pty, and loses the rest', () => {
  const entry = tunnel.agentKeyEntry(KEY_A);
  assert.match(entry, /^restrict,pty /, 'restrict drops forwardings and user-rc; pty is added back for the Terminal');
  assert.equal(tunnel.keyBody(entry), tunnel.keyBody(KEY_A));
});

test('setAuthorizedKey replaces an entry, so old options do not survive', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-ak-'));
  const prev = process.env.HOME;
  process.env.HOME = fresh;
  try {
    tunnel.setAuthorizedKey(KEY_A);                                  // unrestricted, as before
    const upgraded = tunnel.setAuthorizedKey(tunnel.agentKeyEntry(KEY_A));
    assert.equal(upgraded.replaced, true);
    const lines = fs.readFileSync(tunnel.authorizedKeysPath(), 'utf8').split('\n').filter(Boolean);
    const mine = lines.filter(l => tunnel.keyBody(l) === tunnel.keyBody(KEY_A));
    assert.equal(mine.length, 1, 'one entry, not two');
    assert.match(mine[0], /^restrict,pty /, 'and it is the restricted one');
  } finally { process.env.HOME = prev; }
});

test('registering as your own account warns what that grants', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'jonggrang.js'), 'utf8');
  assert.match(src, /run commands on this machine as \$\{localuser\} — your own account/);
  assert.match(src, /~\/\.ssh included/, 'concretely, not vaguely');
  assert.match(src, /re-register with --user/, 'and it names the way out');
});

// ── project state lives with the code ────────────────────────────
//
// jonggrang reads project state through project.path in twenty-odd places. For a
// device project that state belongs with the code, so `<project.path>/.jonggrang`
// is a symlink onto the mount. Every existing read then lands on the device, and
// the agent — whose cwd is the device path — sees the same directory.

test('linking points server-side state at the device', () => {
  const server = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-srv-'));
  const device = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-dev-'));
  const r = tunnel.linkProjectState({ path: server }, device);
  assert.equal(r.created, true);
  assert.equal(fs.readlinkSync(path.join(server, '.jonggrang')), path.join(device, '.jonggrang'));

  // A write through the link lands on the "device" side.
  fs.writeFileSync(path.join(server, '.jonggrang', 'probe.txt'), 'x');
  assert.equal(fs.existsSync(path.join(device, '.jonggrang', 'probe.txt')), true);

  // Idempotent.
  assert.equal(tunnel.linkProjectState({ path: server }, device).created, false);
});

test('linking refuses to discard server-side state that already exists', () => {
  const server = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-srv2-'));
  const device = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-dev2-'));
  fs.mkdirSync(path.join(server, '.jonggrang'), { recursive: true });
  fs.writeFileSync(path.join(server, '.jonggrang', 'plan.md'), 'existing work');
  assert.throws(() => tunnel.linkProjectState({ path: server }, device),
    /holds server-side state/, 'moving it silently would be worse than saying so');
});

test('an empty state directory is replaced by the link without complaint', () => {
  const server = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-srv3-'));
  const device = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-dev3-'));
  fs.mkdirSync(path.join(server, '.jonggrang'), { recursive: true });
  assert.equal(tunnel.linkProjectState({ path: server }, device).created, true);
});

// ── the redirect bundle must be nobody else's file ───────────────
//
// It was merged into the project's `.claude/settings.json` at first, and
// `jonggrang init --force` writes that file: initialising a device project
// silently removed the redirect, and the work loop's agent then ran its commands
// on the SERVER. The run reported success both times — the only tell was the
// artefact, which named the wrong machine.

test('the bundle lives in its own directory, not in .claude', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-bundle-'));
  const home = path.join(__dirname, '..');
  const r = tunnel.installDeviceHooks(dir, home);
  assert.equal(r.settings, path.join(dir, '.jonggrang-device', 'settings.json'));
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'nothing written into .claude, which init owns');
  assert.ok(!fs.existsSync(path.join(dir, 'hooks')), 'nor into hooks, which is seeded into worktrees');

  const settings = JSON.parse(fs.readFileSync(r.settings, 'utf8'));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /redirect-bash\.sh/);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash');
});

test('reinstalling the bundle is idempotent and self-contained', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-bundle2-'));
  const home = path.join(__dirname, '..');
  tunnel.installDeviceHooks(dir, home);
  const first = fs.readFileSync(tunnel.deviceSettingsPath(dir), 'utf8');
  tunnel.installDeviceHooks(dir, home);
  assert.equal(fs.readFileSync(tunnel.deviceSettingsPath(dir), 'utf8'), first, 'no accumulation');
});

// ── a run that outlived its dashboard ────────────────────────────
//
// The run snapshot is written while a group runs. Restart the dashboard and the
// worker dies with it — but the file still says `running`, and the already-running
// guard then refuses to start that plan again. A plan whose run was interrupted
// could never be resumed. Hit for real: "This plan is already running" with no
// worker process anywhere.

test('the already-running guard checks a live process, not a stored status', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'orchestration-run.js'), 'utf8');
  assert.match(src, /function groupIsLive/);
  assert.match(src, /process\.kill\(pid, 0\)/, 'liveness is asked of the OS');
  assert.ok(!/existing\.status === 'running' \|\| existing\.status === 'queued'/.test(src),
    'the status-only guard is gone');
});

test('a snapshot with no live run reports interrupted, not running', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'orchestration-run.js'), 'utf8');
  assert.match(src, /function reconcileSnapshot/);
  assert.match(src, /the dashboard restarted while this plan was running/,
    'and says why, so it does not read as a mystery');
});

// ── a tunnel that drops mid-run ─────────────────────────────────
//
// Measured before it was handled: the mount answers EIO, and the agent — which
// now knows enough to say "the device has been unreachable across multiple
// attempts" — sits there retrying a machine that is not coming back, at LLM
// prices, with the run reporting `running`. When it finally gave up, the user was
// told "worker exited with code 1".

test('a device run is watched, with grace for a reconnect', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'orchestration-run.js'), 'utf8');
  assert.match(src, /const DEVICE_WATCH_INTERVAL_MS/);
  assert.match(src, /DEVICE_MISSES_BEFORE_STOP = 2/, 'two strikes, so an autossh reconnect is not fatal');
  assert.match(src, /group\.deviceWatch = setInterval/);
  assert.match(src, /clearInterval\(group\.deviceWatch\)/, 'and it is cleared when the group ends');
});

test('a run that died with the device says so, not just its exit code', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'orchestration-run.js'), 'utf8');
  assert.match(src, /is offline — the tunnel dropped during this run/);
  assert.match(src, /worker exited \$\{code\}/, 'the exit code is kept, not hidden');
});

test('the worktree mount is released when its run ends', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'orchestration-run.js'), 'utf8');
  const close = src.slice(src.indexOf("child.on('close'"));
  assert.match(close, /tunnel\.unmountDevice\(ctx\.device, group\.worktreePath\)/,
    'a mount outliving its run is a hostage to the next hiccup');
});

// ── the device keeps its own record ─────────────────────────────
//
// §7 left the audit log entirely open. The grant cannot be removed — running the
// agent's commands there IS the feature — but it can be made visible, and the
// record has to live on the DEVICE: a log kept on the server is a log the server
// can rewrite. sshd hands the client's real command to a forced command in
// $SSH_ORIGINAL_COMMAND, which is exactly the hook needed.

test('the server key runs through the audit wrapper', () => {
  const entry = tunnel.agentKeyEntry(KEY_A, '/home/me/.jonggrang/device-audit-shell.sh');
  assert.match(entry, /^restrict,pty,command="\/home\/me\/\.jonggrang\/device-audit-shell\.sh" /);
  assert.equal(tunnel.keyBody(entry), tunnel.keyBody(KEY_A));
});

test('without a wrapper the entry is still restricted', () => {
  assert.match(tunnel.agentKeyEntry(KEY_A), /^restrict,pty ssh-ed25519/,
    'a device registered before the wrapper existed keeps working');
});

test('installing the wrapper puts it on the device, executable', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-audit-'));
  const prev = process.env.HOME;
  process.env.HOME = fresh;
  try {
    const dst = tunnel.installAuditShell(path.join(__dirname, '..'));
    assert.equal(dst, tunnel.auditShellPath());
    assert.ok(fs.existsSync(dst));
    assert.ok((fs.statSync(dst).mode & 0o111) !== 0, 'sshd has to be able to run it');
    const body = fs.readFileSync(dst, 'utf8');
    assert.match(body, /SSH_ORIGINAL_COMMAND/, 'it logs the real command');
    assert.match(body, /exec "\$SHELL" -c/, 'and then runs it as asked');
    assert.match(body, /exec "\$SHELL" -l/, 'with an interactive session still possible');
  } finally { process.env.HOME = prev; }
});

test('the log rotates itself, so it cannot fill a laptop', () => {
  const body = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'device', 'audit-shell.sh'), 'utf8');
  assert.match(body, /4194304/, 'a size ceiling');
  assert.match(body, /tail -c 1048576/, 'and it keeps the tail rather than truncating to nothing');
});

// ── telling the next agent it inherited half a turn ─────────────
//
// The watchdog stops a run cleanly, but the interrupted turn is gone: whatever it
// had half-done is on disk with no note saying so, and the next agent reads it as
// deliberate. The note cannot be written when it happens — the device is
// unreachable, which is the whole reason — so it is remembered on the server and
// applied when the worktree is next reachable.

test('the interruption marker is kept server-side, not under the device symlink', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'orchestration-run.js'), 'utf8');
  assert.match(src, /interruptionsPath = \(project\) => path\.join\(tunnel\.deviceBundleDir/,
    'under .jonggrang it would be on the offline device — the first attempt wrote nowhere');
  assert.match(src, /markDeviceInterruption\(project, group\.featureId, group\.error\)/);
});

test('the note reaches the worktree on the next start, and the queue is cleaned', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'orchestration-run.js'), 'utf8');
  assert.match(src, /if \(ctx\.mode === 'device'\) applyDeviceInterruption/);
  const fn = src.slice(src.indexOf('function applyDeviceInterruption'));
  assert.match(fn, /## Interrupted run/, 'progress.txt gets the note');
  assert.match(fn, /verify the working tree/, 'and is told not to trust the leftovers');
  assert.match(fn, /t\.status === 'in_progress'.*'pending'/s, 'a stranded task returns to the queue');
  assert.match(fn, /delete all\[featureId\]/, 'and the marker is cleared once applied');
});

test('a watchdog cancel leaves the run itself terminal too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apis', 'projects', 'orchestration-run.js'), 'utf8');
  const watch = src.slice(src.indexOf('group.deviceWatch = setInterval'), src.indexOf('DEVICE_WATCH_INTERVAL_MS);'));
  assert.match(watch, /if \(!runActive\(run\)\) run\.status = 'cancelled'/,
    'otherwise the dashboard shows a run in progress with nothing in it');
});

// ── key rotation ────────────────────────────────────────────────
//
// Two attempts, both caught by testing the OLD key rather than trusting the
// success message. First: a new key was appended and the old one kept working
// while the CLI reported it revoked. Second: revoking by record missed keys
// installed before this machine kept a record — the original shared key still
// opened a session.

test('a device gets its own server key, so rotating one cannot lock out others', () => {
  const r = tunnel.provisionDevice({ label: 'rot', pubkey: KEY_A, localuser: 'me' });
  assert.equal(tunnel.serverKeyFor(tunnel.deviceFor(r.device_id)), tunnel.serverKeyPath(),
    'until it rotates, it keeps using the shared key — existing registrations are unaffected');

  const fresh = tunnel.rotateDeviceKey(r.device_id);
  const after = tunnel.deviceFor(r.device_id);
  assert.match(after.agent_key, new RegExp(`device-agent-${r.device_id}\\.key$`));
  assert.equal(tunnel.serverKeyFor(after), fresh.path);
  assert.ok(after.agent_key_rotated_at, 'and when');
});

test('rotating one device leaves another device alone', () => {
  const a = tunnel.provisionDevice({ label: 'rot-a', pubkey: KEY_A, localuser: 'me' });
  const b = tunnel.provisionDevice({ label: 'rot-b', pubkey: KEY_B, localuser: 'you' });
  tunnel.rotateDeviceKey(a.device_id);
  assert.notEqual(tunnel.serverKeyFor(tunnel.deviceFor(a.device_id)), tunnel.serverKeyFor(tunnel.deviceFor(b.device_id)));
});

test('revoking drops every jonggrang agent key but the one kept', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-revoke-'));
  const prev = process.env.HOME;
  process.env.HOME = fresh;
  try {
    const mine = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMINE ${tunnel.AGENT_KEY_COMMENT}-new`;
    // Two older agent keys, and a key the user added by hand.
    tunnel.addAuthorizedKey(`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLD1 ${tunnel.AGENT_KEY_COMMENT}`);
    tunnel.addAuthorizedKey(`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLD2 ${tunnel.AGENT_KEY_COMMENT}-dev_x`);
    tunnel.addAuthorizedKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPERSONAL me@laptop');
    tunnel.addAuthorizedKey(mine);

    assert.equal(tunnel.revokeOtherAgentKeys(mine), 2, 'both older agent keys go');
    const lines = fs.readFileSync(tunnel.authorizedKeysPath(), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'the kept agent key and the personal one remain');
    assert.ok(lines.some(l => l.includes('me@laptop')), "a key the user added by hand is never touched");
    assert.ok(lines.some(l => tunnel.keyBody(l) === tunnel.keyBody(mine)));
  } finally { process.env.HOME = prev; }
});

test('removeAuthorizedKey revokes by key material', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-revoke2-'));
  const prev = process.env.HOME;
  process.env.HOME = fresh;
  try {
    tunnel.addAuthorizedKey(KEY_A);
    assert.equal(tunnel.removeAuthorizedKey(KEY_A), true);
    assert.equal(tunnel.removeAuthorizedKey(KEY_A), false, 'removing twice is not an error');
  } finally { process.env.HOME = prev; }
});
