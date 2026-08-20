'use strict';

// A run that burned nine identical passes on one task, ~2.3M tokens, and
// finished with all 16 tasks still `pending`.
//
// What happened: the dashboard writes `pty_resize`/`pty_input` JSON frames into
// the worker's stdin whenever a browser tab has that plan's terminal open. A
// HEADLESS worker never reads its stdin, so the frames queued in the pipe — until
// the work loop's test-retry escalation called `readline.question` and swallowed
// one as if a human had typed feedback. Non-empty "feedback" resets testAttempt
// to 0, so the same task was re-dispatched forever, and work.kill_after_fails
// couldn't stop it (it only counts failures runIteration actually returns).
//
// Four guards, one per layer:
//   1. don't write frames to a worker with no live pty  (server)
//   2. don't accept a control frame as human feedback   (worker)
//   3. cap how many times feedback may restart the budget (worker)
//   4. count failures per task, and never re-queue a blocked one (work loop)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ptyRelay } = require('../apis/projects/orchestration-run');
const { sendPtyFrame, markPtyLive } = ptyRelay;
const lib = require('../lib/jonggrang');
const sandbox = require('../lib/sandbox');

// A group whose child records everything written to stdin.
function fakeGroup(extra = {}) {
  const written = [];
  return {
    written,
    child: { stdin: { destroyed: false, write: (s) => { written.push(s); return true; } } },
    ...extra,
  };
}

// ── 1. the server side ────────────────────────────────────────────

test('a headless worker gets no frames on stdin', () => {
  const g = fakeGroup();                        // no ptyLive
  assert.equal(sendPtyFrame(g, { type: 'pty_input', b64: 'aGk=' }), false);
  assert.equal(sendPtyFrame(g, { type: 'pty_resize', cols: 120, rows: 40 }), false);
  assert.deepEqual(g.written, [], 'nothing may reach a stdin nobody is reading');
});

test('a live pty gets its frames', () => {
  const g = fakeGroup({ ptyLive: true });
  assert.equal(sendPtyFrame(g, { type: 'pty_input', b64: 'aGk=' }), true);
  assert.equal(g.written.length, 1);
  assert.deepEqual(JSON.parse(g.written[0]), { type: 'pty_input', b64: 'aGk=' });
  assert.ok(g.written[0].endsWith('\n'), 'frames are newline-delimited');
});

test('geometry sent before the pty is live is delivered once it is', () => {
  const g = fakeGroup();
  sendPtyFrame(g, { type: 'pty_resize', cols: 120, rows: 40 });
  assert.deepEqual(g.written, [], 'held, not written');

  markPtyLive(g);                               // first pty_data from the worker
  assert.equal(g.written.length, 1, 'the held geometry is flushed');
  assert.deepEqual(JSON.parse(g.written[0]), { type: 'pty_resize', cols: 120, rows: 40 });
  assert.equal(g.pendingResize, null, 'and not flushed twice');
});

test('only the latest early geometry is kept, and keystrokes are dropped', () => {
  const g = fakeGroup();
  sendPtyFrame(g, { type: 'pty_resize', cols: 80, rows: 24 });
  sendPtyFrame(g, { type: 'pty_resize', cols: 120, rows: 40 });
  sendPtyFrame(g, { type: 'pty_input', b64: 'aGk=' });
  markPtyLive(g);
  assert.equal(g.written.length, 1, 'one resize, no buffered keystrokes');
  assert.equal(JSON.parse(g.written[0]).cols, 120);
});

test('markPtyLive on an already-live group is a no-op', () => {
  const g = fakeGroup({ ptyLive: true });
  markPtyLive(g);
  assert.deepEqual(g.written, []);
});

test('a destroyed stdin is not written to', () => {
  const g = fakeGroup({ ptyLive: true });
  g.child.stdin.destroyed = true;
  assert.equal(sendPtyFrame(g, { type: 'pty_input', b64: 'aGk=' }), false);
  assert.deepEqual(g.written, []);
});

// ── 2. the worker side ────────────────────────────────────────────

test('control frames are not human feedback', () => {
  assert.equal(lib.isControlFrame('{"type":"pty_resize","cols":120,"rows":40}'), true);
  assert.equal(lib.isControlFrame('{"type":"pty_input","b64":"aGk="}'), true);
  assert.equal(lib.isControlFrame('{"type":"task_status","taskId":"task-001"}'), true);
  assert.equal(lib.isControlFrame('  {"type":"pty_exit","code":0}  '), true, 'whitespace tolerated');
});

test('real feedback is not mistaken for a control frame', () => {
  assert.equal(lib.isControlFrame('scope the gate to --project shared'), false);
  assert.equal(lib.isControlFrame(''), false);
  assert.equal(lib.isControlFrame(null), false);
  assert.equal(lib.isControlFrame('{ not json'), false);
  assert.equal(lib.isControlFrame('{"type":"advice","text":"fix the test"}'), false,
    'a JSON object that is not one of our frames is left alone');
});

// The escalation loop resets testAttempt to 0 on every accepted feedback, so the
// only thing standing between it and an unbounded re-dispatch is this cap.
test('the feedback round cap is wired into the escalation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'jonggrang.js'), 'utf8');
  assert.match(src, /const TEST_FEEDBACK_ROUND_LIMIT = \d+;/, 'a cap is declared');
  assert.match(src, /feedbackRounds >= TEST_FEEDBACK_ROUND_LIMIT/, 'the cap is checked');
  assert.match(src, /feedbackRounds\+\+/, 'and rounds are counted');
  assert.match(src, /lib\.isControlFrame\(userInput\)/, 'and control frames rejected');
});

// Found by the e2e run, not by reading the code: with the escalation fixed, the
// run STILL looped. runWorkLoop tracked a single "last failed task", so two
// failing tasks reset each other's counter and killAfter was never reached —
// and a task runIteration had already marked `blocked` was re-queued anyway.
// 17 iterations and climbing on a two-task plan.
test('the work loop counts failures per task and does not re-queue a blocked one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'jonggrang.js'), 'utf8');
  assert.match(src, /const failCounts = new Map\(\)/, 'failures are counted per task');
  assert.doesNotMatch(src, /lastFailedTask/, 'the single rolling counter is gone');
  assert.match(src, /if \(status === 'blocked'\)/, 'a blocked task is recognised');
  assert.match(src, /leaving it for a human instead of re-queuing/, 'and not re-queued');
});

// ── 3. the stale-container warning ────────────────────────────────

test('an older jonggrang in the container reads as outdated', () => {
  assert.deepEqual(sandbox.versionStatus('0.16.0', '0.19.1'),
    { version: '0.16.0', expected: '0.19.1', outdated: true });
});

test('same or newer is not reported', () => {
  assert.equal(sandbox.versionStatus('0.19.1', '0.19.1').outdated, false);
  assert.equal(sandbox.versionStatus('0.20.0', '0.19.1').outdated, false,
    'a dev image ahead of the server is not a problem to report');
});

test('an unknown container version reports nothing rather than guessing', () => {
  assert.equal(sandbox.versionStatus(null, '0.19.1'), null);
});

test('version comparison is numeric, not lexical', () => {
  assert.ok(sandbox.compareVersions('0.9.0', '0.10.0') < 0, '0.9.0 < 0.10.0');
  assert.ok(sandbox.compareVersions('1.2.3', '1.2.3') === 0);
  assert.ok(sandbox.compareVersions('0.19.10', '0.19.9') > 0);
});
