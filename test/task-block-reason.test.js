'use strict';

// A blocked task has to say why.
//
// Two places block a task: `task block --reason`, and the work loop when a task
// has failed work.kill_after_fails times. Only the first recorded a reason, so a
// task blocked by the loop arrived at a human as "blocked" with an empty
// error_log — indistinguishable from a real defect. Measured on a live board:
// five tasks blocked with nothing behind them, one of which was already finished
// and committed; the cause (the agent's quota ran out mid-run) was recorded
// nowhere.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../lib/jonggrang');

function tasksFile(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-block-'));
  const file = path.join(dir, 'jonggrang-tasks.json');
  fs.writeFileSync(file, JSON.stringify({ tasks }));
  return file;
}

test('blocking records the reason on the task', () => {
  const file = tasksFile([{ id: 'task-001', status: 'pending' }]);
  assert.equal(lib.blockTask(file, 'task-001', 'quota exhausted mid-run'), true);

  const task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(task.status, 'blocked');
  assert.equal(task.error_log.length, 1);
  assert.match(task.error_log[0], /Blocked: quota exhausted mid-run$/);
  assert.match(task.error_log[0], /^\[\d{4}-\d{2}-\d{2}T/, 'stamped, so it can be placed in a run');
});

test('an existing error_log is appended to, not replaced', () => {
  const file = tasksFile([{ id: 'task-001', status: 'pending', error_log: ['[earlier] something else'] }]);
  lib.blockTask(file, 'task-001', 'second time');
  const task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(task.error_log.length, 2);
  assert.match(task.error_log[1], /second time$/);
});

test('blocking without a reason still blocks, and invents nothing', () => {
  const file = tasksFile([{ id: 'task-001', status: 'pending' }]);
  lib.blockTask(file, 'task-001', undefined);
  const task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(task.status, 'blocked');
  assert.equal(task.error_log, undefined, 'no empty log, no fabricated reason');
});

test('an unknown task is reported, not silently written', () => {
  const file = tasksFile([{ id: 'task-001', status: 'pending' }]);
  assert.equal(lib.blockTask(file, 'task-404', 'whatever'), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].status, 'pending');
});
