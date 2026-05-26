'use strict';

module.exports = function register(app, io, ctx) {
    const { JONGGRANG_HOME, webState, orchestration } = ctx;

    const fs = require('fs');
    const path = require('path');
    const chokidar = require('chokidar');
    const { spawn } = require('child_process');

    // ── Local state ──────────────────────────────────────────────
    const projectWatchers = new Map();
    const activeWork = new Map();
    const lastActivity = new Map();

    // ── Helpers ──────────────────────────────────────────────────

    function spawnForProject(project, args, extraEnv = {}) {
        const nodeCli = path.join(__dirname, '..', '..', 'bin', 'jonggrang.js');
        return spawn('node', [nodeCli, ...args], {
            cwd: project.path,
            env: {
                ...process.env,
                JONGGRANG_HOME,
                JONGGRANG_PROJECT_ROOT: project.path,
                JONGGRANG_MODE: 'autonomous',
                NO_UPDATE_NOTIFIER: '1',
                FORCE_COLOR: '0',
                ...extraEnv,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }

    function wireProjectProcess(projectId, child, command) {
        io.to(`project:${projectId}`).emit('process.started', { project_id: projectId, command, pid: child.pid });
        let seq = 0;
        const logLine = (stream) => (data) => {
            const lines = data.toString().split(/\r?\n/).filter(l => l.trim());
            for (const line of lines) {
                io.to(`project:${projectId}`).emit('process.log', { project_id: projectId, stream, line, raw: line, seq: seq++ });
            }
        };
        child.stdout.on('data', logLine('stdout'));
        child.stderr.on('data', logLine('stderr'));
        child.on('close', (code, signal) => {
            io.to(`project:${projectId}`).emit('process.exited', { project_id: projectId, code, signal });
            try {
                const project = webState.getProject(projectId);
                if (project) {
                    const state = webState.deriveState(project.path);
                    io.to(`project:${projectId}`).emit('state', { project_id: projectId, state });
                }
            } catch (err) {
                console.error('deriveState error after process exit:', err);
            }
        });
    }

    function startProjectWatcher(project) {
        if (projectWatchers.has(project.id)) return;
        const jonggrangDir = path.join(project.path, '.jonggrang');
        try { fs.mkdirSync(jonggrangDir, { recursive: true }); } catch {}
        const watcher = chokidar.watch(jonggrangDir, { ignoreInitial: true, depth: 3 });

        const emit = (changedPath) => {
            try {
                const planPath = path.join(project.path, '.jonggrang', 'plan.md');
                const tasksPath = path.join(project.path, '.jonggrang', 'jonggrang-tasks.json');
                const state = webState.deriveState(project.path);
                io.to(`project:${project.id}`).emit('state', { project_id: project.id, state });
                if (fs.existsSync(planPath)) {
                    const content = fs.readFileSync(planPath, 'utf-8');
                    const mtime = fs.statSync(planPath).mtimeMs;
                    io.to(`project:${project.id}`).emit('plan.content', { project_id: project.id, content, mtime });
                } else {
                    io.to(`project:${project.id}`).emit('plan.deleted', { project_id: project.id });
                }
                if (fs.existsSync(tasksPath)) {
                    const data = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
                    io.to(`project:${project.id}`).emit('tasks.update', { project_id: project.id, tasks: data.tasks || [] });
                }
                if (changedPath && changedPath.endsWith('MANIFEST.yaml')) {
                    try {
                        const manifest = orchestration.readManifest(changedPath);
                        io.to(`project:${project.id}`).emit('manifest.updated', { project_id: project.id, manifest });
                    } catch (err) {
                        console.error('Manifest read error:', err);
                    }
                }
                if (changedPath && changedPath.endsWith('progress.txt')) {
                    try {
                        const content = fs.readFileSync(changedPath, 'utf-8');
                        io.to(`project:${project.id}`).emit('progress.update', { project_id: project.id, content });
                    } catch (err) {
                        console.error('Progress read error:', err);
                    }
                }
            } catch (err) {
                console.error('Project watcher emit error:', err);
            }
        };

        watcher.on('add', emit).on('change', emit).on('unlink', emit);
        projectWatchers.set(project.id, watcher);
    }

    function stopProjectWatcher(projectId) {
        const w = projectWatchers.get(projectId);
        if (w) { w.close(); projectWatchers.delete(projectId); }
    }

    // ── Socket subscription ───────────────────────────────────────

    io.on('connection', (socket) => {
        socket.on('subscribe', ({ project_id }) => {
            if (!project_id) return;
            socket.join(`project:${project_id}`);
            try {
                const project = webState.getProject(project_id);
                if (!project) return;
                const state = webState.deriveState(project.path);
                const tasksPath = path.join(project.path, '.jonggrang', 'jonggrang-tasks.json');
                const planPath = path.join(project.path, '.jonggrang', 'plan.md');
                let tasks = [];
                if (fs.existsSync(tasksPath)) {
                    try { tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')).tasks || []; } catch {}
                }
                let planContent = null;
                let planMtime = null;
                if (fs.existsSync(planPath)) {
                    planContent = fs.readFileSync(planPath, 'utf-8');
                    planMtime = fs.statSync(planPath).mtimeMs;
                }
                const running = activeWork.has(project_id);
                socket.emit('subscribed', {
                    project_id,
                    snapshot: {
                        state,
                        tasks,
                        plan_exists: !!planContent,
                        plan_content: planContent,
                        plan_mtime: planMtime,
                        process: running ? { command: 'work' } : null,
                    },
                });
                if (!projectWatchers.has(project_id)) startProjectWatcher(project);
            } catch (err) {
                socket.emit('error', { code: 'SUBSCRIBE_ERROR', message: err.message });
            }
        });
        socket.on('unsubscribe', ({ project_id }) => {
            if (project_id) socket.leave(`project:${project_id}`);
        });
    });

    // Start watchers for all existing ready/imported projects
    for (const project of webState.listProjects()) {
        if (project.init_status === 'ready' || project.init_status === 'imported') {
            startProjectWatcher(project);
        }
    }

    // ── Build deps object ─────────────────────────────────────────

    const deps = {
        io,
        JONGGRANG_HOME,
        webState,
        orchestration,
        fs,
        path,
        activeWork,
        lastActivity,
        projectWatchers,
        spawnForProject,
        wireProjectProcess,
        startProjectWatcher,
        stopProjectWatcher,
    };

    // ── Mount sub-routers ─────────────────────────────────────────

    app.use('/api', require('./workspace')(deps));
    app.use('/api', require('./projects')(deps));
    app.use('/api', require('../models')(deps));
    app.use('/api/projects', require('./init')(deps));
    app.use('/api/projects', require('./plan')(deps));
    app.use('/api/projects', require('./manifest')(deps));
    app.use('/api/projects', require('./approve')(deps));
    app.use('/api/projects', require('./tasks')(deps));
    app.use('/api/projects', require('./work')(deps));
    app.use('/api/projects', require('./pty')(deps));
    app.use('/api/projects', require('./sandbox-routes')(deps));
    app.use('/api', require('../secrets')(deps));
    app.use('/api/projects', require('./settings')(deps));

    // Idle sandbox auto-stop disabled — containers stopped manually only

    // ── Cleanup ───────────────────────────────────────────────────

    return function cleanup() {
        for (const [, child] of activeWork) {
            if (!child.killed) try { child.kill('SIGKILL'); } catch {}
        }
        for (const [, w] of projectWatchers) {
            try { w.close(); } catch {}
        }
    };
};
