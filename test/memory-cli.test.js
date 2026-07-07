'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const JG = path.join(REPO, 'bin', 'jonggrang.js');

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-memory-cli-'));
  fs.mkdirSync(path.join(root, '.jonggrang'), { recursive: true });
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function createFeature(root, featureId = 'feat-a', tasks = [{ id: 'task-001', title: 'Task 1', status: 'pending' }]) {
  const dir = path.join(root, '.jonggrang', '.output', 'features', featureId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jonggrang-tasks.json'), JSON.stringify({ tasks }, null, 2));
  return dir;
}

function runMemory(root, args) {
  const result = spawnSync(process.execPath, [JG, 'memory', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('memory read renders project memory + feature index without modifying files', () => {
  const root = tempProject();
  try {
    const projectMemory = writeFile(
      path.join(root, '.jonggrang', 'MEMORY.md'),
      '---\nscope: project\nupdated_at: 2026-07-05T00:00:00.000Z\n---\n## Conventions\nUse small commits\n'
    );
    createFeature(root, 'feat-old');
    createFeature(root, 'feat-new');
    const oldMemory = writeFile(
      path.join(root, '.jonggrang', '.output', 'features', 'feat-old', 'MEMORY.md'),
      '---\nfeature_id: feat-old\nfeature_name: Old Feature\ntags: [old]\nupdated_at: 2026-07-04T00:00:00.000Z\n---\n## Context\nOld\n'
    );
    const newMemory = writeFile(
      path.join(root, '.jonggrang', '.output', 'features', 'feat-new', 'MEMORY.md'),
      '---\nfeature_id: feat-new\nfeature_name: New Feature\ntags: [new]\nupdated_at: 2026-07-06T00:00:00.000Z\n---\n## Context\nNew\n'
    );
    const before = [projectMemory, oldMemory, newMemory].map(file => [file, hash(file)]);

    const result = runMemory(root, ['read']);

    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /# Jonggrang Project Memory/);
    assert.match(result.stdout, /## Conventions\nUse small commits/);
    assert.match(result.stdout, /## Feature Memories/);
    assert.ok(result.stdout.indexOf('feat-new — New Feature') < result.stdout.indexOf('feat-old — Old Feature'));
    for (const [file, beforeHash] of before) {
      assert.equal(hash(file), beforeHash, `${path.relative(root, file)} must not be modified`);
    }
  } finally {
    cleanup(root);
  }
});

test('memory read --feature prints feature memory and fails cleanly when missing', () => {
  const root = tempProject();
  try {
    createFeature(root, 'feat-a');
    writeFile(
      path.join(root, '.jonggrang', '.output', 'features', 'feat-a', 'MEMORY.md'),
      '---\nfeature_id: feat-a\n---\n## Context\nFeature-specific memory\n'
    );

    const ok = runMemory(root, ['read', '--feature', 'feat-a']);
    assert.equal(ok.code, 0, ok.output);
    assert.equal(ok.stdout, '---\nfeature_id: feat-a\n---\n## Context\nFeature-specific memory\n\n');

    const missing = runMemory(root, ['read', '--feature', 'missing']);
    assert.notEqual(missing.code, 0);
    assert.match(missing.output, /feature not found: missing/);
  } finally {
    cleanup(root);
  }
});

test('memory recall CLI formats bounded scoped recall and requires --query', () => {
  const root = tempProject();
  try {
    createFeature(root, 'feat-a');
    writeFile(
      path.join(root, '.jonggrang', 'MEMORY.md'),
      '---\nupdated_at: 2026-07-05T00:00:00.000Z\nscope: project\n---\n## Project Lesson\nneedle project rule\n'
    );
    writeFile(
      path.join(root, '.jonggrang', '.output', 'features', 'feat-a', 'MEMORY.md'),
      '---\nfeature_id: feat-a\nupdated_at: 2026-07-05T01:00:00.000Z\n---\n## Feature Lesson\nneedle feature detail\n'
    );

    const missingQuery = runMemory(root, ['recall', '--feature', 'feat-a']);
    assert.notEqual(missingQuery.code, 0);
    assert.match(missingQuery.output, /recall requires --query/);

    const result = runMemory(root, ['recall', '--feature', 'feat-a', '--task', 'task-001', '--query', 'needle']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /## Recall \(feature=feat-a · task=task-001 · query="needle"\)/);
    assert.match(result.stdout, /bounded to 5 max \/ 2000 chars/);
    assert.match(result.stdout, /### Feature Lesson/);
    assert.match(result.stdout, /_\[feature\] \.jonggrang\/\.output\/features\/feat-a\/MEMORY\.md · updated 2026-07-05_/);
    assert.match(result.stdout, /### Project Lesson/);
  } finally {
    cleanup(root);
  }
});

test('memory fragment add stages raw content and never writes canonical feature memory', () => {
  const root = tempProject();
  try {
    createFeature(root, 'feat-a');
    const source = writeFile(path.join(root, 'fragment.md'), '## Lessons\nCLI fragment note\n');

    const badTask = runMemory(root, ['fragment', 'add', '--feature', 'feat-a', '--task', 'task-999', '--file', source]);
    assert.notEqual(badTask.code, 0);
    assert.match(badTask.output, /task task-999 not found/);

    const result = runMemory(root, ['fragment', 'add', '--feature', 'feat-a', '--task', 'task-001', '--file', source]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Fragment staged:/);

    const fragmentsDir = path.join(root, '.jonggrang', '.ephemeral', 'memory', 'fragments', 'feat-a');
    const files = fs.readdirSync(fragmentsDir).filter(file => file.endsWith('.md'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^task-001-.*\.md$/);
    assert.equal(fs.readFileSync(path.join(fragmentsDir, files[0]), 'utf8'), fs.readFileSync(source, 'utf8'));
    assert.equal(fs.existsSync(path.join(root, '.jonggrang', '.output', 'features', 'feat-a', 'MEMORY.md')), false);
  } finally {
    cleanup(root);
  }
});
