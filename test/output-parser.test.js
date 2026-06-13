'use strict';

const assert = require('assert');
const { parseOutputFiles, OUTPUT_FILES_HEADER } = require('../lib/output-parser');

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

console.log('\noutput-parser.js — parseOutputFiles\n');

// ── Constant ──────────────────────────────────────────────────

test('OUTPUT_FILES_HEADER is exported and equals "OUTPUT_FILES:"', () => {
  assert.strictEqual(OUTPUT_FILES_HEADER, 'OUTPUT_FILES:');
});

// ── Basic parsing ─────────────────────────────────────────────

test('empty stdout returns []', () => {
  assert.deepStrictEqual(parseOutputFiles(''), []);
});

test('stdout with no OUTPUT_FILES block returns []', () => {
  assert.deepStrictEqual(parseOutputFiles('Some output\nNo special block here\n'), []);
});

test('parses unfenced block with type', () => {
  const stdout = `
Done with the task.

OUTPUT_FILES:
- path: src/foo.js
  type: code
- path: docs/report.md
  type: report
`;
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [
    { path: 'src/foo.js', type: 'code' },
    { path: 'docs/report.md', type: 'report' },
  ]);
});

test('parses unfenced block without type', () => {
  const stdout = `OUTPUT_FILES:\n- path: src/bar.ts\n`;
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'src/bar.ts' }]);
});

test('parses fenced block (```yaml)', () => {
  const stdout = [
    'OUTPUT_FILES:',
    '```yaml',
    '- path: lib/helper.js',
    '  type: code',
    '```',
    '',
  ].join('\n');
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'lib/helper.js', type: 'code' }]);
});

test('parses fenced block (``` no lang)', () => {
  const stdout = [
    'OUTPUT_FILES:',
    '```',
    '- path: tmp/output.txt',
    '  type: output',
    '```',
  ].join('\n');
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'tmp/output.txt', type: 'output' }]);
});

// ── Deduplication ─────────────────────────────────────────────

test('deduplicates by path — last block wins', () => {
  const stdout = [
    'OUTPUT_FILES:',
    '- path: src/foo.js',
    '  type: output',
    '',
    'Some other text.',
    '',
    'OUTPUT_FILES:',
    '- path: src/foo.js',
    '  type: code',
  ].join('\n');
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'src/foo.js', type: 'code' }]);
});

test('deduplicates across stdout and stderr — last write wins', () => {
  const stdout = 'OUTPUT_FILES:\n- path: a.js\n  type: output\n';
  const stderr = 'OUTPUT_FILES:\n- path: a.js\n  type: code\n';
  const result = parseOutputFiles(stdout, stderr);
  assert.deepStrictEqual(result, [{ path: 'a.js', type: 'code' }]);
});

// ── Edge cases ────────────────────────────────────────────────

test('ignores entries with empty path', () => {
  const stdout = 'OUTPUT_FILES:\n- path: ""\n- path: src/real.js\n  type: code\n';
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'src/real.js', type: 'code' }]);
});

test('ignores non-object list entries (bare strings)', () => {
  const stdout = 'OUTPUT_FILES:\n- src/foo.js\n- path: src/bar.js\n';
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'src/bar.js' }]);
});

test('handles malformed YAML gracefully — returns [] for that block', () => {
  const stdout = 'OUTPUT_FILES:\n: invalid: yaml: {{{\n\nOUTPUT_FILES:\n- path: ok.js\n';
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'ok.js' }]);
});

test('handles block at very end of file with no trailing newline', () => {
  const stdout = 'OUTPUT_FILES:\n- path: eof.js\n  type: code';
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'eof.js', type: 'code' }]);
});

test('trims whitespace from paths', () => {
  const stdout = 'OUTPUT_FILES:\n- path: "  src/spaced.js  "\n';
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [{ path: 'src/spaced.js' }]);
});

test('multiple distinct paths across two blocks are all returned', () => {
  const stdout = [
    'OUTPUT_FILES:',
    '- path: a.js',
    '  type: code',
    '',
    'more output...',
    '',
    'OUTPUT_FILES:',
    '- path: b.js',
    '  type: report',
  ].join('\n');
  const result = parseOutputFiles(stdout);
  assert.deepStrictEqual(result, [
    { path: 'a.js', type: 'code' },
    { path: 'b.js', type: 'report' },
  ]);
});

test('stderr is optional (undefined)', () => {
  const stdout = 'OUTPUT_FILES:\n- path: x.js\n';
  const result = parseOutputFiles(stdout, undefined);
  assert.deepStrictEqual(result, [{ path: 'x.js' }]);
});

test('non-string type is omitted from entry', () => {
  // YAML number instead of string
  const stdout = 'OUTPUT_FILES:\n- path: y.js\n  type: 123\n';
  const result = parseOutputFiles(stdout);
  // type: 123 is a number, not string — should be omitted
  assert.deepStrictEqual(result, [{ path: 'y.js' }]);
});

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
