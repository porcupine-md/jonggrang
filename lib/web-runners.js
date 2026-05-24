'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');

// Per-project subprocess state. Lives in memory only.
const _registry = new Map(); // projectId -> RunnerState

class RunnerState extends EventEmitter {
  constructor(projectId, projectPath) {
    super();
    this.setMaxListeners(50);
    this.projectId = projectId;
    this.projectPath = projectPath;
    this.proc = null;
    this.command = null;
    this.pid = null;
    this.startedAt = null;
    this._ring = [];
    this._seq = 0;
    this.RING_SIZE = 2000;
  }

  isRunning() {
    return this.proc !== null;
  }

  spawn(args, extraEnv = {}) {
    if (this.isRunning()) {
      const err = new Error('Process already running');
      err.code = 'PROCESS_ALREADY_RUNNING';
      throw err;
    }

    const env = {
      ...process.env,
      JONGGRANG_MODE: 'autonomous',
      NO_UPDATE_NOTIFIER: '1',
      FORCE_COLOR: '0',
      ...extraEnv,
    };

    // Remove interactive terminal vars so jonggrang detects non-TTY
    delete env.TERM;

    this.command = args[0] || 'unknown';
    this.startedAt = new Date().toISOString();

    let jonggrangBin = 'jonggrang';
    // If running inside this repo, prefer the local bin
    try {
      const localBin = require('path').join(__dirname, '..', 'bin', 'jonggrang.js');
      if (require('fs').existsSync(localBin)) {
        jonggrangBin = process.execPath; // node
        args = [localBin, ...args];
      }
    } catch {}

    const child = spawn(jonggrangBin === 'jonggrang' ? jonggrangBin : process.execPath,
      jonggrangBin === 'jonggrang' ? args : args,
      {
        cwd: this.projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

    this.proc = child;
    this.pid = child.pid;

    const handleChunk = (stream) => (data) => {
      const text = data.toString();
      // Split on newlines but keep partial lines buffered
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line && line !== '') continue;
        this._addLog(stream, line);
      }
    };

    child.stdout.on('data', handleChunk('stdout'));
    child.stderr.on('data', handleChunk('stderr'));

    child.on('close', (code, signal) => {
      this.proc = null;
      this.emit('exit', { code, signal });
    });

    child.on('error', (err) => {
      this.proc = null;
      this.emit('error', err);
    });

    return child;
  }

  _addLog(stream, line) {
    const entry = { seq: this._seq++, stream, line };
    this._ring.push(entry);
    if (this._ring.length > this.RING_SIZE) this._ring.shift();
    this.emit('log', entry);
  }

  getLogSince(seq) {
    return this._ring.filter(e => e.seq >= seq);
  }

  cancel() {
    if (!this.proc) return;
    try { this.proc.kill('SIGTERM'); } catch {}
    const p = this.proc;
    setTimeout(() => {
      try { if (p) p.kill('SIGKILL'); } catch {}
    }, 5000);
  }
}

function getRunner(projectId, projectPath) {
  if (!_registry.has(projectId)) {
    _registry.set(projectId, new RunnerState(projectId, projectPath));
  }
  return _registry.get(projectId);
}

function getExistingRunner(projectId) {
  return _registry.get(projectId) || null;
}

function removeRunner(projectId) {
  _registry.delete(projectId);
}

module.exports = { getRunner, getExistingRunner, removeRunner };
