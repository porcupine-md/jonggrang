'use strict';

// Behavioral coverage for the run-liveness properties that used to be pinned by
// source-regex assertions in test/device-tunnel.test.js ("a run whose dashboard
// restarted was running forever").
//
// What these guard:
//   - A snapshot on disk says `running` long after the worker died with its
//     dashboard. reconcileSnapshot reads it back as `interrupted` WITH a reason,
//     so it does not read as a mystery — and the already-running guard must not
//     trust the stored status.
//   - groupIsLive asks the OS whether the child is alive (process.kill(pid, 0)),
//     so a plan whose worker died can be started again.
//   - runActive answers "is anything in this run still going?" from the groups.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const register = require('../apis/projects/orchestration-run');

// The factory only wires routes; nothing runs until a route is hit. A minimal
// deps object is enough, and the factory hands its internals back on it.
function makeTest() {
  const activeRuns = new Map();
  const deps = {
    fs,
    webState: { getProject: () => null, getProjectSecretVars: () => ({}) },
    io: { on: () => {}, to: () => ({ emit: () => {} }), emit: () => {} },
    JONGGRANG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'jg-orch-')),
    activeRuns,
  };
  register(deps);
  assert.ok(deps.orchestrationRunTest, 'factory exposes its internals for tests');
  return { deps, activeRuns, testApi: deps.orchestrationRunTest };
}

// ── reconcileSnapshot ─────────────────────────────────────────────

test('reconcileSnapshot marks running and queued groups interrupted, with a reason', () => {
  const { testApi } = makeTest();
  const snap = {
    status: 'running',
    groups: [
      { feature_id: 'a', status: 'running' },
      { feature_id: 'b', status: 'queued' },
      { feature_id: 'c', status: 'completed' },
    ],
  };
  const out = testApi.reconcileSnapshot(snap);
  assert.equal(out.groups[0].status, 'interrupted');
  assert.match(out.groups[0].error, /dashboard restarted/);
  assert.equal(out.groups[1].status, 'interrupted');
  assert.equal(out.groups[2].status, 'completed', 'finished work is left alone');
  assert.equal(out.status, 'interrupted');
});

test('reconcileSnapshot leaves a fully finished snapshot alone', () => {
  const { testApi } = makeTest();
  const snap = { status: 'completed', groups: [{ feature_id: 'a', status: 'completed' }] };
  assert.equal(testApi.reconcileSnapshot(snap), snap, 'same object, untouched');
});

test('reconcileSnapshot tolerates a missing snapshot', () => {
  const { testApi } = makeTest();
  assert.equal(testApi.reconcileSnapshot(null), null);
});

// ── groupIsLive ───────────────────────────────────────────────────

test('groupIsLive: a live child answers true, a dead pid answers false', () => {
  const { activeRuns, testApi } = makeTest();
  // groupIsLive takes a project OBJECT (it reads project.id), like its call sites.
  const p1 = { id: 'p1' };
  activeRuns.set('p1', { groups: { a: { status: 'running', child: { pid: process.pid } } } });
  assert.equal(testApi.groupIsLive(p1, 'a'), true, 'this process is alive');

  activeRuns.get('p1').groups.b = { status: 'running', child: { pid: 2 ** 30 } };
  assert.equal(testApi.groupIsLive(p1, 'b'), false, 'a pid no OS process owns is dead');
});

test('groupIsLive: stored status is never trusted on its own', () => {
  const { activeRuns, testApi } = makeTest();
  const p1 = { id: 'p1' };
  activeRuns.set('p1', {
    groups: {
      a: { status: 'running', child: { pid: 2 ** 30 } },   // says running, dead
      b: { status: 'completed', child: { pid: process.pid } }, // alive, but finished
      c: { status: 'queued' },                              // queued, no child yet
      d: { status: 'running' },                             // no child at all
    },
  });
  assert.equal(testApi.groupIsLive(p1, 'a'), false, 'running + dead pid = not live');
  assert.equal(testApi.groupIsLive(p1, 'b'), false, 'completed is never live');
  assert.equal(testApi.groupIsLive(p1, 'c'), true, 'a queued group is still coming');
  assert.equal(testApi.groupIsLive(p1, 'd'), false, 'running with no pid is not provable live');
  assert.equal(testApi.groupIsLive(p1, 'nope'), false, 'unknown group');
  assert.equal(testApi.groupIsLive({ id: 'p2' }, 'a'), false, 'unknown project');
});

// ── runActive ─────────────────────────────────────────────────────

test('runActive reflects whether any group is still going', () => {
  const { testApi } = makeTest();
  assert.ok(!testApi.runActive(null), 'no run at all');
  assert.equal(testApi.runActive({ groups: {} }), false);
  assert.equal(
    testApi.runActive({ groups: { a: { status: 'completed' }, b: { status: 'failed' } } }),
    false
  );
  assert.equal(
    testApi.runActive({ groups: { a: { status: 'completed' }, b: { status: 'queued' } } }),
    true
  );
});
