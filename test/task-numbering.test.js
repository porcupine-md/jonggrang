'use strict';

// Per-feature task numbering + bare-id resolver (feat/append-plan).
// Numbering is PER-FEATURE: each feature numbers its own tasks from task-001,
// so a bare id (task-001) recurs across features. findTaskFeature must resolve
// within a feature scope, never silently pick the wrong plan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../lib/jonggrang');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jong-numbering-'));
}

// In the real flow cmdApprove creates the feature dir + MANIFEST before the
// decompose agent adds tasks. Mirror that: ensure the feature folder exists.
function ensureFeature(root, featureId) {
  fs.mkdirSync(path.join(root, '.jonggrang', '.output', 'features', featureId), { recursive: true });
}
function addTask(root, featureId, data) { ensureFeature(root, featureId); return lib.addTask(root, featureId, data); }
function addTasksBulk(root, featureId, arr) { ensureFeature(root, featureId); return lib.addTasksBulk(root, featureId, arr); }

test('new feature numbers tasks from task-001', () => {
  const root = tmpRepo();
  try {
    const a = addTask(root, 'feat-a', { title: 'first' });
    const b = addTask(root, 'feat-a', { title: 'second' });
    assert.equal(a.id, 'task-001');
    assert.equal(b.id, 'task-002');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second feature resets numbering to task-001 (per-feature, not global)', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'feat-a', { title: 'a1' });
    addTask(root, 'feat-a', { title: 'a2' });
    const b1 = addTask(root, 'feat-b', { title: 'b1' });
    assert.equal(b1.id, 'task-001', 'second feature must start at task-001, not continue the global count');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('append into a feature continues from its own max', () => {
  const root = tmpRepo();
  try {
    addTasksBulk(root, 'feat-a', [{ title: 'a1' }, { title: 'a2' }]); // 001, 002
    const appended = addTasksBulk(root, 'feat-a', [{ title: 'a3' }, { title: 'a4' }]);
    assert.deepEqual(appended.map(t => t.id), ['task-003', 'task-004']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addTasksBulk on a fresh feature starts at task-001', () => {
  const root = tmpRepo();
  try {
    const created = addTasksBulk(root, 'feat-x', [{ title: 'x1' }, { title: 'x2' }, { title: 'x3' }]);
    assert.deepEqual(created.map(t => t.id), ['task-001', 'task-002', 'task-003']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findTaskFeature: unknown id → null', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'feat-a', { title: 'a1' });
    assert.equal(lib.findTaskFeature(root, 'task-999'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findTaskFeature: single global match resolves (legacy globally-unique ids keep working)', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'feat-a', { title: 'a1' });        // task-001 in feat-a only
    addTask(root, 'feat-b', { title: 'b1' });         // task-001 in feat-b
    addTask(root, 'feat-b', { title: 'b2' });         // task-002 ONLY in feat-b
    assert.equal(lib.findTaskFeature(root, 'task-002'), 'feat-b');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findTaskFeature: colliding id resolves to the explicit opts.featureId', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'feat-a', { title: 'a1' }); // task-001 in feat-a
    addTask(root, 'feat-b', { title: 'b1' }); // task-001 in feat-b (collision)
    assert.equal(lib.findTaskFeature(root, 'task-001', { featureId: 'feat-a' }), 'feat-a');
    assert.equal(lib.findTaskFeature(root, 'task-001', { featureId: 'feat-b' }), 'feat-b');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findTaskFeature: colliding id with throwOnAmbiguous throws AMBIGUOUS_TASK_ID', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'feat-a', { title: 'a1' });
    addTask(root, 'feat-b', { title: 'b1' });
    assert.throws(
      () => lib.findTaskFeature(root, 'task-001', { throwOnAmbiguous: true }),
      (err) => {
        assert.equal(err.code, 'AMBIGUOUS_TASK_ID');
        assert.deepEqual(new Set(err.candidates), new Set(['feat-a', 'feat-b']));
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findTaskFeature: colliding id without opts degrades to best-effort (no throw), never crashes callers', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'feat-a', { title: 'a1' });
    addTask(root, 'feat-b', { title: 'b1' });
    const resolved = lib.findTaskFeature(root, 'task-001'); // programmatic caller, no hint
    assert.ok(['feat-a', 'feat-b'].includes(resolved), 'returns one of the candidate features, does not throw');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Regression for the web-pipeline applySignal collision bug: a task_status signal
// from feature B's worker must mark B's task-001 done, NOT feature A's task-001.
// applySignal now passes the emitting group's featureId as the resolver hint.
test('scoped resolve + markTaskDone hits the correct feature (applySignal collision fix)', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'feat-a', { title: 'a1' }); // feat-a/task-001
    addTask(root, 'feat-b', { title: 'b1' }); // feat-b/task-001 (same bare id)

    // Simulate applySignal for a signal emitted by feat-b's worker.
    const fid = lib.findTaskFeature(root, 'task-001', { featureId: 'feat-b' });
    assert.equal(fid, 'feat-b');
    lib.markTaskDone(lib.tasksFileFor(root, fid), 'task-001');

    assert.equal(lib.getTask(lib.tasksFileFor(root, 'feat-b'), 'task-001').status, 'completed');
    assert.equal(lib.getTask(lib.tasksFileFor(root, 'feat-a'), 'task-001').status, 'pending',
      'feature A must be untouched — no cross-feature write');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The run's own feature, recorded in the project (readScopedFeature).
//
// These cover the case the tests above missed: with a LIVE manifest present,
// findTaskFeature never reaches its ambiguity error — resolveActiveFeature
// answers first, confidently and sometimes wrongly. Observed for real: a
// worktree running `compact-probe` ran `jonggrang task update task-001` and
// updated `machine-md-probe`'s task instead, because that plan's manifest was
// the most recent running one.
// ---------------------------------------------------------------------------

function liveManifest(root, featureId, updatedAt) {
  ensureFeature(root, featureId);
  fs.writeFileSync(
    path.join(root, '.jonggrang', '.output', 'features', featureId, 'MANIFEST.yaml'),
    `status: running\nupdated_at: "${updatedAt}"\n`
  );
}

test('colliding id: another plan\'s live manifest wins when nothing scopes the run', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'other-plan', { title: 'theirs' });
    addTask(root, 'my-plan', { title: 'mine' });
    liveManifest(root, 'other-plan', '2026-08-21T22:00:00.000Z');
    liveManifest(root, 'my-plan', '2026-08-21T21:00:00.000Z');
    // Documents the trap, not a wish: this is why the marker exists.
    assert.equal(lib.findTaskFeature(root, 'task-001'), 'other-plan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeScopedFeature makes the running plan win over another plan\'s manifest', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'other-plan', { title: 'theirs' });
    addTask(root, 'my-plan', { title: 'mine' });
    liveManifest(root, 'other-plan', '2026-08-21T22:00:00.000Z');
    liveManifest(root, 'my-plan', '2026-08-21T21:00:00.000Z');
    assert.equal(lib.writeScopedFeature(root, 'my-plan'), true);
    assert.equal(lib.readScopedFeature(root), 'my-plan');
    assert.equal(lib.findTaskFeature(root, 'task-001'), 'my-plan');
    // And the write lands where it resolved, not just the read.
    lib.markTaskDone(lib.tasksFileFor(root, lib.findTaskFeature(root, 'task-001')), 'task-001');
    const mine = lib.getTasks(lib.tasksFileFor(root, 'my-plan')).tasks[0];
    const theirs = lib.getTasks(lib.tasksFileFor(root, 'other-plan')).tasks[0];
    assert.equal(mine.status, 'completed');
    assert.notEqual(theirs.status, 'completed', 'the other plan\'s task must be untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit feature still beats the recorded one', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'other-plan', { title: 'theirs' });
    addTask(root, 'my-plan', { title: 'mine' });
    lib.writeScopedFeature(root, 'my-plan');
    assert.equal(lib.findTaskFeature(root, 'task-001', { featureId: 'other-plan' }), 'other-plan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a scoped feature that has no such task does not hijack the resolve', () => {
  const root = tmpRepo();
  try {
    addTask(root, 'other-plan', { title: 'theirs' });   // task-001
    addTask(root, 'my-plan', { title: 'mine' });        // task-001
    addTask(root, 'other-plan', { title: 'theirs 2' }); // task-002, only there
    lib.writeScopedFeature(root, 'my-plan');
    assert.equal(lib.findTaskFeature(root, 'task-002'), 'other-plan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JONGGRANG_FEATURE_ID scopes the resolve where no file can be written', () => {
  const root = tmpRepo();
  const saved = process.env.JONGGRANG_FEATURE_ID;
  try {
    addTask(root, 'other-plan', { title: 'theirs' });
    addTask(root, 'my-plan', { title: 'mine' });
    liveManifest(root, 'other-plan', '2026-08-21T22:00:00.000Z');
    process.env.JONGGRANG_FEATURE_ID = 'my-plan';
    assert.equal(lib.findTaskFeature(root, 'task-001'), 'my-plan');
  } finally {
    if (saved === undefined) delete process.env.JONGGRANG_FEATURE_ID;
    else process.env.JONGGRANG_FEATURE_ID = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readScopedFeature is null when nothing recorded a feature', () => {
  const root = tmpRepo();
  try {
    assert.equal(lib.readScopedFeature(root), null);
    assert.equal(lib.writeScopedFeature(root, ''), false, 'an empty id records nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
