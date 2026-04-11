const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { spawn } = require('child_process');
const lib = require('./lib/jonggrang');
const orchestration = require('./lib/orchestration');
const compaction = require('./lib/compaction');
const feedback = require('./lib/feedback');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(express.json());

// Jonggrang files
const PROJECT_ROOT = process.env.JONGGRANG_PROJECT_ROOT || path.resolve(__dirname, '..');

function resolveJonggrangHome() {
    if (process.env.JONGGRANG_HOME) return process.env.JONGGRANG_HOME;

    const candidates = [
        __dirname,
        path.resolve(__dirname, '..')
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'templates', 'AGENTS.md.template'))) {
            return candidate;
        }
    }

    return __dirname;
}

const JONGGRANG_HOME = resolveJonggrangHome();
const paths = lib.getProjectPaths(PROJECT_ROOT);

// State
let latestTasks = { tasks: [] };
let latestProgress = '';
let latestConfig = null;
let jonggrangProcess = null;
let isJonggrangRunning = false;

// Parallel state
const groupProcesses = new Map(); // groupId -> { process, branch, worktreePath, status, taskIds }

function readTasks() {
    try {
        if (lib.fileExists(paths.tasksFile)) {
            const data = lib.readJSON(paths.tasksFile);
            if (data) {
                latestTasks = data;
                io.emit('tasks_update', latestTasks);
            }
        }
    } catch (err) {
        console.error('Error reading tasks:', err);
    }
}

function readProgress() {
    try {
        if (lib.fileExists(paths.progressFile)) {
            const data = fs.readFileSync(paths.progressFile, 'utf8');
            latestProgress = data;
            io.emit('progress_update', latestProgress);
        }
    } catch (err) {
        console.error('Error reading progress:', err);
    }
}

function readConfigFile() {
    try {
        if (lib.fileExists(paths.configFile)) {
            latestConfig = lib.readJSON(paths.configFile);
            io.emit('config_update', latestConfig);
        }
    } catch (err) {
        console.error('Error reading config:', err);
    }
}

// Initial read
readTasks();
readProgress();
readConfigFile();

// Watchers
chokidar.watch(paths.tasksFile, { ignoreInitial: true }).on('all', () => readTasks());
chokidar.watch(paths.progressFile, { ignoreInitial: true }).on('all', () => readProgress());
chokidar.watch(paths.configFile, { ignoreInitial: true }).on('all', () => readConfigFile());

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.emit('tasks_update', latestTasks);
    socket.emit('progress_update', latestProgress);
    socket.emit('config_update', latestConfig);
    socket.emit('jonggrang_status', { isRunning: isJonggrangRunning });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Helper to spawn jonggrang CLI
function spawnJonggrang(args, env = {}, cwd = PROJECT_ROOT) {
    const nodeCli = path.join(__dirname, 'bin', 'jonggrang.js');
    return spawn('node', [nodeCli, ...args], {
        cwd,
        env: { ...process.env, JONGGRANG_HOME, JONGGRANG_PROJECT_ROOT: PROJECT_ROOT, ...env }
    });
}

// Stop a group process gracefully (SIGINT → SIGKILL after 5s)
function stopGroupProcess(group) {
    const child = group && group.process;
    if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve();
        }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.once('error', () => { clearTimeout(timer); resolve(); });
        try {
            child.kill('SIGINT');
        } catch {
            clearTimeout(timer);
            resolve();
        }
    });
}

// ============================================================
// API Routes
// ============================================================

// --- Status / Info ---
app.get('/api/jonggrang/status', (req, res) => {
    const groups = Array.from(groupProcesses.entries()).map(([id, g]) => ({
        id, status: g.status, branch: g.branch, taskIds: g.taskIds,
    }));
    res.json({
        isRunning: isJonggrangRunning,
        mode: groupProcesses.size > 0 ? 'parallel' : 'sequential',
        projectRoot: PROJECT_ROOT,
        config: latestConfig,
        tasks: latestTasks,
        progress: latestProgress,
        groups,
    });
});

app.get('/api/jonggrang/tasks', (req, res) => {
    const data = lib.getTasks(paths.tasksFile);
    res.json(data);
});

app.get('/api/jonggrang/tasks/:id', (req, res) => {
    const task = lib.getTask(paths.tasksFile, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
});

// --- Task mutations ---
app.patch('/api/jonggrang/tasks/:id', (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });

    if (status === 'completed') {
        lib.markTaskDone(paths.tasksFile, req.params.id);
    } else {
        lib.updateTaskStatus(paths.tasksFile, req.params.id, status);
    }
    res.json({ success: true });
});

app.post('/api/jonggrang/tasks', (req, res) => {
    const { title, description, priority, skill, blocked_by } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const data = lib.getTasks(paths.tasksFile);
    const maxId = data.tasks.reduce((max, t) => {
        const num = parseInt(t.id.replace('task-', ''), 10);
        return num > max ? num : max;
    }, 0);
    const newId = `task-${String(maxId + 1).padStart(3, '0')}`;

    data.tasks.push({
        id: newId,
        title,
        description: description || title,
        priority: priority || data.tasks.length + 1,
        status: 'pending',
        owner: null,
        skill: skill || null,
        skill_inputs: {},
        files: [],
        blocked_by: blocked_by || [],
        passes: false,
        retry_count: 0,
        started_at: null,
        completed_at: null,
        error_log: [],
    });
    lib.writeJSON(paths.tasksFile, data);
    res.json({ success: true, id: newId });
});

app.delete('/api/jonggrang/tasks/:id', (req, res) => {
    const data = lib.getTasks(paths.tasksFile);
    const idx = data.tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    if (data.tasks[idx].status === 'completed') {
        return res.status(400).json({ error: 'Cannot delete completed task' });
    }
    data.tasks.splice(idx, 1);
    lib.writeJSON(paths.tasksFile, data);
    res.json({ success: true });
});

// --- Work (start/stop) ---
app.post('/api/jonggrang/start', (req, res) => {
    if (isJonggrangRunning) {
        return res.status(400).json({ error: 'Jonggrang is already running' });
    }

    const { taskId, mode, tool } = req.body || {};
    const args = ['work'];
    if (taskId) args.push('--task', taskId);
    if (mode) args.push('--mode', mode);
    if (tool) args.push('--tool', tool);

    console.log('Starting jonggrang work...', args);
    jonggrangProcess = spawnJonggrang(args, { JONGGRANG_MODE: mode || 'autonomous' });

    isJonggrangRunning = true;
    io.emit('jonggrang_status', { isRunning: true });
    io.emit('log', 'Jonggrang started...\n');

    jonggrangProcess.stdout.on('data', (data) => {
        io.emit('log', data.toString());
    });

    jonggrangProcess.stderr.on('data', (data) => {
        io.emit('log', data.toString());
    });

    jonggrangProcess.on('close', (code) => {
        isJonggrangRunning = false;
        jonggrangProcess = null;
        io.emit('jonggrang_status', { isRunning: false });
        io.emit('log', `\nJonggrang process exited with code ${code}\n`);
    });

    res.json({ success: true, message: 'Jonggrang started' });
});

app.post('/api/jonggrang/stop', (req, res) => {
    if (!isJonggrangRunning || !jonggrangProcess) {
        return res.status(400).json({ error: 'Jonggrang is not running' });
    }

    console.log('Stopping jonggrang...');
    jonggrangProcess.kill('SIGINT');

    res.json({ success: true, message: 'Jonggrang stop signal sent' });
});

// --- Plan ---
app.post('/api/jonggrang/plan', (req, res) => {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'description required' });

    const args = ['plan', description];
    console.log('Starting jonggrang plan...', args);

    const child = spawnJonggrang(args, { JONGGRANG_MODE: 'autonomous' });

    io.emit('log', `Planning: ${description}\n`);

    child.stdout.on('data', (data) => io.emit('log', data.toString()));
    child.stderr.on('data', (data) => io.emit('log', data.toString()));
    child.on('close', (code) => {
        io.emit('log', `\nPlan process exited with code ${code}\n`);
    });

    res.json({ success: true, message: 'Plan started' });
});

// --- Review ---
app.post('/api/jonggrang/review', (req, res) => {
    const child = spawnJonggrang(['review'], { JONGGRANG_MODE: 'autonomous' });

    io.emit('log', 'Starting review...\n');

    child.stdout.on('data', (data) => io.emit('log', data.toString()));
    child.stderr.on('data', (data) => io.emit('log', data.toString()));
    child.on('close', (code) => {
        io.emit('log', `\nReview process exited with code ${code}\n`);
    });

    res.json({ success: true, message: 'Review started' });
});

// --- Parallel Work ---
app.post('/api/jonggrang/start-parallel', (req, res) => {
    if (isJonggrangRunning || groupProcesses.size > 0) {
        return res.status(400).json({ error: 'Already running' });
    }

    const groups = lib.getTaskGroups(paths.tasksFile);
    if (groups.length === 0) {
        return res.status(400).json({ error: 'No pending task groups' });
    }

    const tool = req.body?.tool || latestConfig?.tool || 'opencode';
    const baseBranch = 'HEAD';
    let completedGroups = 0;

    isJonggrangRunning = true;
    io.emit('jonggrang_status', { isRunning: true, mode: 'parallel', groups: groups.length });

    // Mark all tasks in all groups as waiting
    for (const group of groups) {
        for (const id of group.taskIds) {
            lib.updateTaskStatus(paths.tasksFile, id, 'waiting');
        }
    }

    for (const group of groups) {
        let wt;
        try {
            wt = lib.createWorktree(PROJECT_ROOT, group.id, baseBranch);
        } catch (err) {
            io.emit('log', `[${group.id}] Failed to create worktree: ${err.message}\n`);
            // Revert this group's tasks back to pending
            for (const id of group.taskIds) {
                lib.updateTaskStatus(paths.tasksFile, id, 'pending');
            }
            continue;
        }

        // Copy untracked files to worktree
        lib.copyToWorktree(PROJECT_ROOT, wt.worktreePath, [
            'jonggrang-tasks.json', 'AGENTS.md', 'progress.txt', 'jonggrang.json',
            'CLAUDE.md', 'SKILL.md', 'skills',
        ]);

        const child = spawnJonggrang(
            ['work', '--worktree', '--group-tasks', group.taskIds.join(','), '--tool', tool],
            { JONGGRANG_PROJECT_ROOT: wt.worktreePath, JONGGRANG_MODE: 'autonomous' },
            wt.worktreePath
        );

        const groupInfo = {
            process: child, branch: wt.branch, worktreePath: wt.worktreePath,
            baseSha: wt.baseSha, status: 'running', taskIds: group.taskIds,
        };
        groupProcesses.set(group.id, groupInfo);

        io.emit('log', `[${group.id}] Started in ${wt.worktreePath} (branch: ${wt.branch})\n`);
        io.emit('group_status', { groupId: group.id, status: 'running', branch: wt.branch, taskIds: group.taskIds });

        // Parse stdout: JSON signals vs log lines
        let buffer = '';
        child.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.type === 'task_status') {
                        lib.updateTaskStatus(paths.tasksFile, msg.taskId, msg.status);
                    }
                } catch {
                    io.emit('log', `[${group.id}] ${line}\n`);
                }
            }
        });

        child.stderr.on('data', (d) => io.emit('log', `[${group.id}] ${d.toString()}`));

        child.on('close', (code) => {
            groupInfo.status = code === 0 ? 'done' : 'failed';
            completedGroups++;
            io.emit('log', `[${group.id}] Exited with code ${code}\n`);

            // Mark group tasks as "review" so they appear in REVIEW column
            if (groupInfo.status === 'done') {
                for (const tid of group.taskIds) {
                    lib.updateTaskStatus(paths.tasksFile, tid, 'review');
                }
            }
            io.emit('group_status', { groupId: group.id, status: groupInfo.status });

            if (completedGroups >= groupProcesses.size) {
                isJonggrangRunning = false;
                io.emit('jonggrang_status', { isRunning: false, mode: 'idle' });
                io.emit('parallel_complete', {
                    groups: Array.from(groupProcesses.entries()).map(([id, g]) => ({
                        id, status: g.status, branch: g.branch, taskIds: g.taskIds,
                    })),
                });
            }
        });
    }

    res.json({
        success: true,
        groups: groups.map(g => ({ id: g.id, taskIds: g.taskIds })),
    });
});

app.get('/api/jonggrang/groups', (req, res) => {
    const groups = Array.from(groupProcesses.entries()).map(([id, g]) => ({
        id, branch: g.branch, worktreePath: g.worktreePath,
        status: g.status, taskIds: g.taskIds,
    }));
    res.json({ groups });
});

app.post('/api/jonggrang/groups/:id/review', (req, res) => {
    const group = groupProcesses.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    io.emit('log', `[review:${req.params.id}] Starting review...\n`);
    const child = spawnJonggrang(['review'], { JONGGRANG_PROJECT_ROOT: group.worktreePath, JONGGRANG_MODE: 'autonomous' });
    child.stdout.on('data', (d) => io.emit('log', `[review:${req.params.id}] ${d.toString()}`));
    child.stderr.on('data', (d) => io.emit('log', `[review:${req.params.id}] ${d.toString()}`));
    child.on('close', (code) => {
        io.emit('log', `[review:${req.params.id}] Review exited with code ${code}\n`);
        io.emit('group_review_complete', { groupId: req.params.id, code });
    });
    res.json({ success: true });
});

app.get('/api/jonggrang/groups/:id/diff', (req, res) => {
    const group = groupProcesses.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found', diff: '', files: [] });

    try {
        const base = group.baseSha || 'HEAD';
        const diff = require('child_process').execSync(
            `git diff ${base}...${group.branch}`,
            { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
        );
        const files = require('child_process').execSync(
            `git diff ${base}...${group.branch} --name-only`,
            { cwd: PROJECT_ROOT, encoding: 'utf8' }
        ).trim().split('\n').filter(Boolean);
        res.json({ diff, files });
    } catch (err) {
        res.json({ diff: '', files: [], error: err.message });
    }
});

app.post('/api/jonggrang/groups/:id/revise', (req, res) => {
    const group = groupProcesses.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const { feedback } = req.body;
    if (!feedback) return res.status(400).json({ error: 'feedback required' });

    isJonggrangRunning = true;
    io.emit('jonggrang_status', { isRunning: true, mode: 'revision' });
    io.emit('log', `[revise:${req.params.id}] Revising: ${feedback}\n`);

    const tool = latestConfig?.tool || 'opencode';
    const child = spawnJonggrang(
        ['work', '--worktree', '--group-tasks', group.taskIds.join(','), '--tool', tool],
        { JONGGRANG_PROJECT_ROOT: group.worktreePath, JONGGRANG_MODE: 'autonomous', JONGGRANG_REVISION_FEEDBACK: feedback },
        group.worktreePath
    );

    child.stdout.on('data', (d) => {
        const line = d.toString();
        try { JSON.parse(line); } catch { io.emit('log', `[revise:${req.params.id}] ${line}`); }
    });
    child.stderr.on('data', (d) => io.emit('log', `[revise:${req.params.id}] ${d.toString()}`));
    child.on('close', (code) => {
        isJonggrangRunning = false;
        io.emit('jonggrang_status', { isRunning: false, mode: 'idle' });
        io.emit('log', `[revise:${req.params.id}] Revision done (code: ${code})\n`);
    });

    res.json({ success: true });
});

app.post('/api/jonggrang/groups/:id/cancel', async (req, res) => {
    const group = groupProcesses.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    try {
        await stopGroupProcess(group);

        // Revert tasks to pending
        for (const tid of group.taskIds) {
            lib.updateTaskStatus(paths.tasksFile, tid, 'pending');
        }

        // Remove worktree and branch
        lib.removeWorktree(PROJECT_ROOT, group.worktreePath, group.branch);
        groupProcesses.delete(req.params.id);

        io.emit('group_status', { groupId: req.params.id, status: 'cancelled' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/jonggrang/groups/:id/merge', (req, res) => {
    const group = groupProcesses.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    try {
        lib.mergeWorktreeBranch(PROJECT_ROOT, group.branch);
        lib.removeWorktree(PROJECT_ROOT, group.worktreePath, group.branch);
        // Mark tasks as completed after successful merge
        for (const tid of group.taskIds) {
            lib.markTaskDone(paths.tasksFile, tid);
        }
        group.status = 'merged';
        groupProcesses.delete(req.params.id);
        io.emit('group_status', { groupId: req.params.id, status: 'merged' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/jonggrang/groups/merge-all', (req, res) => {
    const results = [];
    for (const [id, group] of groupProcesses) {
        if (group.status === 'merged') continue;
        try {
            lib.mergeWorktreeBranch(PROJECT_ROOT, group.branch);
            lib.removeWorktree(PROJECT_ROOT, group.worktreePath, group.branch);
            for (const tid of group.taskIds) {
                lib.markTaskDone(paths.tasksFile, tid);
            }
            group.status = 'merged';
            groupProcesses.delete(id);
            io.emit('group_status', { groupId: id, status: 'merged' });
            results.push({ id, status: 'merged' });
        } catch (err) {
            results.push({ id, status: 'error', error: err.message });
        }
    }
    res.json({ results });
});

app.post('/api/jonggrang/stop-parallel', async (req, res) => {
    const groupsToClear = [];
    for (const [id, group] of groupProcesses) {
        if (group.status === 'merged') continue;
        await stopGroupProcess(group);
        group.status = 'cancelled';
        io.emit('group_status', { groupId: id, status: 'cancelled' });
        groupsToClear.push(id);
    }
    for (const id of groupsToClear) {
        groupProcesses.delete(id);
    }
    lib.revertWaiting(paths.tasksFile);
    isJonggrangRunning = false;
    io.emit('jonggrang_status', { isRunning: false });
    res.json({ success: true });
});

app.post('/api/jonggrang/groups/cleanup', async (req, res) => {
    for (const [id, group] of groupProcesses) {
        if (group.status !== 'merged') {
            await stopGroupProcess(group);
            lib.removeWorktree(PROJECT_ROOT, group.worktreePath, group.branch);
        }
    }
    groupProcesses.clear();
    lib.revertWaiting(paths.tasksFile);
    isJonggrangRunning = false;
    io.emit('jonggrang_status', { isRunning: false });
    res.json({ success: true });
});

// --- Init ---
app.post('/api/jonggrang/init', (req, res) => {
    const options = req.body;
    try {
        const result = lib.runInit(options, JONGGRANG_HOME, PROJECT_ROOT);
        readConfigFile();
        readTasks();
        readProgress();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Config ---
app.get('/api/jonggrang/config', (req, res) => {
    if (latestConfig) {
        res.json(latestConfig);
    } else {
        res.status(404).json({ error: 'No config found' });
    }
});

// ============================================================
// ORCHESTRATION API
// ============================================================

// --- Orchestration: start new run ---
app.post('/api/jonggrang/orchestrate', async (req, res) => {
    const { description, workType, tool, mode } = req.body || {};
    if (!description) return res.status(400).json({ error: 'description required' });

    try {
        const detectedWorkType = workType || orchestration.classifyWorkType(description);
        const featureId = orchestration.generateFeatureId(description);
        const { manifest, manifestPath } = orchestration.createManifest(
            PROJECT_ROOT, featureId, description, detectedWorkType
        );

        // Spawn jonggrang orchestrate as a background process
        const child = spawn('node', [
            path.join(__dirname, 'bin', 'jonggrang.js'),
            'orchestrate', description,
            '--tool', tool || 'opencode',
            '--mode', mode || 'autonomous',
        ], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, JONGGRANG_PROJECT_ROOT: PROJECT_ROOT },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', d => io.emit('log', { stream: 'stdout', data: d.toString() }));
        child.stderr.on('data', d => io.emit('log', { stream: 'stderr', data: d.toString() }));
        child.on('close', code => {
            io.emit('orchestration_complete', { featureId, exitCode: code });
        });

        res.json({ featureId, manifestPath, workType: detectedWorkType, activePhases: manifest.active_phases });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Orchestration: resume ---
app.post('/api/jonggrang/orchestrate/resume', async (req, res) => {
    const { featureId } = req.body || {};
    try {
        const entry = featureId
            ? { featureId, manifest: orchestration.readManifest(orchestration.getManifestPath(PROJECT_ROOT, featureId)) }
            : orchestration.findIncompleteManifest(PROJECT_ROOT);

        if (!entry || !entry.manifest) {
            return res.status(404).json({ error: 'No incomplete orchestration found' });
        }

        const child = spawn('node', [
            path.join(__dirname, 'bin', 'jonggrang.js'),
            'orchestrate', '--resume',
        ], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, JONGGRANG_PROJECT_ROOT: PROJECT_ROOT },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', d => io.emit('log', { stream: 'stdout', data: d.toString() }));
        child.stderr.on('data', d => io.emit('log', { stream: 'stderr', data: d.toString() }));
        child.on('close', code => {
            io.emit('orchestration_complete', { featureId: entry.featureId, exitCode: code });
        });

        res.json({ featureId: entry.featureId, manifest: entry.manifest });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Orchestration: list all ---
app.get('/api/jonggrang/manifests', (req, res) => {
    try {
        const manifests = orchestration.listManifests(PROJECT_ROOT);
        res.json(manifests.map(({ featureId, manifest }) => ({
            featureId,
            description: manifest.description,
            workType: manifest.work_type,
            status: manifest.status,
            currentPhase: manifest.current_phase,
            activePhases: manifest.active_phases,
            progress: {
                completed: manifest.active_phases.filter(n => manifest.phases[n]?.status === 'completed').length,
                total: manifest.active_phases.length,
            },
            createdAt: manifest.created_at,
            updatedAt: manifest.updated_at,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Orchestration: get specific manifest ---
app.get('/api/jonggrang/manifests/:featureId', (req, res) => {
    try {
        const manifestPath = orchestration.getManifestPath(PROJECT_ROOT, req.params.featureId);
        const manifest = orchestration.readManifest(manifestPath);
        if (!manifest) return res.status(404).json({ error: 'Manifest not found' });
        res.json({ featureId: req.params.featureId, manifest, manifestPath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Compaction: get status ---
app.get('/api/jonggrang/compaction', (req, res) => {
    try {
        const state = compaction.refreshCompactionState(PROJECT_ROOT);
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Feedback loop: get state ---
app.get('/api/jonggrang/feedback-state', (req, res) => {
    try {
        const state = feedback.readFeedbackState(PROJECT_ROOT);
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Feedback loop: record phase result ---
app.post('/api/jonggrang/feedback-state/record', (req, res) => {
    const { domain, phase, status, agent } = req.body || {};
    if (!domain || !phase || !status) {
        return res.status(400).json({ error: 'domain, phase, status required' });
    }
    try {
        const { state, allPassed } = feedback.recordPhaseResult(PROJECT_ROOT, domain, phase, status, agent);
        res.json({ state, allPassed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Feedback loop: clear state ---
app.delete('/api/jonggrang/feedback-state', (req, res) => {
    try {
        feedback.clearFeedbackState(PROJECT_ROOT);
        res.json({ cleared: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve frontend build files
const distPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(distPath));

// Fallback for SPA routing requests
app.get('*', (req, res) => {
    if (fs.existsSync(path.join(distPath, 'index.html'))) {
        res.sendFile(path.join(distPath, 'index.html'));
    } else {
        res.status(404).send('Please run "npm run build" first to generate the frontend build files.');
    }
});

function findAvailablePort(start, end) {
    const net = require('net');
    return new Promise((resolve, reject) => {
        let port = start;
        function tryPort() {
            if (port > end) return reject(new Error(`No available port in ${start}-${end}`));
            const srv = net.createServer();
            srv.once('error', (err) => {
                if (err && err.code === 'EADDRINUSE') { port++; tryPort(); return; }
                reject(err);
            });
            srv.once('listening', () => { srv.close(() => resolve(port)); });
            srv.listen(port);
        }
        tryPort();
    });
}

const portEnv = process.env.PORT;
let envPort = null;
if (portEnv !== undefined) {
    const parsedPort = Number(portEnv);
    if (!Number.isFinite(parsedPort) || !Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        throw new Error(`Invalid PORT environment variable: ${portEnv}`);
    }
    envPort = parsedPort;
}
(async () => {
    const PORT = envPort !== null ? envPort : await findAvailablePort(7777, 7999);
    server.listen(PORT, () => {
        console.log(`Jonggrang dashboard on http://localhost:${PORT}`);
        console.log(`Project root: ${PROJECT_ROOT}`);
    });
})();
