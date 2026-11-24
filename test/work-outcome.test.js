// runIteration used to answer the work loop with a bare boolean. A quota that ran
// dry, an agent that crashed, and a task a human has to look at were all `false`,
// so the loop applied one strategy to all three and the reason never reached the
// human — five tasks once came back `blocked` with an empty error_log, one of them
// already finished. These tests pin the three outcomes and, above all, that the
// reason survives the trip from the agent to the task file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'jonggrang.js');
const lib = require(path.join(REPO, 'lib', 'jonggrang.js'));
const orchestration = require(path.join(REPO, 'lib', 'orchestration.js'));

const FEATURE = 'feat-probe';

// A whole project on disk: config, manifest, one pending task, and a fake agent
// on PATH. `agentScript` is the body of that agent, so a test decides exactly how
// the agent fails. compact pipeline stops the run after Implement, which is the
// only phase these tests care about.
const scratch = [];
test.after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

function makeProject(agentScript, killAfterFails = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-outcome-'));
  scratch.push(root);
  const featDir = path.join(root, '.jonggrang', '.output', 'features', FEATURE);
  fs.mkdirSync(featDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'fakebin'));

  fs.writeFileSync(path.join(root, '.jonggrang', 'jonggrang.json'), JSON.stringify({
    project: { name: 'probe' },
    tool: 'opencode',
    work: { kill_after_fails: killAfterFails },
    testing: { command: '' },
  }));

  fs.writeFileSync(path.join(featDir, 'jonggrang-tasks.json'), JSON.stringify({
    tasks: [{
      id: 'task-001', title: 'probe', description: 'probe', priority: 1,
      status: 'pending', feature_id: FEATURE, skill: null, blocked_by: [],
      passes: false, files: [], started_at: null, completed_at: null, error_log: [],
    }],
  }));

  const created = orchestration.createManifest(root, FEATURE, 'probe', 'SMALL', { pipelineMode: 'compact' });
  const mPath = orchestration.getManifestPath(root, FEATURE);
  orchestration.writeManifest(mPath, created.manifest || created);
  // The planning phases are what `plan` + `approve` would already have done.
  for (const n of [1, 2, 3, 4]) orchestration.completePhase(mPath, n, { source: 'test' });

  const agent = path.join(root, 'fakebin', 'opencode');
  fs.writeFileSync(agent, agentScript);
  fs.chmodSync(agent, 0o755);

  return { root, tasksFile: path.join(featDir, 'jonggrang-tasks.json') };
}

function runWork(root) {
  return spawnSync(process.execPath, [
    CLI, 'work', '--feature', FEATURE, '--group-tasks', 'task-001', '--max-iterations', '6',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(root, 'fakebin')}:${process.env.PATH}` },
  });
}

// ── retry: the agent died on us ───────────────────────────────────────────

test('a crashed agent blocks the task with the exit code, not a shrug', () => {
  const { root, tasksFile } = makeProject('#!/bin/sh\necho "out of quota" >&2\nexit 1\n');
  runWork(root);

  const task = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks[0];
  assert.equal(task.status, 'blocked');
  assert.equal(task.error_log.length, 1, 'the give-up path records exactly one reason');
  // The point of the whole change: this used to read "no per-pass reason was
  // recorded — check the run log", which is a note saying the note is missing.
  assert.match(task.error_log[0], /agent exited with code 1/,
    'the reason the agent actually failed reaches the task file');
  assert.match(task.error_log[0], /kill_after_fails=2/, 'and so does the budget it exhausted');
});

// ── retry: the agent lived but did nothing ────────────────────────────────

test('an agent that exits clean without finishing names that as the reason', () => {
  const { root, tasksFile } = makeProject('#!/bin/sh\nexit 0\n');
  runWork(root);

  const task = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks[0];
  assert.equal(task.status, 'blocked');
  assert.match(task.error_log[0], /exited 0 but left the task/,
    'exit 0 with the work undone is its own failure, distinct from a crash');
});

// ── die: dispatching a task that is not there ─────────────────────────────

test('a task missing from the file would build an empty prompt', () => {
  const { tasksFile } = makeProject('#!/bin/sh\nexit 0\n');
  // This is why the `die` guard exists rather than letting the dispatch proceed:
  // the prompt builder does not throw for an unknown id, it returns nothing. An
  // agent spawned on that burns a full pass on an empty prompt and then reads as
  // a failed task. Every queue builder filters unknown ids today, so the guard
  // covers the window where the file changes between queue build and dispatch —
  // the dashboard and the agent both write this file while a run is in flight.
  assert.equal(lib.buildWorkPrompt('task-404', tasksFile, 'default'), '',
    'an unknown task yields an empty prompt instead of an error');
});

// ── the shape itself ──────────────────────────────────────────────────────

test('every runIteration exit is a tagged outcome, never a bare boolean', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const body = src.slice(src.indexOf('async function runIteration('));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);

  const returns = fn.match(/return [^;]+;/g) || [];
  assert.ok(returns.length >= 9, `expected every exit to be covered, saw ${returns.length}`);
  for (const r of returns) {
    assert.doesNotMatch(r, /return (true|false);/,
      `a bare boolean throws the reason away: ${r}`);
  }
  assert.ok(returns.some(r => r.includes("fail('retry'")), 'transient failures are retryable');
  assert.ok(returns.some(r => r.includes("fail('escape'")), 'some failures need a human');
  assert.ok(returns.some(r => r.includes("fail('die'")), 'a broken invariant stops the run');
});
