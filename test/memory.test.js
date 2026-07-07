'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const memory = require('../lib/memory.js');

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-memory-'));
  fs.mkdirSync(path.join(root, '.jonggrang'), { recursive: true });
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function featureDir(root, featureId = 'feat-a') {
  return path.join(root, '.jonggrang', '.output', 'features', featureId);
}

function createFeature(root, featureId = 'feat-a', tasks = [{ id: 'task-001', title: 'Task 1', status: 'pending' }]) {
  const dir = featureDir(root, featureId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jonggrang-tasks.json'), JSON.stringify({ tasks }, null, 2));
  return dir;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function lockFiles(root) {
  const dir = path.join(root, '.jonggrang', 'locks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.lock'));
}

function withMockedNow(iso, fn) {
  const RealDate = global.Date;
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length > 0) return new RealDate(...args);
      return new RealDate(iso);
    }
    static now() { return new RealDate(iso).getTime(); }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  }
  global.Date = MockDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

test('parseFrontmatter / stringifyFrontmatter round-trips arrays, scalars, and body', () => {
  const raw = '---\ntags: [a, b]\nfeature_id: feat-a\nupdated_at: 2026-07-05T00:00:00.000Z\n---\n## Context\nBody preserved\n';

  const parsed = memory.parseFrontmatter(raw);
  assert.deepEqual(parsed.data, {
    tags: ['a', 'b'],
    feature_id: 'feat-a',
    updated_at: '2026-07-05T00:00:00.000Z',
  });
  assert.equal(parsed.body, '## Context\nBody preserved\n');
  assert.equal(memory.stringifyFrontmatter(parsed.data, parsed.body), raw);
});

test('addFragment validates tasks, writes unique staging files, and leaves canonical memory untouched', () => {
  const root = tempProject();
  try {
    createFeature(root, 'feat-a');
    const source = writeFile(path.join(root, 'fragment.md'), '## What Done\nImplemented the thing\n');

    assert.throws(
      () => memory.addFragment(root, 'feat-a', 'task-999', source),
      /task task-999 not found/
    );

    const first = withMockedNow('2026-07-05T10:00:00.000Z', () =>
      memory.addFragment(root, 'feat-a', 'task-001', source)
    );
    const second = withMockedNow('2026-07-05T10:00:01.000Z', () =>
      memory.addFragment(root, 'feat-a', 'task-001', source)
    );

    assert.notEqual(first, second);
    assert.equal(path.relative(root, first), '.jonggrang/.ephemeral/memory/fragments/feat-a/task-001-2026-07-05T10-00-00-000Z.md');
    assert.equal(path.relative(root, second), '.jonggrang/.ephemeral/memory/fragments/feat-a/task-001-2026-07-05T10-00-01-000Z.md');
    assert.equal(fs.readFileSync(first, 'utf8'), fs.readFileSync(source, 'utf8'));
    assert.equal(fs.readFileSync(second, 'utf8'), fs.readFileSync(source, 'utf8'));
    assert.equal(fs.existsSync(memory.featureMemoryFile(root, 'feat-a')), false);
  } finally {
    cleanup(root);
  }
});

test('recall is bounded, scoped, structured, ranked by query, and empty-safe', () => {
  const emptyRoot = tempProject();
  try {
    assert.deepEqual(memory.recall(emptyRoot, { query: 'anything' }), {
      query: 'anything',
      featureId: null,
      taskId: null,
      count: 0,
      snippets: [],
    });
  } finally {
    cleanup(emptyRoot);
  }

  const root = tempProject();
  try {
    createFeature(root, 'feat-a');
    const big = 'x'.repeat(memory.RECALL_MAX_CHARS + 500);
    writeFile(memory.projectMemoryFile(root), [
      '---',
      'updated_at: 2026-07-05T00:00:00.000Z',
      'scope: project',
      'tags: [core]',
      '---',
      '## Project Needle Winner',
      'needle needle needle durable lesson',
      '## Project Other',
      'needle once',
      '## Big Budget',
      big,
      '## Project Extra 1',
      'needle',
      '## Project Extra 2',
      'needle',
      '## Project Extra 3',
      'needle',
    ].join('\n'));
    writeFile(memory.featureMemoryFile(root, 'feat-a'), [
      '---',
      'feature_id: feat-a',
      'updated_at: 2026-07-05T01:00:00.000Z',
      'tags: [feature]',
      '---',
      '## Feature Lesson',
      'feature-only detail needle',
    ].join('\n'));

    const projectOnly = memory.recall(root, { query: 'needle' });
    assert.equal(projectOnly.featureId, null);
    assert.equal(projectOnly.count <= memory.RECALL_MAX_SNIPPETS, true);
    assert.equal(projectOnly.snippets.every(s => s.scope === 'project'), true);
    assert.equal(projectOnly.snippets[0].heading, 'Project Needle Winner');
    assert.equal(projectOnly.snippets[0].text.startsWith('## Project Needle Winner'), false);

    const scoped = memory.recall(root, { query: 'needle', featureId: 'feat-a', taskId: 'task-001' });
    assert.equal(scoped.count <= memory.RECALL_MAX_SNIPPETS, true);
    assert.equal(scoped.snippets.reduce((sum, s) => sum + s.text.length, 0) <= memory.RECALL_MAX_CHARS, true);
    assert.ok(scoped.snippets.some(s => s.scope === 'project'));
    assert.ok(scoped.snippets.some(s => s.scope === 'feature' && s.featureId === 'feat-a'));
    for (const snippet of scoped.snippets) {
      assert.equal(typeof snippet.source, 'string');
      assert.equal(typeof snippet.scope, 'string');
      assert.equal(typeof snippet.heading, 'string');
      assert.equal(typeof snippet.timestamp, 'string');
      assert.equal(typeof snippet.text, 'string');
      assert.equal(path.isAbsolute(snippet.source), false);
    }
  } finally {
    cleanup(root);
  }
});

test('compact writes feature memory atomically, archives fragments, releases locks, and preserves fragments on failure', async () => {
  const root = tempProject();
  try {
    createFeature(root, 'feat-a');
    writeFile(path.join(featureDir(root, 'feat-a'), 'progress.txt'), 'raw progress');
    const source = writeFile(path.join(root, 'fragment.md'), '## Lessons\nRemember this\n');
    const fragment = withMockedNow('2026-07-05T10:00:00.000Z', () =>
      memory.addFragment(root, 'feat-a', 'task-001', source)
    );
    const fakeText = '---\nfeature_id: feat-a\n---\n## Context\nmerged\n';

    const result = await memory.compact(root, 'feat-a', {
      agentFn: async () => ({ code: 0, text: fakeText }),
    });

    assert.equal(result.skipped, false);
    assert.equal(result.staleArchivesRemoved, 0);
    assert.equal(fs.readFileSync(memory.featureMemoryFile(root, 'feat-a'), 'utf8'), fakeText);
    assert.deepEqual(memory.listFragments(root, 'feat-a'), []);
    assert.equal(fs.existsSync(path.join(memory.archiveDir(root, 'feat-a'), path.basename(fragment))), true);
    assert.deepEqual(lockFiles(root), []);
  } finally {
    cleanup(root);
  }

  const failRoot = tempProject();
  try {
    createFeature(failRoot, 'feat-a');
    const source = writeFile(path.join(failRoot, 'fragment.md'), '## Lessons\nKeep me\n');
    const fragment = memory.addFragment(failRoot, 'feat-a', 'task-001', source);

    await assert.rejects(
      () => memory.compact(failRoot, 'feat-a', { agentFn: async () => ({ code: 1, text: '' }) }),
      /compact failed/
    );
    assert.equal(fs.existsSync(fragment), true);
    assert.equal(fs.existsSync(memory.featureMemoryFile(failRoot, 'feat-a')), false);
    assert.deepEqual(lockFiles(failRoot), []);
  } finally {
    cleanup(failRoot);
  }

  const secretRoot = tempProject();
  try {
    createFeature(secretRoot, 'feat-a');
    const source = writeFile(path.join(secretRoot, 'fragment.md'), '## Lessons\ncontains secret source\n');
    const fragment = memory.addFragment(secretRoot, 'feat-a', 'task-001', source);

    await assert.rejects(
      () => memory.compact(secretRoot, 'feat-a', {
        agentFn: async () => ({ code: 0, text: '---\nfeature_id: feat-a\n---\n## Context\nleaked token\n' }),
        secretScanFn: () => ({ leaked: true, findings: '{"Source":"test"}' }),
      }),
      /secret detected in memory output/
    );
    assert.equal(fs.existsSync(fragment), true);
    assert.equal(fs.existsSync(memory.featureMemoryFile(secretRoot, 'feat-a')), false);
    assert.deepEqual(lockFiles(secretRoot), []);
  } finally {
    cleanup(secretRoot);
  }

  const skipRoot = tempProject();
  try {
    createFeature(skipRoot, 'feat-a');
    const result = await memory.compact(skipRoot, 'feat-a', {
      agentFn: async () => { throw new Error('agent should not run'); },
    });
    assert.deepEqual(result, { skipped: true, reason: 'no inputs to compact (no fragments, progress, or existing memory)' });
    assert.deepEqual(lockFiles(skipRoot), []);
  } finally {
    cleanup(skipRoot);
  }
});

test('promote requires feature memory, writes project memory atomically, preserves feature memory on failure, and releases locks', async () => {
  const missingRoot = tempProject();
  try {
    createFeature(missingRoot, 'feat-a');
    await assert.rejects(
      () => memory.promote(missingRoot, 'feat-a', { agentFn: async () => ({ code: 0, text: 'unused' }) }),
      /no feature memory to promote/
    );
  } finally {
    cleanup(missingRoot);
  }

  const root = tempProject();
  try {
    createFeature(root, 'feat-a');
    const featureText = '---\nfeature_id: feat-a\n---\n## Context\nfeature memory\n';
    writeFile(memory.featureMemoryFile(root, 'feat-a'), featureText);
    const projectText = '---\nscope: project\n---\n## Conventions\nmerged project\n';

    const result = await memory.promote(root, 'feat-a', {
      agentFn: async () => ({ code: 0, text: projectText }),
    });

    assert.equal(result.skipped, false);
    assert.equal(result.staleArchivesRemoved, 0);
    assert.equal(fs.readFileSync(memory.projectMemoryFile(root), 'utf8'), projectText);
    assert.equal(fs.readFileSync(memory.featureMemoryFile(root, 'feat-a'), 'utf8'), featureText);
    assert.deepEqual(lockFiles(root), []);
  } finally {
    cleanup(root);
  }

  const failRoot = tempProject();
  try {
    createFeature(failRoot, 'feat-a');
    const featureText = '---\nfeature_id: feat-a\n---\n## Context\nfeature memory\n';
    writeFile(memory.featureMemoryFile(failRoot, 'feat-a'), featureText);

    await assert.rejects(
      () => memory.promote(failRoot, 'feat-a', { agentFn: async () => ({ code: 1, text: '' }) }),
      /promote failed/
    );
    assert.equal(fs.readFileSync(memory.featureMemoryFile(failRoot, 'feat-a'), 'utf8'), featureText);
    assert.equal(fs.existsSync(memory.projectMemoryFile(failRoot)), false);
    assert.deepEqual(lockFiles(failRoot), []);
  } finally {
    cleanup(failRoot);
  }

  const secretRoot = tempProject();
  try {
    createFeature(secretRoot, 'feat-a');
    const featureText = '---\nfeature_id: feat-a\n---\n## Context\nfeature memory\n';
    writeFile(memory.featureMemoryFile(secretRoot, 'feat-a'), featureText);

    await assert.rejects(
      () => memory.promote(secretRoot, 'feat-a', {
        agentFn: async () => ({ code: 0, text: '---\nscope: project\n---\n## Conventions\nleaked token\n' }),
        secretScanFn: () => ({ leaked: true, findings: '{"Source":"test"}' }),
      }),
      /secret detected in memory output/
    );
    assert.equal(fs.readFileSync(memory.featureMemoryFile(secretRoot, 'feat-a'), 'utf8'), featureText);
    assert.equal(fs.existsSync(memory.projectMemoryFile(secretRoot)), false);
    assert.deepEqual(lockFiles(secretRoot), []);
  } finally {
    cleanup(secretRoot);
  }
});

test('renderIndex renders project memory and generated feature index without modifying inputs', () => {
  const root = tempProject();
  try {
    createFeature(root, 'feat-old');
    createFeature(root, 'feat-new');
    const projectFile = memory.projectMemoryFile(root);
    const oldFile = memory.featureMemoryFile(root, 'feat-old');
    const newFile = memory.featureMemoryFile(root, 'feat-new');

    writeFile(projectFile, '---\nscope: project\nupdated_at: 2026-07-05T00:00:00.000Z\n---\n## Conventions\nProject rule\n');
    writeFile(oldFile, '---\nfeature_id: feat-old\nfeature_name: Old Feature\ntags: [old]\nupdated_at: 2026-07-04T00:00:00.000Z\n---\n## Context\nOld\n');
    writeFile(newFile, '---\nfeature_id: feat-new\nfeature_name: New Feature\ntags: [new]\nupdated_at: 2026-07-06T00:00:00.000Z\n---\n## Context\nNew\n');

    const before = new Map([[projectFile, fileHash(projectFile)], [oldFile, fileHash(oldFile)], [newFile, fileHash(newFile)]]);
    const rendered = memory.renderIndex(root);
    const after = new Map([[projectFile, fileHash(projectFile)], [oldFile, fileHash(oldFile)], [newFile, fileHash(newFile)]]);

    assert.equal(after.get(projectFile), before.get(projectFile));
    assert.equal(after.get(oldFile), before.get(oldFile));
    assert.equal(after.get(newFile), before.get(newFile));
    assert.match(rendered, /## Conventions\nProject rule/);
    assert.match(rendered, /## Feature Memories/);
    assert.ok(rendered.indexOf('feat-new — New Feature') < rendered.indexOf('feat-old — Old Feature'));
  } finally {
    cleanup(root);
  }
});

test('buildMemoryPolicyPrompt renders concrete work recall when feature/task are known', () => {
  const prompt = memory.buildMemoryPolicyPrompt('work', { featureId: 'feat-a', taskId: 'task-001' });
  assert.match(prompt, /jonggrang memory recall --query "<task goal>" --feature feat-a --task task-001/);
  assert.doesNotMatch(prompt, /<feature_id>|<task_id>|--phase/);
});

test('validateFeatureExists / validateTaskExists reject invalid ids and missing state', () => {
  const root = tempProject();
  try {
    assert.throws(() => memory.validateFeatureExists(root, 'feat/evil'), /invalid feature id/);
    assert.throws(() => memory.validateFeatureExists(root, 'missing'), /feature not found/);

    createFeature(root, 'feat-a');
    assert.doesNotThrow(() => memory.validateFeatureExists(root, 'feat-a'));
    assert.throws(() => memory.validateTaskExists(root, 'feat-a', 'task-999'), /task task-999 not found/);
    assert.throws(() => memory.validateTaskExists(root, 'feat-a', 'bad'), /invalid task id/);
  } finally {
    cleanup(root);
  }
});
