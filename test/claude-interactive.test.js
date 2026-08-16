'use strict';

// Claude interactive (PTY) execution — flag mapping, mode resolution, the
// TUI-frame → transcript filter, and end-to-end pty runs against a fake
// `claude` binary (exit-on-its-own, non-zero exit, and idle close).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../lib/jonggrang');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }

function tmpProject(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-claude-'));
  fs.mkdirSync(path.join(root, '.jonggrang'), { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(root, '.jonggrang', 'jonggrang.json'), JSON.stringify(config, null, 2));
  }
  return root;
}

// Fake `claude` on PATH: records argv, then behaves as told.
function fakeClaude(root, body) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const argvFile = path.join(root, 'argv.txt');
  const script = `#!/bin/sh\nfor a in "$@"; do echo "$a" >> "${argvFile}"; done\n${body}\n`;
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return { bin, argvFile };
}

console.log('\nclaude-interactive — PTY execution\n');

// ── Permission flags ──────────────────────────────────────────

test('claudePermissionFlags: autonomous → --dangerously-skip-permissions', () => {
  assert.deepStrictEqual(lib.claudePermissionFlags('autonomous'), ['--dangerously-skip-permissions']);
});

test('claudePermissionFlags: balanced → acceptEdits', () => {
  assert.deepStrictEqual(lib.claudePermissionFlags('balanced'), ['--permission-mode', 'acceptEdits']);
});

test('claudePermissionFlags: supervised → default', () => {
  assert.deepStrictEqual(lib.claudePermissionFlags('supervised'), ['--permission-mode', 'default']);
});

test('claudePermissionFlags: unknown mode → no flags', () => {
  assert.deepStrictEqual(lib.claudePermissionFlags('whatever'), []);
});

// ── Execution-mode resolution (default must stay headless) ────

test('resolveClaudeExecution: no config → headless', () => {
  assert.strictEqual(lib.resolveClaudeExecution(tmpProject()), 'headless');
});

test('resolveClaudeExecution: config without tools block → headless', () => {
  assert.strictEqual(lib.resolveClaudeExecution(tmpProject({ tool: 'claude' })), 'headless');
});

test('resolveClaudeExecution: tools.claude.execution=interactive → interactive', () => {
  const root = tmpProject({ tool: 'claude', tools: { claude: { execution: 'interactive' } } });
  assert.strictEqual(lib.resolveClaudeExecution(root), 'interactive');
});

test('resolveClaudeExecution: unknown value falls back to headless', () => {
  const root = tmpProject({ tools: { claude: { execution: 'weird' } } });
  assert.strictEqual(lib.resolveClaudeExecution(root), 'headless');
});

test('resolveClaudeExecution: env override wins over config (on)', () => {
  const root = tmpProject({ tools: { claude: { execution: 'headless' } } });
  process.env.JONGGRANG_CLAUDE_EXEC = 'interactive';
  try {
    assert.strictEqual(lib.resolveClaudeExecution(root), 'interactive');
  } finally { delete process.env.JONGGRANG_CLAUDE_EXEC; }
});

test('resolveClaudeExecution: env override wins over config (off)', () => {
  const root = tmpProject({ tools: { claude: { execution: 'interactive' } } });
  process.env.JONGGRANG_CLAUDE_EXEC = 'headless';
  try {
    assert.strictEqual(lib.resolveClaudeExecution(root), 'headless');
  } finally { delete process.env.JONGGRANG_CLAUDE_EXEC; }
});

// ── Interactive eligibility ───────────────────────────────────

test('useClaudeInteractive: false when the project is headless', () => {
  assert.strictEqual(lib.useClaudeInteractive('hi', tmpProject()), false);
});

test('useClaudeInteractive: true when opted in with a normal prompt', () => {
  const root = tmpProject({ tools: { claude: { execution: 'interactive' } } });
  assert.strictEqual(lib.useClaudeInteractive('implement task-001', root), true);
});

test('useClaudeInteractive: oversized prompt degrades to headless', () => {
  const root = tmpProject({ tools: { claude: { execution: 'interactive' } } });
  assert.strictEqual(lib.useClaudeInteractive('x'.repeat(200 * 1024), root), false);
});

// ── TUI frame → transcript ────────────────────────────────────

test('normalizeTuiLine: drops box chrome and keeps content', () => {
  assert.strictEqual(lib.normalizeTuiLine('╭────────────╮'), '');
  assert.strictEqual(lib.normalizeTuiLine('│            │'), '');
  assert.strictEqual(lib.normalizeTuiLine('│ real text  │').trim(), 'real text');
});

test('normalizeTuiLine: drops spinner frames and TUI hints', () => {
  assert.strictEqual(lib.normalizeTuiLine('✻ Thinking… (12s · ↑ 1.2k tokens)'), '');
  assert.strictEqual(lib.normalizeTuiLine('  esc to interrupt'), '');
  assert.strictEqual(lib.normalizeTuiLine('? for shortcuts'), '');
});

test('TuiTranscript: strips ANSI, dedupes redrawn frames', () => {
  const out = [];
  const t = new lib.TuiTranscript({ onLine: l => out.push(l.trim()) });
  t.push('[2J[H╭─────╮\r\n│ [32mbuilt ok[0m │\r\n');
  t.push('│ built ok │\r\n│ next line │\r\n');   // same frame redrawn + one new line
  t.flush();
  assert.deepStrictEqual(out, ['built ok', 'next line']);
});

test('TuiTranscript: escape sequence split across chunks does not leak', () => {
  const out = [];
  const t = new lib.TuiTranscript({ onLine: l => out.push(l.trim()) });
  t.push('[3');            // half an escape sequence, no newline yet
  t.push('2mgreen text[0m\r\n');
  t.flush();
  assert.deepStrictEqual(out, ['green text']);
});

test('TuiTranscript: partial line is held until it completes', () => {
  const out = [];
  const t = new lib.TuiTranscript({ onLine: l => out.push(l.trim()) });
  t.push('half a ');
  assert.deepStrictEqual(out, []);
  t.push('line\r\n');
  assert.deepStrictEqual(out, ['half a line']);
});

// ── End-to-end pty runs against a fake claude ─────────────────

const FAST = { idleSec: 1, minRuntimeMs: 0, exitGraceMs: 200, killGraceMs: 400 };

testAsync('runClaudeInteractive: forwards flags, prompt and cwd to the CLI', async () => {
  const root = tmpProject();
  const { bin, argvFile } = fakeClaude(root, 'echo "hello from claude"\nexit 0');
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    const code = await lib.runClaudeInteractive({
      prompt: 'do the thing',
      permFlags: lib.claudePermissionFlags('autonomous'),
      extraFlags: ['--model', 'opus'],
      projectRoot: root,
      ...FAST,
    });
    assert.strictEqual(code, 0);
    const argv = fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    assert.deepStrictEqual(argv, ['--dangerously-skip-permissions', '--add-dir', root, '--model', 'opus', 'do the thing']);
  } finally { process.env.PATH = prevPath; }
});

testAsync('runClaudeInteractive: propagates a non-zero exit code', async () => {
  const root = tmpProject();
  const { bin } = fakeClaude(root, 'echo "boom"\nexit 3');
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    const code = await lib.runClaudeInteractive({ prompt: 'p', projectRoot: root, ...FAST });
    assert.strictEqual(code, 3);
  } finally { process.env.PATH = prevPath; }
});

testAsync('runClaudeInteractive: captures the transcript when asked', async () => {
  const root = tmpProject();
  const { bin } = fakeClaude(root, 'echo "line one"\necho "line two"\nexit 0');
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  const chunks = [];
  try {
    await lib.runClaudeInteractive({ prompt: 'p', projectRoot: root, textChunks: chunks, ...FAST });
    const text = chunks.join('');
    assert.ok(text.includes('line one'), `transcript missing line one: ${JSON.stringify(text)}`);
    assert.ok(text.includes('line two'), `transcript missing line two: ${JSON.stringify(text)}`);
  } finally { process.env.PATH = prevPath; }
});

testAsync('runClaudeInteractive: closes an idle session and reports success', async () => {
  const root = tmpProject();
  const { bin } = fakeClaude(root, 'echo "working"\nsleep 30');
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  const startedAt = Date.now();
  try {
    const code = await lib.runClaudeInteractive({ prompt: 'p', projectRoot: root, ...FAST });
    assert.strictEqual(code, 0);
    assert.ok(Date.now() - startedAt < 15000, 'idle close took too long');
  } finally { process.env.PATH = prevPath; }
});

testAsync('runClaudeInteractive: max runtime cap fails the run', async () => {
  const root = tmpProject();
  const { bin } = fakeClaude(root, 'while true; do echo "busy"; sleep 0.2; done');
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    const code = await lib.runClaudeInteractive({
      prompt: 'p', projectRoot: root, ...FAST, idleSec: 30, maxSec: 1,
    });
    assert.strictEqual(code, 1);
  } finally { process.env.PATH = prevPath; }
});

// Parallel plans run one worker per worktree, each driving its own pty. Sessions
// must not share state: every one gets its own cwd, argv and transcript.
testAsync('runClaudeInteractive: concurrent sessions stay isolated', async () => {
  const roots = ['a', 'b', 'c'].map(() => tmpProject());
  const fakes = roots.map((root, i) => fakeClaude(root, `echo "session ${i} in $(pwd)"\nexit 0`));
  const prevPath = process.env.PATH;

  try {
    const results = await Promise.all(roots.map((root, i) => {
      // Each session resolves `claude` from its own bin dir.
      process.env.PATH = `${fakes[i].bin}:${prevPath}`;
      const chunks = [];
      return lib.runClaudeInteractive({
        prompt: `prompt ${i}`, projectRoot: root, textChunks: chunks, ...FAST,
      }).then(code => ({ code, text: chunks.join(''), root, i }));
    }));

    for (const { code, text, root, i } of results) {
      assert.strictEqual(code, 0, `session ${i} failed`);
      assert.ok(text.includes(`session ${i} in `), `session ${i} got the wrong transcript: ${JSON.stringify(text)}`);
      const argv = fs.readFileSync(fakes[i].argvFile, 'utf8').split('\n').filter(Boolean);
      assert.ok(argv.includes(`prompt ${i}`), `session ${i} got the wrong prompt: ${argv}`);
      assert.ok(argv.includes(root), `session ${i} ran outside its own project root: ${argv}`);
    }
  } finally { process.env.PATH = prevPath; }
});

// Cancelling a run (web "Cancel" → SIGTERM on the worker) must take the pty
// with it, or an orphan claude keeps holding the worktree.
testAsync('SIGTERM on the worker kills the pty child — no orphan claude', async () => {
  const root = tmpProject();
  const pidFile = path.join(root, 'claude.pid');
  const { bin } = fakeClaude(root, `echo "started"\necho $$ > "${pidFile}"\nsleep 120`);

  const runner = `
    const lib = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'jonggrang.js'))});
    lib.runClaudeInteractive({ prompt: 'p', projectRoot: ${JSON.stringify(root)}, idleSec: 600 })
      .then(() => process.exit(0));
  `;
  const child = require('child_process').spawn(process.execPath, ['-e', runner], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: 'ignore',
  });

  const waitFor = async (fn, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (fn()) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };

  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  assert.ok(await waitFor(() => fs.existsSync(pidFile), 15000), 'fake claude never started');
  const claudePid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(claudePid), 'fake claude should be running before the kill');

  child.kill('SIGTERM');
  assert.ok(await waitFor(() => !alive(claudePid), 10000),
    `pty child ${claudePid} survived the worker SIGTERM`);
});

(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
