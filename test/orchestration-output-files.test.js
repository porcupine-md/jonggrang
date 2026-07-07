'use strict';

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

// Create a temp project root with a dummy file for size checks
function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jonggrang-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'foo.js'), 'console.log("hello");');  // 21 bytes
  return dir;
}

function makeManifest(projectRoot, workType = 'SMALL') {
  const featureId = 'test-feat-001';
  return { ...orchestration.createManifest(projectRoot, featureId, 'test feature', workType), featureId };
}

console.log('\norchestration.js — output_files helpers\n');

// ── OUTPUT_TRACKING_PHASES export ─────────────────────────────

test('OUTPUT_TRACKING_PHASES is a Set', () => {
  assert.ok(orchestration.OUTPUT_TRACKING_PHASES instanceof Set);
});

test('OUTPUT_TRACKING_PHASES includes phases 8, 12, 14', () => {
  assert.ok(orchestration.OUTPUT_TRACKING_PHASES.has(8));
  assert.ok(orchestration.OUTPUT_TRACKING_PHASES.has(12));
  assert.ok(orchestration.OUTPUT_TRACKING_PHASES.has(14));
});

test('OUTPUT_TRACKING_PHASES does not include phase 7 or 11', () => {
  assert.ok(!orchestration.OUTPUT_TRACKING_PHASES.has(7));
  assert.ok(!orchestration.OUTPUT_TRACKING_PHASES.has(11));
});

// ── createManifest: output_files init ─────────────────────────

test('createManifest initialises output_files: [] on each phase', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  const manifest = orchestration.readManifest(manifestPath);
  for (const [num, phase] of Object.entries(manifest.phases)) {
    assert.ok(Array.isArray(phase.output_files), `phase ${num} missing output_files`);
    assert.strictEqual(phase.output_files.length, 0, `phase ${num} output_files should start empty`);
  }
});

// ── addOutputFile ─────────────────────────────────────────────

test('addOutputFile fills size from disk', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  const entry = orchestration.addOutputFile(manifestPath, 8, { path: 'src/foo.js', type: 'code' });
  assert.ok(typeof entry.size === 'number' && entry.size > 0, 'size not filled');
});

test('addOutputFile fills created_at from disk', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  const entry = orchestration.addOutputFile(manifestPath, 8, { path: 'src/foo.js', type: 'code' });
  assert.ok(entry.created_at, 'created_at not filled');
  assert.ok(!isNaN(new Date(entry.created_at).getTime()), 'created_at invalid ISO');
});

test('addOutputFile stores type from caller', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  const entry = orchestration.addOutputFile(manifestPath, 8, { path: 'src/foo.js', type: 'code' });
  assert.strictEqual(entry.type, 'code');
});

test('addOutputFile defaults type to "output" when omitted', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  const entry = orchestration.addOutputFile(manifestPath, 8, { path: 'src/foo.js' });
  assert.strictEqual(entry.type, 'output');
});

test('addOutputFile is idempotent — same path replaces, not duplicates', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  orchestration.addOutputFile(manifestPath, 8, { path: 'src/foo.js', type: 'output' });
  orchestration.addOutputFile(manifestPath, 8, { path: 'src/foo.js', type: 'code' });
  const manifest = orchestration.readManifest(manifestPath);
  assert.strictEqual(manifest.phases[8].output_files.length, 1, 'should have 1 entry, not 2');
  assert.strictEqual(manifest.phases[8].output_files[0].type, 'code', 'last write should win');
});

test('addOutputFile throws for unknown phase', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  assert.throws(
    () => orchestration.addOutputFile(manifestPath, 99, { path: 'src/foo.js' }),
    /Phase 99 not found/
  );
});

test('addOutputFile throws for empty path', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  assert.throws(
    () => orchestration.addOutputFile(manifestPath, 8, { path: '' }),
    /path must be a non-empty string/
  );
});

test('addOutputFile handles missing file gracefully — size: null', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  const entry = orchestration.addOutputFile(manifestPath, 8, { path: 'src/nonexistent.js', type: 'code' });
  assert.strictEqual(entry.size, null);
  assert.strictEqual(entry.created_at, null);
});

test('addOutputFile persists to MANIFEST.yaml', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  orchestration.addOutputFile(manifestPath, 8, { path: 'src/foo.js', type: 'code' });
  const reread = orchestration.readManifest(manifestPath);
  assert.strictEqual(reread.phases[8].output_files.length, 1);
  assert.strictEqual(reread.phases[8].output_files[0].path, 'src/foo.js');
});

// ── addOutputFiles (bulk) ─────────────────────────────────────

test('addOutputFiles returns array of stored entries', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  const results = orchestration.addOutputFiles(manifestPath, 8, [
    { path: 'src/foo.js', type: 'code' },
    { path: 'src/bar.js', type: 'code' },
  ]);
  assert.strictEqual(results.length, 2);
});

// ── buildPhaseContext: no OUTPUT_FILES instruction (git-based tracking) ──

test('buildPhaseContext does not include OUTPUT_FILES instruction (git-based)', () => {
  const manifest = {
    description: 'test',
    work_type: 'SMALL',
    active_phases: [8],
    phases: { 8: { status: 'running' } },
  };
  const ctx = orchestration.buildPhaseContext(manifest, 8);
  assert.ok(!ctx.includes('OUTPUT_FILES:'), 'OUTPUT_FILES instruction should not be in prompt (git-based tracking)');
});

// ── buildPhaseContext: memory policy injection (#79) ──────────
// Regression guard: phases 3-7, 9-17 must inject memory policy (recall + read
// + link guidance). Phase 8 must NOT (buildWorkPrompt already injects it there).
// If someone edits buildPhaseContext and drops the inject, these go red.

function makeMemManifest(featureId = 'feat-test') {
  return {
    description: 'test feature',
    work_type: 'SMALL',
    active_phases: [3, 8, 9, 14],
    feature_id: featureId,
    phases: { 3: { status: 'completed' }, 8: { status: 'completed' } },
  };
}

test('buildPhaseContext injects memory policy for agent-bearing phases (3-17, except 8)', () => {
  const root = makeTempProject();
  const manifest = makeMemManifest('feat-test');
  // Sample phases across the range: discovery(3), architecting(7),
  // simplification(9), code-quality(12), testing(14), completion(17)
  for (const phaseNum of [3, 7, 9, 12, 14, 17]) {
    const ctx = orchestration.buildPhaseContext(
      { ...manifest, current_phase: phaseNum },
      phaseNum,
      root,
    );
    assert.ok(ctx.includes('## Jonggrang Memory Policy'),
      `phase ${phaseNum} should inject memory policy header`);
    assert.ok(/jonggrang memory recall --query/.test(ctx),
      `phase ${phaseNum} should include recall command`);
    assert.ok(/jonggrang memory read/.test(ctx),
      `phase ${phaseNum} should include read command`);
    assert.ok(/\[label\]\(path\)/.test(ctx),
      `phase ${phaseNum} should include link-tracing guidance`);
  }
});

test('buildPhaseContext does NOT inject memory policy for phase 8 (no double-inject)', () => {
  const root = makeTempProject();
  const manifest = makeMemManifest('feat-test');
  const ctx = orchestration.buildPhaseContext(
    { ...manifest, current_phase: 8 },
    8,
    root,
  );
  assert.ok(!ctx.includes('## Jonggrang Memory Policy'),
    'phase 8 must not inject memory policy (buildWorkPrompt handles it)');
});

test('buildPhaseContext passes feature_id through to memory policy prompt', () => {
  const root = makeTempProject();
  const manifest = makeMemManifest('feat-billing');
  const ctx = orchestration.buildPhaseContext(
    { ...manifest, current_phase: 9 },
    9,
    root,
  );
  assert.ok(ctx.includes('--feature feat-billing'),
    'memory policy should contain concrete featureId in recall/read commands');
});

// ── completePhase with outputFiles param ─────────────────────

test('completePhase 4-arg with outputFiles stores files', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  orchestration.startPhase(manifestPath, 8);
  orchestration.completePhase(manifestPath, 8, { done: true }, [{ path: 'src/foo.js', type: 'code' }]);
  const manifest = orchestration.readManifest(manifestPath);
  assert.strictEqual(manifest.phases[8].status, 'completed');
  assert.strictEqual(manifest.phases[8].output_files.length, 1);
  assert.strictEqual(manifest.phases[8].output_files[0].path, 'src/foo.js');
});

test('completePhase 3-arg (backward compat) leaves output_files empty', () => {
  const projectRoot = makeTempProject();
  const { manifestPath } = makeManifest(projectRoot);
  orchestration.startPhase(manifestPath, 8);
  orchestration.completePhase(manifestPath, 8, { done: true });
  const manifest = orchestration.readManifest(manifestPath);
  assert.strictEqual(manifest.phases[8].status, 'completed');
  assert.deepStrictEqual(manifest.phases[8].output_files, []);
});

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
