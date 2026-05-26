'use strict';

const assert = require('assert');
const { buildAgentArgs } = require('../lib/backend-args');

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

console.log('\nbackend-args.js — buildAgentArgs\n');

// ── No flags omitted ─────────────────────────────────────────

test('returns [] when both model and effort are empty', () => {
  assert.deepStrictEqual(buildAgentArgs({ tool: 'claude', model: '', effort: '' }), []);
});

test('returns [] when both model and effort are undefined', () => {
  assert.deepStrictEqual(buildAgentArgs({ tool: 'claude', model: undefined, effort: undefined }), []);
});

// ── Claude backend ────────────────────────────────────────────

test('claude: --model alone', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'claude', model: 'opus', effort: '' }),
    ['--model', 'opus']
  );
});

test('claude: --effort alone', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'claude', model: '', effort: 'high' }),
    ['--effort', 'high']
  );
});

test('claude: --model + --effort', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'claude', model: 'opus', effort: 'xhigh' }),
    ['--model', 'opus', '--effort', 'xhigh']
  );
});

test('claude: full model ID', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'claude', model: 'claude-opus-4-7', effort: 'max' }),
    ['--model', 'claude-opus-4-7', '--effort', 'max']
  );
});

// ── OpenCode backend ──────────────────────────────────────────

test('opencode: --model provider/model + --effort → --variant', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'opencode', model: 'anthropic/claude-sonnet-4-5-20250929', effort: 'high' }),
    ['--model', 'anthropic/claude-sonnet-4-5-20250929', '--variant', 'high']
  );
});

test('opencode: --model only', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'opencode', model: 'openai/gpt-5', effort: '' }),
    ['--model', 'openai/gpt-5']
  );
});

test('opencode: --effort only → --variant', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'opencode', model: '', effort: 'max' }),
    ['--variant', 'max']
  );
});

test('opencode: bare model name throws with friendly error', () => {
  assert.throws(
    () => buildAgentArgs({ tool: 'opencode', model: 'claude-sonnet-4-5', effort: '' }),
    (err) => {
      assert.ok(err.message.includes('provider/model format'), `Expected provider/model in: ${err.message}`);
      assert.ok(err.message.includes('"claude-sonnet-4-5"'), `Expected model name in: ${err.message}`);
      return true;
    }
  );
});

test('opencode: bare model name error message shows example', () => {
  assert.throws(
    () => buildAgentArgs({ tool: 'opencode', model: 'opus', effort: '' }),
    (err) => {
      assert.ok(err.message.includes('anthropic/claude-sonnet-4-5-20250929'), err.message);
      return true;
    }
  );
});

// ── Pi backend ────────────────────────────────────────────────

test('pi: --model alone', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'pi', model: 'claude-sonnet-4-5', effort: '' }),
    ['--model', 'claude-sonnet-4-5']
  );
});

test('pi: --effort → --thinking', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'pi', model: '', effort: 'high' }),
    ['--thinking', 'high']
  );
});

test('pi: --model + --effort → --model + --thinking', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'pi', model: 'claude-sonnet-4-5', effort: 'medium' }),
    ['--model', 'claude-sonnet-4-5', '--thinking', 'medium']
  );
});

test('pi: provider/model format passes through', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'pi', model: 'anthropic/claude-opus-4-7', effort: 'xhigh' }),
    ['--model', 'anthropic/claude-opus-4-7', '--thinking', 'xhigh']
  );
});

// ── Jonggrang (Pi SDK) backend ────────────────────────────────

test('jonggrang: model/effort ignored (returns empty array)', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'jonggrang', model: 'some-model', effort: 'high' }),
    []
  );
});

// ── Unknown tool ──────────────────────────────────────────────

test('unknown tool: returns empty array without throwing', () => {
  assert.deepStrictEqual(
    buildAgentArgs({ tool: 'unknown-tool', model: 'foo', effort: 'bar' }),
    []
  );
});

// ── Omitting both flags produces no-op ───────────────────────

test('claude: both omitted → no flags added to argv', () => {
  const base = ['--dangerously-skip-permissions', '--add-dir', '/tmp'];
  const extra = buildAgentArgs({ tool: 'claude', model: '', effort: '' });
  assert.deepStrictEqual([...base, ...extra], base);
});

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
