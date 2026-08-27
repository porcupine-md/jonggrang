'use strict';

// When the dashboard is told a run ended, and what it says is running.
//
// Both used to hang on the child's `close` event alone. `close` waits for the
// stdio pipes to close, and a grandchild holding one open keeps it from ever
// firing — so a finished plan never reported its exit, and its entry stayed in
// `activePlan`. The dashboard then drew a "generating" row for a process that had
// been gone for an hour, and that phantom row swallowed the plan list's
// selection: the finished draft could not be opened, let alone approved.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const express = require('express');

const register = require('../apis/projects');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => { child.killed = true; };
  return child;
}

// Records what the server emitted, and hands back the socket handlers it wired.
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jong-proc-life-'));
  fs.mkdirSync(path.join(root, '.jonggrang'), { recursive: true });
  const project = { id: 'p1', path: root, init_status: 'ready' };

  const emitted = [];
  const io = {
    to: () => ({ emit: (name, payload) => emitted.push({ name, payload }) }),
    emit: (name, payload) => emitted.push({ name, payload }),
    // Several routers register a connection handler; only one of them owns
    // `subscribe`, so keep them all and let the socket be offered to each.
    on: (event, handler) => { if (event === 'connection') io._connections.push(handler); },
    _connections: [],
  };

  const ctx = {
    JONGGRANG_HOME: path.join(__dirname, '..'),
    webState: {
      getProject: (id) => (id === 'p1' ? project : null),
      listProjects: () => [],
      deriveState: () => ({ state: 'ready' }),
      getProjectSecretVars: () => ({}),
      updateProject: () => {},
      getProjectSecrets: () => ({}),
    },
    orchestration: { readManifest: () => null },
    server: null,
  };

  const app = express();
  app.use(express.json());
  const cleanup = register(app, io, ctx);

  // Drive the subscribe handler the browser uses, and capture its snapshot.
  const subscribe = () => {
    const socket = new EventEmitter();
    socket.join = () => {};
    socket.leave = () => {};
    const sent = [];
    socket.emit = (name, payload) => { sent.push({ name, payload }); return true; };
    for (const handler of io._connections) handler(socket);
    const subscribeHandler = socket.listeners('subscribe')[0];
    assert.equal(typeof subscribeHandler, 'function', 'the subscribe handler is wired');
    subscribeHandler({ project_id: 'p1' });
    return sent.find(m => m.name === 'subscribed')?.payload?.snapshot;
  };

  return { deps: cleanup.deps, emitted, subscribe, cleanup, root, project };
}

test('a run that ends without closing its pipes still reports its exit', () => {
  const h = harness();
  try {
    const child = fakeChild();
    h.deps.wireProjectProcess('p1', child, 'plan');

    // The process ends. `close` never comes — a grandchild still holds a pipe.
    child.exitCode = 0;
    child.emit('exit', 0, null);

    const exits = h.emitted.filter(m => m.name === 'process.exited');
    assert.equal(exits.length, 1, 'the dashboard is told, on exit alone');
    assert.equal(exits[0].payload.code, 0);
  } finally {
    h.cleanup();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('exit and close together report the end once, not twice', () => {
  const h = harness();
  try {
    const child = fakeChild();
    h.deps.wireProjectProcess('p1', child, 'plan');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    assert.equal(h.emitted.filter(m => m.name === 'process.exited').length, 1);
  } finally {
    h.cleanup();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('a trailing line with no newline is still flushed to the log', () => {
  const h = harness();
  try {
    const child = fakeChild();
    h.deps.wireProjectProcess('p1', child, 'plan');
    child.stdout.emit('data', Buffer.from('last line without a newline'));
    child.emit('close', 0, null);
    const logs = h.emitted.filter(m => m.name === 'process.log').map(m => m.payload.line);
    assert.ok(logs.includes('last line without a newline'), 'close still flushes the tail');
  } finally {
    h.cleanup();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('a live plan process is reported as running', () => {
  const h = harness();
  try {
    h.deps.activePlan.set('p1', { child: fakeChild(), command: 'plan' });
    assert.deepEqual(h.subscribe().process, { command: 'plan' });
  } finally {
    h.cleanup();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('a plan entry whose process already ended is not reported, and is dropped', () => {
  const h = harness();
  try {
    const child = fakeChild();
    child.exitCode = 0;                      // it is gone; only the entry remains
    h.deps.activePlan.set('p1', { child, command: 'plan' });

    assert.equal(h.subscribe().process, null, 'no phantom "generating" to restore');
    assert.equal(h.deps.activePlan.has('p1'), false, 'and the leftover is cleared');
  } finally {
    h.cleanup();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('a killed plan process is not reported either', () => {
  const h = harness();
  try {
    const child = fakeChild();
    child.signalCode = 'SIGKILL';
    h.deps.activePlan.set('p1', { child, command: 'plan' });
    assert.equal(h.subscribe().process, null);
    assert.equal(h.deps.activePlan.has('p1'), false);
  } finally {
    h.cleanup();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});
