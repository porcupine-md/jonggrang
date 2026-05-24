'use strict';

module.exports = function register(app, io, ctx) {
    const { PROJECT_ROOT, JONGGRANG_HOME, lib, orchestration, compaction, feedback, paths } = ctx;

    const fs = require('fs');
    const path = require('path');
    const chokidar = require('chokidar');
    const { spawn } = require('child_process');

    // ── Mutable state object (passed by reference to sub-routers) ───
    const state = {
        latestTasks: { tasks: [] },
        latestProgress: '',
        latestConfig: null,
        jonggrangProcess: null,
        isJonggrangRunning: false,
    };
    const groupProcesses = new Map();

    // ── Helpers ──────────────────────────────────────────────────

    function spawnJonggrang(args, env = {}, cwd = PROJECT_ROOT) {
        const nodeCli = path.join(__dirname, '..', '..', 'bin', 'jonggrang.js');
        return spawn('node', [nodeCli, ...args], {
            cwd: cwd || PROJECT_ROOT,
            env: { ...process.env, JONGGRANG_HOME, JONGGRANG_PROJECT_ROOT: PROJECT_ROOT, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }

    function stopGroupProcess(group) {
        const child = group && group.process;
        if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 5000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            child.once('error', () => { clearTimeout(timer); resolve(); });
            try { child.kill('SIGINT'); } catch { clearTimeout(timer); resolve(); }
        });
    }

    function readTasks() {
        try {
            if (lib.fileExists(paths.tasksFile)) {
                const data = lib.readJSON(paths.tasksFile);
                if (data) { state.latestTasks = data; io.emit('tasks_update', state.latestTasks); }
            }
        } catch (err) { console.error('Error reading tasks:', err); }
    }

    function readProgress() {
        try {
            if (lib.fileExists(paths.progressFile)) {
                state.latestProgress = fs.readFileSync(paths.progressFile, 'utf8');
                io.emit('progress_update', state.latestProgress);
            }
        } catch (err) { console.error('Error reading progress:', err); }
    }

    function readConfigFile() {
        try {
            if (lib.fileExists(paths.configFile)) {
                state.latestConfig = lib.readJSON(paths.configFile);
                io.emit('config_update', state.latestConfig);
            }
        } catch (err) { console.error('Error reading config:', err); }
    }

    function emitPlanUpdate() {
        try {
            if (lib.fileExists(paths.planFile)) {
                const content = fs.readFileSync(paths.planFile, 'utf8');
                io.emit('plan_update', { exists: true, content });
            } else {
                io.emit('plan_update', { exists: false, content: '' });
            }
        } catch {}
    }

    function emitManifestsUpdate() {
        try {
            const manifests = orchestration.listManifests(PROJECT_ROOT);
            io.emit('manifests_update', manifests.map(({ featureId, manifest }) => ({
                featureId,
                description: manifest.description,
                workType: manifest.work_type,
                status: manifest.status,
                currentPhase: manifest.current_phase,
                activePhases: manifest.active_phases,
                phases: manifest.phases,
                validation: manifest.validation,
                progress: {
                    completed: manifest.active_phases.filter(n => manifest.phases[n]?.status === 'completed').length,
                    total: manifest.active_phases.length,
                },
                createdAt: manifest.created_at,
                updatedAt: manifest.updated_at,
            })));
        } catch {}
    }

    // ── Watchers ─────────────────────────────────────────────────

    readTasks(); readProgress(); readConfigFile();
    chokidar.watch(paths.tasksFile, { ignoreInitial: true }).on('all', () => readTasks());
    chokidar.watch(paths.progressFile, { ignoreInitial: true }).on('all', () => readProgress());
    chokidar.watch(paths.configFile, { ignoreInitial: true }).on('all', () => readConfigFile());
    chokidar.watch(paths.planFile, { ignoreInitial: false }).on('all', emitPlanUpdate);
    const jonggrangDir = path.join(PROJECT_ROOT, '.jonggrang');
    fs.mkdirSync(jonggrangDir, { recursive: true });
    chokidar.watch(jonggrangDir, { ignoreInitial: true, depth: 4 })
        .on('add', emitManifestsUpdate)
        .on('change', emitManifestsUpdate);

    // ── Legacy socket connection ──────────────────────────────────

    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);
        socket.emit('tasks_update', state.latestTasks);
        socket.emit('progress_update', state.latestProgress);
        socket.emit('config_update', state.latestConfig);
        emitPlanUpdate();
        socket.emit('jonggrang_status', { isRunning: state.isJonggrangRunning });
        socket.on('disconnect', () => { console.log('Client disconnected:', socket.id); });
    });

    // ── Build deps object ─────────────────────────────────────────

    const deps = {
        io,
        PROJECT_ROOT,
        JONGGRANG_HOME,
        lib,
        orchestration,
        compaction,
        feedback,
        paths,
        state,
        groupProcesses,
        spawnJonggrang,
        stopGroupProcess,
        emitPlanUpdate,
        emitManifestsUpdate,
    };

    // ── Mount sub-routers ─────────────────────────────────────────

    app.use('/api/jonggrang', require('./status')(deps));
    app.use('/api/jonggrang', require('./tasks')(deps));
    app.use('/api/jonggrang', require('./work')(deps));
    app.use('/api/jonggrang', require('./plan')(deps));
    app.use('/api/jonggrang', require('./approve')(deps));
    app.use('/api/jonggrang', require('./review')(deps));
    app.use('/api/jonggrang', require('./parallel')(deps));
    app.use('/api/jonggrang', require('./admin')(deps));
    app.use('/api/jonggrang', require('./orchestrate')(deps));
    app.use('/api/jonggrang', require('./compaction')(deps));
    app.use('/api/jonggrang', require('./feedback')(deps));

    // ── Cleanup ───────────────────────────────────────────────────

    return function cleanup() {
        if (state.jonggrangProcess && !state.jonggrangProcess.killed) {
            try { state.jonggrangProcess.kill('SIGKILL'); } catch {}
        }
        for (const [, group] of groupProcesses) {
            if (group.process && !group.process.killed) {
                try { group.process.kill('SIGKILL'); } catch {}
            }
        }
    };
};
