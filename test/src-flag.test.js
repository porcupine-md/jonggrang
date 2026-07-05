'use strict';

// Acceptance tests for the --src flag on `jonggrang plan`.
// --src must only reference a canonical path in the prompt and let the coding
// agent decide how to read the file. No content ingestion or truncation.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const lib = require('../lib/jonggrang');

const CANONICAL_PATH = '/tmp/demo-brd.md';
const FILE_CONTENT = '# BRD\n\nThis is the secret content that must NOT appear in the prompt.';

// ── Prompt builder unit tests ───────────────────────────────────────────────

test('buildFeatureSection with description only does not mention src', () => {
  const out = lib.buildFeatureSection('add login', null);
  assert.equal(out, '## Feature Description\nadd login');
});

test('buildFeatureSection with srcPath only references the path', () => {
  const out = lib.buildFeatureSection('', CANONICAL_PATH);
  assert.match(out, /## Feature Description/);
  assert.match(out, new RegExp(CANONICAL_PATH));
  assert.match(out, /Read it for context before planning/);
});

test('buildFeatureSection with both description and srcPath references the path', () => {
  const out = lib.buildFeatureSection('add login', CANONICAL_PATH);
  assert.match(out, /add login/);
  assert.match(out, new RegExp(CANONICAL_PATH));
  assert.match(out, /Source Document/);
});

test('buildDraftPlanPrompt with srcPath contains the path but not file content', () => {
  const prompt = lib.buildDraftPlanPrompt('add login', null, null, 'plan.md', CANONICAL_PATH);
  assert.match(prompt, new RegExp(CANONICAL_PATH));
  assert.doesNotMatch(prompt, /secret content/);
  assert.doesNotMatch(prompt, /BRD/);
});

test('buildDeepPlanDiscoveryPrompt with srcPath contains the path', () => {
  const prompt = lib.buildDeepPlanDiscoveryPrompt('add login', null, 'deep-plan-discovery.md', CANONICAL_PATH);
  assert.match(prompt, new RegExp(CANONICAL_PATH));
  assert.match(prompt, /Source Document/);
});

test('buildDeepPlanCondensePrompt with srcPath contains the path', () => {
  const prompt = lib.buildDeepPlanCondensePrompt(
    'add login', 'discovery', 'analysis', null, null, 'plan.md', CANONICAL_PATH
  );
  assert.match(prompt, new RegExp(CANONICAL_PATH));
  assert.match(prompt, /Source Document/);
});

// ── CLI integration tests ───────────────────────────────────────────────────

test('CLI rejects non-existent --src file before spawning agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-src-'));
  const cli = path.resolve(__dirname, '..', 'bin', 'jonggrang.js');

  // Initialize a minimal project so `plan` can run.
  spawnSync(process.execPath, [
    cli, 'init',
    '--name', 'src-test',
    '--tool', 'jonggrang',
    '--autonomy', 'autonomous',
    '--force',
  ], { cwd: dir, stdio: 'ignore' });

  const missingFile = path.join(dir, 'missing.md');
  const result = spawnSync(process.execPath, [
    cli, 'plan',
    '--src', missingFile,
    'add login',
  ], { cwd: dir, encoding: 'utf8' });

  assert.notEqual(result.status, 0, 'CLI should exit with error');
  assert.match(result.stderr, /Source file not found/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// Note: a full happy-path CLI test would spawn an AI agent, which is too
// heavy/fragile for this suite. The unit tests above verify the prompt content,
// and the test below verifies the file-existence guard.
