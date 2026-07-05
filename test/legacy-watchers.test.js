'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const test = require('node:test');

function tempProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'jong-legacy-watchers-'));
}

function withFakeChokidar(fn) {
    const originalLoad = Module._load;
    const watchers = [];
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'chokidar') {
            return {
                watch(target, options) {
                    const watcher = {
                        target,
                        options,
                        handlers: {},
                        closed: false,
                        on(event, handler) {
                            this.handlers[event] = handler;
                            return this;
                        },
                        close() {
                            this.closed = true;
                            return Promise.resolve();
                        },
                    };
                    watchers.push(watcher);
                    return watcher;
                },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return fn(watchers);
    } finally {
        Module._load = originalLoad;
    }
}

test('legacy server watches feature and draft dirs in a fresh repo', () => {
    const projectRoot = tempProject();
    const events = [];
    let activeDraft = null;

    try {
        withFakeChokidar((watchers) => {
            const register = require('../apis/legacy');
            const app = { use() {} };
            const io = {
                emit(event, payload) { events.push({ event, payload }); },
                on() {},
            };
            const ctx = {
                PROJECT_ROOT: projectRoot,
                JONGGRANG_HOME: path.join(projectRoot, '.jonggrang-home'),
                lib: {
                    getAllTasks() { return { tasks: [{ id: 'T1' }] }; },
                    resolveActiveFeature() { return 'feature-1'; },
                    progressFileFor(root, fid) {
                        return path.join(root, '.jonggrang', '.output', 'features', fid, 'progress.txt');
                    },
                    fileExists(file) { return fs.existsSync(file); },
                    resolveActiveDraft() { return activeDraft; },
                    draftFileFor(root, sid) {
                        return path.join(root, '.jonggrang', '.drafts', sid, 'plan.md');
                    },
                    readJSON() { return {}; },
                },
                orchestration: { listManifests() { return []; } },
                compaction: {},
                paths: { configFile: path.join(projectRoot, '.jonggrang', 'jonggrang.json') },
            };

            const cleanup = register(app, io, ctx);
            const featuresDir = path.join(projectRoot, '.jonggrang', '.output', 'features');
            const draftsDir = path.join(projectRoot, '.jonggrang', '.drafts');

            assert.equal(fs.existsSync(featuresDir), true);
            assert.equal(fs.existsSync(draftsDir), true);

            const featureWatcher = watchers.find(watcher => watcher.target === featuresDir);
            const draftWatcher = watchers.find(watcher => watcher.target === draftsDir);
            assert.ok(featureWatcher, 'features watcher should be registered even in a fresh repo');
            assert.ok(draftWatcher, 'drafts watcher should be registered even in a fresh repo');

            const progressFile = path.join(featuresDir, 'feature-1', 'progress.txt');
            fs.mkdirSync(path.dirname(progressFile), { recursive: true });
            fs.writeFileSync(progressFile, 'phase 1 done');
            featureWatcher.handlers.all('add', progressFile);

            activeDraft = 'draft-1';
            const draftFile = path.join(draftsDir, activeDraft, 'plan.md');
            fs.mkdirSync(path.dirname(draftFile), { recursive: true });
            fs.writeFileSync(draftFile, '# Draft plan');
            draftWatcher.handlers.all('add', draftFile);

            assert.ok(events.some(entry => entry.event === 'tasks_update' && entry.payload.tasks[0].id === 'T1'));
            assert.ok(events.some(entry => entry.event === 'progress_update' && entry.payload === 'phase 1 done'));
            assert.ok(events.some(entry => entry.event === 'plan_update'
                && entry.payload.exists === true
                && entry.payload.sessionId === activeDraft
                && entry.payload.content === '# Draft plan'));

            cleanup();
            assert.equal(watchers.every(watcher => watcher.closed), true);
        });
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});
