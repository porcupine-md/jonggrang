'use strict';

// Smoke tests for the codex hook enforcement layer (issue #68).
// Covers: policies (pure functions), handlers (per-hook logic), and the
// dispatcher (stdin → handler → codex-format stdout) end-to-end.
//
// Run: node test/codex-hooks.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const policies = require(path.join(REPO_ROOT, 'hooks', 'codex', 'lib', 'policies'));
const handlers = require(path.join(REPO_ROOT, 'hooks', 'codex', 'lib', 'handlers'));
const dispatcher = path.join(REPO_ROOT, 'hooks', 'codex', 'dispatcher.js');

// ── policies.js ──────────────────────────────────────────────────────────

test('classifyFilePath: *.example always allowed', () => {
  assert.equal(policies.classifyFilePath('config.example'), 'allow');
  assert.equal(policies.classifyFilePath('.env.example'), 'allow');
});

test('classifyFilePath: .env / orcinus flagged as env', () => {
  assert.equal(policies.classifyFilePath('.env'), 'env');
  assert.equal(policies.classifyFilePath('orcinus.local'), 'env');
  assert.equal(policies.classifyFilePath('config/.env.production'), 'env');
});

test('classifyFilePath: hard-block certs, keys, credentials', () => {
  for (const f of ['id_rsa', '~/.ssh/id_rsa', 'server.pem', 'aws.key', 'credentials.json',
                   'client.p12', 'authorized_keys', 'ssh_host_rsa_key']) {
    assert.equal(policies.classifyFilePath(f), 'block', f);
  }
});

test('classifyFilePath: pass for normal files', () => {
  assert.equal(policies.classifyFilePath('src/index.js'), 'pass');
  assert.equal(policies.classifyFilePath('README.md'), 'pass');
});

test('isSecretCommand: blocks env/printenv and chained forms', () => {
  assert.equal(policies.isSecretCommand('env'), true);
  assert.equal(policies.isSecretCommand('printenv'), true);
  assert.equal(policies.isSecretCommand('ls; env'), true);
  assert.equal(policies.isSecretCommand('echo $(env)'), true);
  assert.equal(policies.isSecretCommand('echo `printenv`'), true);
  assert.equal(policies.isSecretCommand('bash -c "env"'), true);
});

test('isSecretCommand: blocks readers targeting sensitive paths', () => {
  assert.equal(policies.isSecretCommand('cat ~/.ssh/id_rsa'), true);
  assert.equal(policies.isSecretCommand('cat credentials.json'), true);
  assert.equal(policies.isSecretCommand('base64 server.pem'), true);
});

test('isSecretCommand: blocks AWS/GH/kubectl credential dumps', () => {
  assert.equal(policies.isSecretCommand('aws configure list'), true);
  assert.equal(policies.isSecretCommand('gh auth token'), true);
  assert.equal(policies.isSecretCommand('kubectl config view'), true);
  assert.equal(policies.isSecretCommand('kubectl config view --minify'), false);
});

test('isSecretCommand: allows benign commands', () => {
  assert.equal(policies.isSecretCommand('ls -la'), false);
  assert.equal(policies.isSecretCommand('npm test'), false);
  assert.equal(policies.isSecretCommand('git status'), false);
  assert.equal(policies.isSecretCommand('echo hello'), false);
});

test('sanitizeSecrets: redacts AWS keys, JWTs, private keys, DB URIs', () => {
  const out = policies.sanitizeSecrets('key=AKIAIOSFODNN7EXAMPLE done');
  assert.match(out, /AWS_KEY<REDACTED>/);
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);

  const jwt = policies.sanitizeSecrets('tok=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4f');
  assert.match(jwt, /<REDACTED>/);
  assert.doesNotMatch(jwt, /SflKxwRJSMeKKF2QT4f/);

  const pem = policies.sanitizeSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...');
  assert.match(pem, /-----BEGIN <REDACTED>-----/);

  const pg = policies.sanitizeSecrets('postgres://user:hunter2@db:5432/x');
  assert.match(pg, /<REDACTED>@/);
  assert.doesNotMatch(pg, /hunter2/);
});

test('detectDomain: frontend / testing / database / api / backend', () => {
  assert.equal(policies.detectDomain('src/components/Button.tsx'), 'frontend');
  assert.equal(policies.detectDomain('tests/unit.spec.js'), 'testing');
  assert.equal(policies.detectDomain('db/migrations/0001.sql'), 'database');
  assert.equal(policies.detectDomain('api/routes/users.js'), 'api');
  assert.equal(policies.detectDomain('lib/utils.js'), 'backend');
});

// ── handlers.js — apply_patch path extraction ────────────────────────────

test('extractPathsFromPatch: parses Add/Update/Delete File headers', () => {
  const patch = '*** Begin Patch\n*** Add File: src/new.js\n+console.log(1)\n*** Update File: lib/old.js\n-ctx\n+context\n*** Delete File: tmp/x.md\n';
  const paths = handlers._extractPathsFromPatch(patch);
  assert.deepEqual(paths.sort(), ['src/new.js', 'lib/old.js', 'tmp/x.md'].sort());
});

test('extractFilePaths: handles file_path, path, and apply_patch command', () => {
  assert.deepEqual(handlers._extractFilePaths({ file_path: 'a.js' }), ['a.js']);
  assert.deepEqual(handlers._extractFilePaths({ path: 'b.js' }), ['b.js']);
  assert.deepEqual(
    handlers._extractFilePaths({ command: '*** Update File: c.js\n-x' }, 'apply_patch'),
    ['c.js']
  );
});

// ── handlers.js — PreToolUse deny paths ──────────────────────────────────

test('blockSensitiveFiles: denies .pem via apply_patch', async () => {
  const r = await handlers.blockSensitiveFiles({
    tool_name: 'apply_patch',
    tool_input: { command: '*** Add File: secrets/server.pem\n+-----BEGIN PRIVATE KEY-----' },
  }, { projectRoot: REPO_ROOT });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /sensitive file/);
});

test('blockSensitiveFiles: allows normal file via apply_patch', async () => {
  const r = await handlers.blockSensitiveFiles({
    tool_name: 'apply_patch',
    tool_input: { command: '*** Add File: src/index.js\n+console.log(1)' },
  }, { projectRoot: REPO_ROOT });
  assert.equal(r.decision, 'allow');
});

test('blockSecretCommands: denies env dump', async () => {
  const r = await handlers.blockSecretCommands({
    tool_name: 'Bash',
    tool_input: { command: 'env' },
  }, { projectRoot: REPO_ROOT });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /SECRET COMMAND BLOCKED/);
});

test('blockSecretCommands: allows ls', async () => {
  const r = await handlers.blockSecretCommands({
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  }, { projectRoot: REPO_ROOT });
  assert.equal(r.decision, 'allow');
});

test('agentFirst: allows edit when no agents-registry.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-'));
  try {
    const r = await handlers.agentFirst({
      tool_name: 'apply_patch',
      tool_input: { command: '*** Update File: src/app.js\n-x\n+y' },
      session_id: 'sess-1',
    }, { projectRoot: tmpDir, jonggrangLib: path.join(REPO_ROOT, 'lib') });
    assert.equal(r.decision, 'allow');
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('agentFirst: blocks edit when domain specialist registered + session not a developer', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-'));
  try {
    // register a frontend specialist
    fs.mkdirSync(path.join(tmpDir, '.jonggrang', '.output'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.jonggrang', '.output', 'agents-registry.json'),
      JSON.stringify({ frontend: 'fe-dev-1' })
    );
    const r = await handlers.agentFirst({
      tool_name: 'apply_patch',
      tool_input: { command: '*** Update File: src/components/Button.tsx\n-x\n+y' },
      session_id: 'orchestrator-1',
    }, { projectRoot: tmpDir, jonggrangLib: path.join(REPO_ROOT, 'lib') });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /AGENT-FIRST/);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('agentFirst: allows edit when session IS a developer', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.jonggrang', '.output'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.jonggrang', '.ephemeral'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.jonggrang', '.output', 'agents-registry.json'),
      JSON.stringify({ frontend: 'fe-dev-1' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.jonggrang', '.ephemeral', 'session-roles.json'),
      JSON.stringify({ 'dev-sess': 'developer' })
    );
    const r = await handlers.agentFirst({
      tool_name: 'apply_patch',
      tool_input: { command: '*** Update File: src/components/Button.tsx\n-x\n+y' },
      session_id: 'dev-sess',
    }, { projectRoot: tmpDir, jonggrangLib: path.join(REPO_ROOT, 'lib') });
    assert.equal(r.decision, 'allow');
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

// ── handlers.js — PostToolUse / Stop / SessionStart ──────────────────────

test('sanitizeOutput: warns when secret in tool output', async () => {
  const r = await handlers.sanitizeOutput({
    tool_response: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
  }, { projectRoot: REPO_ROOT });
  assert.equal(r.decision, 'allow');
  assert.ok(r.context, 'expected additionalContext');
  assert.match(r.context, /SECRET LEAK/);
});

test('sanitizeOutput: silent when no secret', async () => {
  const r = await handlers.sanitizeOutput({
    tool_response: 'all good here',
  }, { projectRoot: REPO_ROOT });
  assert.equal(r.decision, 'allow');
  assert.equal(r.context, undefined);
});

test('feedbackLoop: allows exit when loop not active', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-'));
  try {
    const r = await handlers.feedbackLoop({}, { projectRoot: tmpDir, jonggrangLib: path.join(REPO_ROOT, 'lib') });
    assert.equal(r.decision, 'allow');
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('qualityGate: allows when no untracked .md and no dirty bit', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true }); // init bare-ish git dir
    const r = await handlers.qualityGate({}, { projectRoot: tmpDir, jonggrangLib: path.join(REPO_ROOT, 'lib') });
    assert.equal(r.decision, 'allow');
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('sessionInit: detects role from prompt and writes session-roles.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-'));
  try {
    const r = await handlers.sessionInit({
      session_id: 'sess-42',
      prompt: 'You are a specialized developer for the backend domain.',
    }, { projectRoot: tmpDir, jonggrangLib: path.join(REPO_ROOT, 'lib') });
    assert.equal(r.decision, 'allow');
    const roles = JSON.parse(fs.readFileSync(path.join(tmpDir, '.jonggrang', '.ephemeral', 'session-roles.json'), 'utf8'));
    assert.equal(roles['sess-42'], 'developer');
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('taskRoleClaim: queues pending role from subagent_type', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-'));
  try {
    const r = await handlers.taskRoleClaim({
      agent_type: 'tester',
    }, { projectRoot: tmpDir, jonggrangLib: path.join(REPO_ROOT, 'lib') });
    assert.equal(r.decision, 'allow');
    const pendingDir = path.join(tmpDir, '.jonggrang', '.ephemeral', 'pending-roles');
    const files = fs.readdirSync(pendingDir);
    assert.equal(files.length, 1);
    const data = JSON.parse(fs.readFileSync(path.join(pendingDir, files[0]), 'utf8'));
    assert.equal(data.role, 'tester');
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

// ── dispatcher.js — end-to-end via stdin/stdout ──────────────────────────

function runDispatcher(hookName, payload) {
  const out = execFileSync('node', [dispatcher, hookName], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stdout: out, exitCode: 0 };
}

function runDispatcherExpectBlock(hookName, payload) {
  try {
    execFileSync('node', [dispatcher, hookName], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: '', exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', exitCode: e.status };
  }
}

test('dispatcher: blockSecretCommands emits PreToolUse deny JSON + exit 2', () => {
  const { stdout, exitCode } = runDispatcherExpectBlock('blockSecretCommands', {
    tool_name: 'Bash',
    tool_input: { command: 'env' },
    cwd: REPO_ROOT,
  });
  assert.equal(exitCode, 2);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /SECRET COMMAND/);
});

test('dispatcher: blockSensitiveFiles emits PreToolUse deny for .pem', () => {
  const { stdout, exitCode } = runDispatcherExpectBlock('blockSensitiveFiles', {
    tool_name: 'apply_patch',
    tool_input: { command: '*** Add File: server.pem\n+-----BEGIN PRIVATE KEY-----' },
    cwd: REPO_ROOT,
  });
  assert.equal(exitCode, 2);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});

test('dispatcher: allows benign Bash command (exit 0, no JSON)', () => {
  const { stdout, exitCode } = runDispatcher('blockSecretCommands', {
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    cwd: REPO_ROOT,
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), '');
});

test('dispatcher: sanitizeOutput emits additionalContext when secret present', () => {
  const { stdout, exitCode } = runDispatcher('sanitizeOutput', {
    tool_response: 'key=AKIAIOSFODNN7EXAMPLE',
    cwd: REPO_ROOT,
  });
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(parsed.hookSpecificOutput.additionalContext, /SECRET LEAK/);
});

test('dispatcher: unknown hook name fails open with stderr message', () => {
  let caught;
  try {
    execFileSync('node', [dispatcher, 'nonExistentHook'], {
      input: '{}',
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { caught = e; }
  assert.ok(caught, 'expected non-zero exit');
  assert.match(caught.stderr?.toString() || '', /unknown hook/);
});

test('dispatcher: handler throw fails open (exit 0, no block)', () => {
  // Pass malformed input that will make a handler throw internally — dispatcher
  // must catch and exit 0 so the agent is never blocked by a handler bug.
  const { exitCode } = runDispatcher('sessionInit', {
    session_id: null,
    prompt: null,
    cwd: REPO_ROOT,
  });
  assert.equal(exitCode, 0);
});

// ── lib/hooks.js — installCodexHooks wiring ──────────────────────────────

test('installCodexHooks: writes .codex/hooks.json with real hooks object', () => {
  const { installCodexHooks } = require(path.join(REPO_ROOT, 'lib', 'hooks'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-install-'));
  try {
    const configPath = installCodexHooks(tmpDir, REPO_ROOT);
    assert.ok(fs.existsSync(configPath));
    assert.match(configPath, /\.codex[\\/]hooks\.json$/);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(cfg.hooks, 'expected hooks key');
    assert.ok(cfg.hooks.PreToolUse, 'expected PreToolUse event');
    assert.ok(cfg.hooks.Stop, 'expected Stop event');
    assert.ok(cfg.hooks.PostToolUse, 'expected PostToolUse event');
    assert.ok(cfg.hooks.SessionStart, 'expected SessionStart event');
    // _comment / _codex_events helper keys must NOT be in the installed config
    assert.equal(cfg._comment, undefined);
    assert.equal(cfg._codex_events, undefined);
    // dispatcher command must point at hooks/codex/dispatcher.js
    const cmd = cfg.hooks.PreToolUse[0].hooks[0].command;
    assert.match(cmd, /hooks[\\/]codex[\\/]dispatcher\.js/);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('installHooksForTool: installs codex alongside claude/opencode/jonggrang', () => {
  const { installHooksForTool } = require(path.join(REPO_ROOT, 'lib', 'hooks'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-all-'));
  try {
    const results = installHooksForTool(tmpDir, 'codex', REPO_ROOT);
    assert.ok(results.codex, 'expected codex in results');
    assert.equal(results.codex.installed, true);
    assert.ok(fs.existsSync(results.codex.path));
    // hooks/codex/ scripts must also be copied into the project
    assert.ok(fs.existsSync(path.join(tmpDir, 'hooks', 'codex', 'dispatcher.js')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'hooks', 'codex', 'lib', 'handlers.js')));
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});
