'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const guard = require(path.join(REPO_ROOT, 'lib', 'codex-runtime-guard'));
const feedback = require(path.join(REPO_ROOT, 'lib', 'feedback'));

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-runtime-'));
}

test('extractCommand supports command_execution.command', () => {
  assert.equal(
    guard.extractCommand({ type: 'command_execution', command: '/bin/zsh -lc env' }),
    '/bin/zsh -lc env'
  );
});

test('extractCommand supports function_call JSON arguments', () => {
  assert.equal(
    guard.extractCommand({ type: 'function_call', name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) }),
    'npm test'
  );
});

test('extractFilePathsFromItem parses apply_patch command paths', () => {
  const paths = guard.extractFilePathsFromItem({
    type: 'command_execution',
    command: 'apply_patch <<\'PATCH\'\n*** Begin Patch\n*** Update File: src/app.js\n-x\n+y\n*** End Patch\nPATCH',
  });
  assert.deepEqual(paths, ['src/app.js']);
});

test('inspectItemEvent aborts secret command on item.started', () => {
  const result = guard.inspectItemEvent({
    type: 'item.started',
    item: { type: 'command_execution', command: '/bin/zsh -lc env' },
  }, REPO_ROOT);

  assert.equal(result.action, 'abort');
  assert.match(result.reason, /CODEX RUNTIME GUARD/);
  assert.match(result.reason, /post-hoc damage-control/);
  assert.match(result.reason, /env/);
});

test('inspectItemEvent aborts sensitive file modification observed in patch', () => {
  const result = guard.inspectItemEvent({
    type: 'item.started',
    item: {
      type: 'function_call',
      name: 'apply_patch',
      arguments: JSON.stringify({ command: '*** Add File: secrets/server.pem\n+key' }),
    },
  }, REPO_ROOT);

  assert.equal(result.action, 'abort');
  assert.match(result.reason, /Sensitive file/);
  assert.match(result.reason, /server\.pem/);
});

test('inspectItemEvent tracks modified domain on completed patch', () => {
  const tmpDir = tempProject();
  try {
    const result = guard.inspectItemEvent({
      type: 'item.completed',
      item: {
        type: 'function_call',
        name: 'apply_patch',
        arguments: JSON.stringify({ command: '*** Update File: src/components/Button.tsx\n-old\n+new' }),
      },
    }, tmpDir);

    assert.equal(result.action, 'allow');
    assert.match(result.warning, /dirty bit set/);
    const state = feedback.readFeedbackState(tmpDir);
    assert.equal(state.dirty_bit, true);
    assert.deepEqual(state.modified_domains, ['frontend']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('checkExitGates blocks completion when feedback loop dirty bit is active', async () => {
  const tmpDir = tempProject();
  try {
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    feedback.activateFeedbackLoop(tmpDir, 'backend');

    const result = await guard.checkExitGates(tmpDir);
    assert.equal(result.action, 'abort');
    assert.match(result.reason, /FEEDBACK LOOP GATE/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sanitizeText redacts secrets before display/capture', () => {
  const sanitized = guard.sanitizeText('token AKIAIOSFODNN7EXAMPLE done');
  assert.match(sanitized, /AWS_KEY<REDACTED>/);
  assert.doesNotMatch(sanitized, /AKIAIOSFODNN7EXAMPLE/);
});
