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

// Claude Code lays a line out with absolute-column jumps and emits no literal
// spaces, so stripping escapes alone glues every word together.
test('renderTuiLine: column jumps become the spacing they represent', () => {
  const line = '\u001B[2GQuick\u001B[8Gsafety\u001B[15Gcheck';
  assert.strictEqual(lib.renderTuiLine(line), ' Quick safety check');
});

test('renderTuiLine: cursor-forward pads, erase-in-line clears stale text', () => {
  assert.strictEqual(lib.renderTuiLine('ab\u001B[3Ccd'), 'ab   cd');
  assert.strictEqual(lib.renderTuiLine('stale text\u001B[1G\u001B[Kfresh'), 'fresh');
});

test('renderTuiLine: a vertical move ends the rendered row', () => {
  assert.deepStrictEqual(lib.renderTuiLine('first\u001B[1Asecond').split('\n'), ['first', 'second']);
});

// Fixtures are real pty captures of Claude Code 2.1.233 taken inside the agent
// container — the regression guard for anything that touches the renderer.
function transcribeFixture(name) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const out = [];
  const t = new lib.TuiTranscript({ onLine: l => out.push(l) });
  for (let i = 0; i < raw.length; i += 97) t.push(raw.slice(i, i + 97));   // exercise chunk splits
  t.flush();
  return out;
}

test('real TUI capture: the model answer survives, spacing is restored', () => {
  const out = transcribeFixture('claude-tui-session.txt');
  const text = out.join('\n');
  assert.ok(text.includes('PROBE_OK'), `answer missing from transcript:\n${text}`);
  assert.ok(text.includes('Claude Code v2.1.233'), `banner words glued together:\n${text}`);
  assert.ok(out.length <= 12, `too much spinner noise survived (${out.length} lines):\n${text}`);
});

test('real TUI capture: the trust dialog renders and stays detectable', () => {
  const text = transcribeFixture('claude-tui-trust-prompt.txt').join('\n');
  assert.ok(/Quick safety check/.test(text), `trust prompt missing:\n${text}`);
  assert.ok(text.includes('Yes, I trust this folder'), `trust option missing:\n${text}`);
});

test('TuiTranscript: partial line is held until it completes', () => {
  const out = [];
  const t = new lib.TuiTranscript({ onLine: l => out.push(l.trim()) });
  t.push('half a ');
  assert.deepStrictEqual(out, []);
  t.push('line\r\n');
  assert.deepStrictEqual(out, ['half a line']);
});

// ── Session transcript (JSONL) — the accurate log source ──────

function writeSession(configDir, projectRoot, records, { name = 'sess.jsonl' } = {}) {
  const dir = path.join(configDir, 'projects', projectRoot.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.appendFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const assistant = (blocks, uuid = String(Math.random())) =>
  ({ type: 'assistant', uuid, message: { role: 'assistant', content: blocks } });

function collectTail(configDir, projectRoot, since = 0) {
  const out = [];
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const tail = new lib.ClaudeSessionTail({
    projectRoot, since,
    onText: t => out.push(t.replace(/\n$/, '')),
    onLine: l => out.push(l),
  });
  return { tail, out };
}

test('claudeSessionDir: cwd maps to Claude Code\'s project slug', () => {
  process.env.CLAUDE_CONFIG_DIR = '/cfg';
  try {
    assert.strictEqual(lib.claudeSessionDir('/root/helo-ops-dashboard'), '/cfg/projects/-root-helo-ops-dashboard');
    assert.strictEqual(lib.claudeSessionDir('/root/.jonggrang/design/helo'), '/cfg/projects/-root--jonggrang-design-helo');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('ClaudeSessionTail: renders text and tool calls, skips thinking', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-cfg-'));
  const root = '/tmp/some-project';
  try {
    writeSession(cfg, root, [
      assistant([{ type: 'thinking', thinking: 'internal reasoning' }]),
      assistant([{ type: 'text', text: 'Decomposing the plan' }]),
      assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }]),
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'boom failed' }] } },
    ]);
    const { tail, out } = collectTail(cfg, root);
    tail.poll();
    const text = out.join('\n');
    assert.ok(text.includes('Decomposing the plan'), `assistant text missing: ${text}`);
    assert.ok(/▸ Bash/.test(text) && text.includes('git status'), `tool call missing: ${text}`);
    assert.ok(text.includes('boom failed'), `tool error missing: ${text}`);
    assert.ok(!text.includes('internal reasoning'), 'thinking must not be logged');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('ClaudeSessionTail: follows appends without repeating earlier records', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-cfg-'));
  const root = '/tmp/append-project';
  try {
    writeSession(cfg, root, [assistant([{ type: 'text', text: 'first' }], 'a1')]);
    const { tail, out } = collectTail(cfg, root);
    tail.poll();
    assert.deepStrictEqual(out, ['first']);

    writeSession(cfg, root, [assistant([{ type: 'text', text: 'second' }], 'a2')]);
    tail.poll();
    assert.deepStrictEqual(out, ['first', 'second']);

    tail.poll();                                     // nothing new
    assert.deepStrictEqual(out, ['first', 'second']);
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('ClaudeSessionTail: ignores transcripts that predate this run', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-cfg-'));
  const root = '/tmp/stale-project';
  try {
    const file = writeSession(cfg, root, [assistant([{ type: 'text', text: 'from an older run' }])]);
    const old = Date.now() - 60 * 60 * 1000;
    fs.utimesSync(file, new Date(old), new Date(old));

    const { tail, out } = collectTail(cfg, root, Date.now());
    tail.poll();
    assert.strictEqual(tail.active, false, 'a stale transcript must not be adopted');
    assert.deepStrictEqual(out, []);
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

// ── End-to-end pty runs against a fake claude ─────────────────

const FAST = { idleSec: 1, minRuntimeMs: 0, exitGraceMs: 200, killGraceMs: 400 };

// REGRESSION: `--add-dir <directories...>` is variadic, so a trailing prompt is
// parsed as a second directory. The TUI then opens with an empty input box, the
// session idles out, and the run reports success having done nothing. The prompt
// must be the last argv entry and must not follow a variadic flag.
testAsync('runClaudeInteractive: prompt is passed as argv without --add-dir swallowing it', async () => {
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
    assert.deepStrictEqual(argv, ['--dangerously-skip-permissions', '--model', 'opus', 'do the thing']);
    assert.ok(!argv.includes('--add-dir'), 'interactive mode must not pass the variadic --add-dir');
    assert.strictEqual(argv[argv.length - 1], 'do the thing', 'prompt must be the final argv entry');
  } finally { process.env.PATH = prevPath; }
});

// The whole point of reading the JSONL: the screen scrape is lossy, so when a
// session transcript exists it must be the log — and the screen must go quiet.
testAsync('runClaudeInteractive: logs the session transcript, not the screen', async () => {
  const root = tmpProject();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-cfg-'));
  const sessionDir = path.join(cfg, 'projects', root.replace(/[/.]/g, '-'));
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, 'run.jsonl');

  const record = (blocks) => JSON.stringify({ type: 'assistant', uuid: String(Math.random()), message: { role: 'assistant', content: blocks } });
  const { bin } = fakeClaude(root, [
    `echo '${record([{ type: 'text', text: 'clean transcript line' }])}' >> "${sessionFile}"`,
    `echo '${record([{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.js' } }])}' >> "${sessionFile}"`,
    'echo "GARBLED screen text"',
    'sleep 2',
    'exit 0',
  ].join('\n'));

  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const chunks = [];
  try {
    const code = await lib.runClaudeInteractive({ prompt: 'p', projectRoot: root, textChunks: chunks, ...FAST });
    assert.strictEqual(code, 0);
    const text = chunks.join('');
    assert.ok(text.includes('clean transcript line'), `transcript text missing: ${JSON.stringify(text)}`);
    assert.ok(/▸ Read/.test(text) && text.includes('src/app.js'), `tool call missing: ${JSON.stringify(text)}`);
    assert.ok(!text.includes('GARBLED'), `screen capture leaked into the log: ${JSON.stringify(text)}`);
  } finally {
    process.env.PATH = prevPath;
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

// The folder-trust dialog looks exactly like a finished turn to an idle detector,
// so an unanswered one silently produces a no-op run.
testAsync('runClaudeInteractive: auto-confirms the folder-trust dialog in autonomous mode', async () => {
  const root = tmpProject();
  const { bin } = fakeClaude(root, [
    'echo "Quick safety check: Is this a project you created or one you trust?"',
    'echo "1. Yes, I trust this folder"',
    'read _answer',                      // blocks until the Enter we send
    'echo "TRUST_CONFIRMED"',
    'exit 0',
  ].join('\n'));
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  const chunks = [];
  try {
    const code = await lib.runClaudeInteractive({
      prompt: 'p',
      permFlags: lib.claudePermissionFlags('autonomous'),
      projectRoot: root,
      textChunks: chunks,
      ...FAST,
      idleSec: 20,                       // must finish by answering, not by idling out
    });
    assert.strictEqual(code, 0);
    assert.ok(chunks.join('').includes('TRUST_CONFIRMED'),
      `trust prompt was not answered: ${JSON.stringify(chunks.join(''))}`);
  } finally { process.env.PATH = prevPath; }
});

testAsync('runClaudeInteractive: leaves the trust dialog alone outside autonomous mode', async () => {
  const root = tmpProject();
  const { bin } = fakeClaude(root, [
    'echo "Quick safety check: Is this a project you created or one you trust?"',
    'sleep 30',
  ].join('\n'));
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  const chunks = [];
  try {
    await lib.runClaudeInteractive({
      prompt: 'p',
      permFlags: lib.claudePermissionFlags('supervised'),
      projectRoot: root,
      textChunks: chunks,
      ...FAST,
    });
    assert.ok(!chunks.join('').includes('confirming automatically'),
      'supervised mode must not answer the trust dialog on the user\'s behalf');
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
      // cwd isolation: the fake echoes its own pwd, which must be this session's root.
      assert.ok(text.includes(path.basename(root)),
        `session ${i} ran outside its own project root: ${JSON.stringify(text)}`);
    }
  } finally { process.env.PATH = prevPath; }
});

// ── Live session mirroring (Work Mode terminal) ───────────────
//
// The dashboard terminal is fed by frames the worker writes on stdout, and
// keystrokes come back as frames on its stdin. Both halves are exercised here
// against a fake claude that echoes whatever is typed into it.

function captureStdout() {
  const written = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  return { written, restore: () => { process.stdout.write = orig; } };
}

function ptyFrames(written) {
  return written.join('').split('\n')
    .filter(l => l.startsWith('{'))
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

testAsync('pty mirror: forwards raw output as base64 frames and closes with an exit frame', async () => {
  const root = tmpProject();
  const { bin } = fakeClaude(root, 'echo "mirror me"\nexit 0');
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.JONGGRANG_PTY_SESSION = 'work:feat-x';
  const cap = captureStdout();
  try {
    await lib.runClaudeInteractive({ prompt: 'p', projectRoot: root, ...FAST });
  } finally {
    cap.restore();
    process.env.PATH = prevPath;
    delete process.env.JONGGRANG_PTY_SESSION;
  }

  const frames = ptyFrames(cap.written);
  const data = frames.filter(f => f.type === 'pty_data');
  assert.ok(data.length > 0, 'expected pty_data frames');
  assert.ok(data.every(f => f.session === 'work:feat-x'), 'every frame must carry the session key');
  const decoded = data.map(f => Buffer.from(f.b64, 'base64').toString('utf8')).join('');
  assert.ok(decoded.includes('mirror me'), `raw output missing from the mirror: ${JSON.stringify(decoded)}`);
  assert.ok(frames.some(f => f.type === 'pty_exit'), 'expected a pty_exit frame');
});

testAsync('pty mirror: keystroke frames on stdin reach the session', async () => {
  const root = tmpProject();
  // Echoes back whatever is typed, so anything we inject must reappear.
  const { bin } = fakeClaude(root, 'read typed\necho "TYPED:$typed"\nexit 0');
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.JONGGRANG_PTY_SESSION = 'work:feat-y';
  const cap = captureStdout();

  const run = lib.runClaudeInteractive({ prompt: 'p', projectRoot: root, ...FAST, idleSec: 20 });
  // The worker reads control frames off its own stdin.
  await new Promise(r => setTimeout(r, 800));
  process.stdin.emit('data', Buffer.from(`${JSON.stringify({
    type: 'pty_input', b64: Buffer.from('hello-from-browser\r', 'utf8').toString('base64'),
  })}\n`));

  let code;
  try { code = await run; } finally {
    cap.restore();
    process.env.PATH = prevPath;
    delete process.env.JONGGRANG_PTY_SESSION;
  }

  assert.strictEqual(code, 0);
  const decoded = ptyFrames(cap.written)
    .filter(f => f.type === 'pty_data')
    .map(f => Buffer.from(f.b64, 'base64').toString('utf8')).join('');
  assert.ok(decoded.includes('TYPED:hello-from-browser'),
    `injected keystrokes never reached the pty: ${JSON.stringify(decoded)}`);
});

test('pty mirror: stays off unless the server asks for it', () => {
  assert.ok(!process.env.JONGGRANG_PTY_SESSION, 'the mirror must be opt-in via JONGGRANG_PTY_SESSION');
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
