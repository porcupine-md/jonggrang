'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { runAgent } = require(path.join(REPO_ROOT, 'lib', 'jonggrang'));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function installFakeCodex(binDir, source) {
  const script = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(script, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(script, 0o755);
}

async function withFakeCodex(source, fn) {
  const root = tempDir('jg-fake-codex-root-');
  const bin = tempDir('jg-fake-codex-bin-');
  const oldPath = process.env.PATH;
  installFakeCodex(bin, source);
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    return await fn(root);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test('runAgent codex runtime guard aborts observed secret command', async () => {
  await withFakeCodex(`
process.stdout.write(JSON.stringify({
  type: 'item.started',
  item: { type: 'command_execution', command: '/bin/zsh -lc env' }
}) + '\\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'should not reach caller' }]
    }
  }) + '\\n');
}, 500);
setTimeout(() => process.exit(0), 1500);
`, async (projectRoot) => {
    const result = await runAgent('prompt', 'codex', 'supervised', projectRoot, { captureText: true });
    assert.equal(result.code, 1);
    assert.equal(result.text, '');
  });
});

test('runAgent codex runtime guard redacts assistant text before capture', async () => {
  await withFakeCodex(`
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'key AKIAIOSFODNN7EXAMPLE done' }]
  }
}) + '\\n');
`, async (projectRoot) => {
    const result = await runAgent('prompt', 'codex', 'supervised', projectRoot, { captureText: true });
    assert.equal(result.code, 0);
    assert.match(result.text, /AWS_KEY<REDACTED>/);
    assert.doesNotMatch(result.text, /AKIAIOSFODNN7EXAMPLE/);
  });
});
