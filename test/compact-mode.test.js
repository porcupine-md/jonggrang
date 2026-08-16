'use strict';

// Compact pipeline mode — the manifest bookkeeping that lets a run stop after
// Implement and still be resumed later: finalizeRemainingPhases,
// reopenCompactPhases, findCompactManifest and the pipeline_mode field.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orchestration = require('../lib/orchestration');

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

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jg-compact-'));
}

// A feature that has run through Implement: phases 1-8 completed, gates pending.
function seedImplemented(root, featureId, workType = 'MEDIUM', options = {}) {
  const { manifestPath } = orchestration.createManifest(root, featureId, 'a feature', workType, options);
  for (const n of orchestration.getActivePhases(workType)) {
    if (n <= orchestration.COMPACT_LAST_PHASE) {
      orchestration.completePhase(manifestPath, n, { source: 'test' });
    }
  }
  return manifestPath;
}

console.log('\ncompact-mode — pipeline stops after Implement\n');

// ── pipeline_mode on the manifest ─────────────────────────────

test('createManifest defaults to the full pipeline', () => {
  const { manifest } = orchestration.createManifest(tmpProject(), 'f1', 'desc', 'MEDIUM');
  assert.strictEqual(manifest.pipeline_mode, 'full');
});

test('createManifest records compact when asked', () => {
  const { manifest } = orchestration.createManifest(tmpProject(), 'f1', 'desc', 'MEDIUM', { pipelineMode: 'compact' });
  assert.strictEqual(manifest.pipeline_mode, 'compact');
});

test('setPipelineMode flips an existing manifest', () => {
  const root = tmpProject();
  const { manifestPath } = orchestration.createManifest(root, 'f1', 'desc', 'MEDIUM');
  orchestration.setPipelineMode(manifestPath, 'compact');
  assert.strictEqual(orchestration.readManifest(manifestPath).pipeline_mode, 'compact');
});

// ── finalizeRemainingPhases ───────────────────────────────────

test('finalize marks every unfinished active phase skipped and the run completed', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'f1');
  const result = orchestration.finalizeRemainingPhases(manifestPath, { reason: orchestration.COMPACT_SKIP_REASON });

  const m = orchestration.readManifest(manifestPath);
  assert.strictEqual(m.status, 'completed');
  assert.strictEqual(m.current_phase, null);
  assert.ok(result.skipped.length > 0, 'expected gate phases to be deferred');
  assert.ok(result.skipped.every(n => n > orchestration.COMPACT_LAST_PHASE),
    `only post-Implement phases should be deferred, got ${result.skipped}`);
  for (const n of result.skipped) {
    assert.strictEqual(m.phases[n].status, 'skipped');
    assert.strictEqual(m.phases[n].skip_reason, orchestration.COMPACT_SKIP_REASON);
  }
});

test('finalize never touches phases that already completed', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'f1');
  orchestration.finalizeRemainingPhases(manifestPath, { reason: orchestration.COMPACT_SKIP_REASON });
  const m = orchestration.readManifest(manifestPath);
  for (const n of orchestration.getActivePhases('MEDIUM')) {
    if (n <= orchestration.COMPACT_LAST_PHASE) assert.strictEqual(m.phases[n].status, 'completed');
  }
});

test('finalize is idempotent', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'f1');
  orchestration.finalizeRemainingPhases(manifestPath, { reason: orchestration.COMPACT_SKIP_REASON });
  const second = orchestration.finalizeRemainingPhases(manifestPath, { reason: orchestration.COMPACT_SKIP_REASON });
  assert.deepStrictEqual(second.skipped, []);
  assert.strictEqual(orchestration.readManifest(manifestPath).status, 'completed');
});

test('finalize returns null for a missing manifest', () => {
  assert.strictEqual(orchestration.finalizeRemainingPhases(path.join(tmpProject(), 'nope.yaml')), null);
});

// ── resume: reopening what compact deferred ───────────────────

test('reopenCompactPhases puts the deferred gates back to pending', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'f1', 'MEDIUM', { pipelineMode: 'compact' });
  const { skipped } = orchestration.finalizeRemainingPhases(manifestPath, { reason: orchestration.COMPACT_SKIP_REASON });

  const reopened = orchestration.reopenCompactPhases(manifestPath);
  assert.deepStrictEqual(reopened, skipped);

  const m = orchestration.readManifest(manifestPath);
  assert.strictEqual(m.status, 'in_progress');
  assert.strictEqual(m.current_phase, skipped[0]);
  for (const n of reopened) {
    assert.strictEqual(m.phases[n].status, 'pending');
    assert.strictEqual(m.phases[n].skip_reason, undefined);
  }
});

test('reopenCompactPhases leaves a BUGFIX gate skip alone', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'f1', 'BUGFIX');
  orchestration.finalizeRemainingPhases(manifestPath, { reason: 'bugfix-no-gates' });
  assert.deepStrictEqual(orchestration.reopenCompactPhases(manifestPath), []);
  assert.strictEqual(orchestration.readManifest(manifestPath).status, 'completed');
});

test('reopenCompactPhases on a full run does nothing', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'f1');
  assert.deepStrictEqual(orchestration.reopenCompactPhases(manifestPath), []);
});

// ── finding a compact run to resume ───────────────────────────

test('findCompactManifest ignores an untouched full run', () => {
  const root = tmpProject();
  seedImplemented(root, 'full-feature');
  assert.strictEqual(orchestration.findCompactManifest(root), null);
});

test('findCompactManifest locates a compact-finalized run', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'compact-feature', 'MEDIUM', { pipelineMode: 'compact' });
  orchestration.finalizeRemainingPhases(manifestPath, { reason: orchestration.COMPACT_SKIP_REASON });

  const found = orchestration.findCompactManifest(root);
  assert.ok(found, 'expected the compact run to be found');
  assert.strictEqual(found.featureId, 'compact-feature');
});

test('findCompactManifest stops matching once the gates are reopened', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'compact-feature', 'MEDIUM', { pipelineMode: 'compact' });
  orchestration.finalizeRemainingPhases(manifestPath, { reason: orchestration.COMPACT_SKIP_REASON });
  orchestration.reopenCompactPhases(manifestPath);
  assert.strictEqual(orchestration.findCompactManifest(root), null);
});

test('a compact-finalized run is invisible to findIncompleteManifest', () => {
  const root = tmpProject();
  const manifestPath = seedImplemented(root, 'compact-feature', 'MEDIUM', { pipelineMode: 'compact' });
  orchestration.finalizeRemainingPhases(manifestPath, { reason: orchestration.COMPACT_SKIP_REASON });
  assert.strictEqual(orchestration.findIncompleteManifest(root), null);
  // …but it becomes resumable again once the gates are reopened.
  orchestration.reopenCompactPhases(manifestPath);
  assert.strictEqual(orchestration.findIncompleteManifest(root).featureId, 'compact-feature');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
