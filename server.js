const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { spawn, execSync } = require('child_process');
const lib = require('./lib/jonggrang');
const orchestration = require('./lib/orchestration');
const compaction = require('./lib/compaction');
const feedback = require('./lib/feedback');
const webState = require('./lib/web-state');
const webRunners = require('./lib/web-runners');

const app = express();
const server = http.createServer(app);

//  ── TRUSTED ORIGINS ───────────────────────────────────────
const TRUSTED_ORIGINS = ['localhost', '127.0.0.1', '::1', '.local'];
function isOriginTrusted(origin) {
    if (!origin) return true; // same-origin requests
    try {
        const host = new URL(origin).hostname;
        return TRUSTED_ORIGINS.some(t =>
            t.startsWith('.') ? host.endsWith(t) || host === t.slice(1) : host === t
        );
    } catch { return false; }
}

const io = new Server(server, {
    cors: {
        origin: (origin, cb) => cb(null, isOriginTrusted(origin)),
        methods: ['GET', 'POST']
    }
});

app.use(cors({ origin: (origin, cb) => cb(null, isOriginTrusted(origin)) }));
app.use(express.json({ limit: '1mb' }));  // prevent oversized JSON body attacks

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

// Watch plan.md — emit plan_update so the UI can show the draft
function emitPlanUpdate() {
    try {
        if (lib.fileExists(paths.planFile)) {
            const content = fs.readFileSync(paths.planFile, 'utf8');
            io.emit('plan_update', { exists: true, content });
        } else {
            io.emit('plan_update', { exists: false, content: '' });
        }
    } catch { /* ignore */ }
}
chokidar.watch(paths.planFile, { ignoreInitial: false }).on('all', emitPlanUpdate);

// Watch manifests directory for real-time phase grid updates.
// Watch the .jonggrang dir (which exists or will be created) so chokidar
// can detect when the nested features/ subdirectory appears.
const jonggrangDir = path.join(PROJECT_ROOT, '.jonggrang');
fs.mkdirSync(jonggrangDir, { recursive: true });
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
    } catch (err) { /* ignore */ }
}
chokidar.watch(jonggrangDir, { ignoreInitial: true, depth: 4 })
    .on('add', emitManifestsUpdate)
    .on('change', emitManifestsUpdate);

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.emit('tasks_update', latestTasks);
    socket.emit('progress_update', latestProgress);
    socket.emit('config_update', latestConfig);
    emitPlanUpdate(); // send current plan.md state on connect
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
        env: { ...process.env, JONGGRANG_HOME, JONGGRANG_PROJECT_ROOT: PROJECT_ROOT, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
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

    const { taskId, mode, tool, description } = req.body || {};
    const args = ['work'];
    if (description) args.push(description);   // one-shot: plan + execute
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

// --- Plan (Phase 1: generate draft plan.md) ---
app.post('/api/jonggrang/plan', (req, res) => {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'description required' });

    // Phase 1 only — generates plan.md, does NOT produce tasks yet
    const args = ['plan', description];
    console.log('Starting jonggrang plan (Phase 1)...', args);

    const child = spawnJonggrang(args, { JONGGRANG_MODE: 'autonomous' });

    io.emit('log', `Planning: ${description}\n`);

    child.stdout.on('data', (data) => io.emit('log', data.toString()));
    child.stderr.on('data', (data) => io.emit('log', data.toString()));
    child.on('close', (code) => {
        io.emit('log', `\nPlan phase 1 exited with code ${code}\n`);
        // Emit current plan.md state so UI can show it
        emitPlanUpdate();
    });

    res.json({ success: true, message: 'Plan Phase 1 started' });
});

// --- Get current plan.md content ---
app.get('/api/jonggrang/plan/content', (req, res) => {
    if (!lib.fileExists(paths.planFile)) {
        return res.json({ exists: false, content: '' });
    }
    try {
        const content = fs.readFileSync(paths.planFile, 'utf8');
        res.json({ exists: true, content });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Save edited plan.md from UI ---
app.put('/api/jonggrang/plan/content', (req, res) => {
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: 'content required' });
    try {
        fs.writeFileSync(paths.planFile, content, 'utf8');
        emitPlanUpdate();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Discard pending plan.md ---
app.delete('/api/jonggrang/plan/content', (req, res) => {
    try {
        if (lib.fileExists(paths.planFile)) fs.unlinkSync(paths.planFile);
        emitPlanUpdate();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Approve (Phase 2: plan.md → tasks) ---
app.post('/api/jonggrang/approve', (req, res) => {
    if (!lib.fileExists(paths.planFile)) {
        return res.status(400).json({ error: 'No pending plan.md found. Run plan first.' });
    }

    const args = ['approve'];
    console.log('Starting jonggrang approve (Phase 2)...');

    const child = spawnJonggrang(args, { JONGGRANG_MODE: 'autonomous' });

    io.emit('log', 'Approving plan — decomposing to tasks...\n');

    child.stdout.on('data', (data) => io.emit('log', data.toString()));
    child.stderr.on('data', (data) => io.emit('log', data.toString()));
    child.on('close', (code) => {
        io.emit('log', `\nApprove phase 2 exited with code ${code}\n`);
        emitPlanUpdate(); // plan.md deleted after approve — emit empty state
    });

    res.json({ success: true, message: 'Approve started' });
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
            '.jonggrang',           // jonggrang.json, jonggrang-tasks.json, progress.txt
            'AGENTS.md', 'CLAUDE.md', 'opencode.json',
            '.claude', '.opencode',
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

// ── Input sanitisation helper ──────────────────────────────
function sanitizeGitRef(ref) {
    // Allow: alphanumeric, /, -, ., _ (common git ref characters)
    return String(ref).replace(/[^a-zA-Z0-9/\-._]/g, '').slice(0, 255);
}

app.get('/api/jonggrang/groups/:id/diff', (req, res) => {
    const group = groupProcesses.get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found', diff: '', files: [] });

    try {
        const base = sanitizeGitRef(group.baseSha || 'HEAD');
        const branch = sanitizeGitRef(group.branch);
        const diff = execSync(
            `git diff ${base}...${branch}`,
            { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 15000 }
        );
        const files = execSync(
            `git diff ${base}...${branch} --name-only`,
            { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15000 }
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
        io.emit('log', { stream: 'stdout', data: line });
    });
    child.stderr.on('data', (d) => io.emit('log', { stream: 'stderr', data: d.toString() }));
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
        // Sanitise featureId to prevent path traversal
        const featureId = req.params.featureId.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 100);
        const manifestPath = orchestration.getManifestPath(PROJECT_ROOT, featureId);
        // Ensure manifestPath is within project root
        if (!manifestPath.startsWith(path.resolve(PROJECT_ROOT))) {
            return res.status(403).json({ error: 'Invalid feature ID' });
        }
        const manifest = orchestration.readManifest(manifestPath);
        if (!manifest) return res.status(404).json({ error: 'Manifest not found' });
        res.json({ featureId, manifest, manifestPath });
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

// ============================================================
// MULTI-PROJECT WEB WRAPPER
// ============================================================

// Per-project chokidar watchers: projectId -> Watcher
const projectWatchers = new Map();

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

            // Emit manifest update when a MANIFEST.yaml changes
            if (changedPath && changedPath.endsWith('MANIFEST.yaml')) {
                try {
                    const orchestration = require('./lib/orchestration');
                    const manifest = orchestration.readManifest(changedPath);
                    io.to(`project:${project.id}`).emit('manifest.updated', { project_id: project.id, manifest });
                } catch {}
            }
        } catch {}
    };

    watcher.on('add', emit).on('change', emit).on('unlink', emit);
    projectWatchers.set(project.id, watcher);
}

function stopProjectWatcher(projectId) {
    const w = projectWatchers.get(projectId);
    if (w) { w.close(); projectWatchers.delete(projectId); }
}

// Helper: spawn jonggrang for a specific project
function spawnForProject(project, args, extraEnv = {}) {
    const nodeCli = path.join(__dirname, 'bin', 'jonggrang.js');
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

// Helper: wire subprocess logs to socket.io room
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
        // Emit derived state after process exits
        try {
            const project = webState.getProject(projectId);
            if (project) {
                const state = webState.deriveState(project.path);
                io.to(`project:${projectId}`).emit('state', { project_id: projectId, state });
            }
        } catch {}
    });
}

// Socket.io: project subscription (rooms)
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
                tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')).tasks || [];
            }
            let planContent = null;
            let planMtime = null;
            if (fs.existsSync(planPath)) {
                planContent = fs.readFileSync(planPath, 'utf-8');
                planMtime = fs.statSync(planPath).mtimeMs;
            }
            socket.emit('subscribed', {
                project_id,
                snapshot: { state, tasks, plan_exists: !!planContent, plan_content: planContent, plan_mtime: planMtime },
            });
        } catch (err) {
            socket.emit('error', { code: 'SUBSCRIBE_ERROR', message: err.message });
        }
    });

    socket.on('unsubscribe', ({ project_id }) => {
        if (project_id) socket.leave(`project:${project_id}`);
    });
});

// Start watchers for all existing ready projects
for (const project of webState.listProjects()) {
    if (project.init_status === 'ready' || project.init_status === 'imported') {
        startProjectWatcher(project);
    }
}

// ── WORKSPACE ─────────────────────────────────────────────────
app.get('/api/workspace', (req, res) => {
    try {
        const workspace_path = webState.getWorkspacePath();
        const projects = webState.listProjects();
        res.json({ path: workspace_path, project_count: projects.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/workspace', (req, res) => {
    const { path: newPath } = req.body || {};
    if (!newPath) return res.status(400).json({ error: 'path required' });
    try {
        const resolved = webState.setWorkspacePath(newPath);
        res.json({ path: resolved });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PROJECTS: LIST + DETAIL ───────────────────────────────────
app.get('/api/projects', (req, res) => {
    try {
        const projects = webState.listProjects().map(p => ({
            ...p,
            derived_state: webState.deriveState(p.path),
        }));
        res.json({ projects });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/projects/:id', (req, res) => {
    try {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
        res.json({ ...project, derived_state: webState.deriveState(project.path) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PROJECTS: IMPORT ─────────────────────────────────────────
app.post('/api/projects/import', async (req, res) => {
    const { name, source } = req.body || {};
    if (!name || !source) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and source required' } });
    if (!['git', 'local', 'fresh'].includes(source.type)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'source.type must be git|local|fresh' } });
    }

    const workspacePath = webState.getWorkspacePath();
    try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}

    // Name collision check
    const existing = webState.listProjects().find(p => p.name === name);
    if (existing) return res.status(409).json({ error: { code: 'NAME_COLLISION', message: `Project "${name}" already exists` } });

    const id = webState.generateId('proj');
    const targetPath = source.type === 'local' && source.link_mode === 'reference'
        ? path.resolve(source.path)
        : path.join(workspacePath, name);

    const record = {
        id,
        name,
        path: targetPath,
        source,
        init_status: 'importing',
        lanes: { main: { id: 'main', path: targetPath, branch: 'main', is_main: true } },
        created_at: new Date().toISOString(),
        last_opened_at: new Date().toISOString(),
    };
    webState.createProject(record);

    res.status(202).json({ id, job_id: id });

    // Async import
    setImmediate(async () => {
        try {
            io.to(`project:${id}`).emit('import.progress', { project_id: id, phase: 'prepare', message: 'Preparing project...' });

            if (source.type === 'git') {
                const gitArgs = ['clone', '--progress', source.url, targetPath];
                if (source.ref) gitArgs.push('--branch', source.ref);
                const child = spawn('git', gitArgs, {
                    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
                await new Promise((resolve, reject) => {
                    child.stderr.on('data', d => {
                        const msg = d.toString().trim();
                        io.to(`project:${id}`).emit('import.progress', { project_id: id, phase: 'clone', message: msg });
                    });
                    child.on('close', code => code === 0 ? resolve() : reject(new Error(`git clone failed (${code})`)));
                });
            } else if (source.type === 'fresh') {
                fs.mkdirSync(targetPath, { recursive: true });
                if (source.git_init !== false) {
                    await new Promise((res2, rej) => {
                        const g = spawn('git', ['init'], { cwd: targetPath, stdio: 'pipe' });
                        g.on('close', c => c === 0 ? res2() : rej(new Error('git init failed')));
                    });
                }
            }
            // local reference: targetPath already exists, nothing to do

            const detected = webState.detectStack(targetPath);
            webState.updateProject(id, { init_status: 'imported' });
            io.to(`project:${id}`).emit('import.done', { project_id: id, detected });
            startProjectWatcher(webState.getProject(id));
        } catch (err) {
            webState.updateProject(id, { init_status: 'error', init_error: err.message });
            io.to(`project:${id}`).emit('import.error', { project_id: id, message: err.message });
        }
    });
});

// ── PROJECTS: INIT ────────────────────────────────────────────
app.post('/api/projects/:id/init', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
    if (!['imported', 'error'].includes(project.init_status)) {
        return res.status(409).json({ error: { code: 'ALREADY_INITIALIZED', message: 'Project not in importable state' } });
    }

    const { type = 'api', stack = 'node-typescript', tool = 'claude', autonomy = 'autonomous' } = req.body || {};
    const initArgs = [
        'init', '--force',
        '--name', project.name,
        '--type', type,
        '--stack', stack,
        '--tool', tool,
        '--autonomy', autonomy,
        '--state', fs.existsSync(path.join(project.path, '.git')) ? 'existing' : 'new',
    ];

    webState.updateProject(project.id, { init_status: 'initializing' });
    res.status(202).json({ job_id: project.id });

    const child = spawnForProject(project, initArgs);
    wireProjectProcess(project.id, child, 'init');
    child.on('close', (code) => {
        if (code === 0) {
            webState.updateProject(project.id, { init_status: 'ready' });
            io.to(`project:${project.id}`).emit('init.done', { project_id: project.id });
            startProjectWatcher(webState.getProject(project.id));
        } else {
            webState.updateProject(project.id, { init_status: 'error', init_error: `Exit code ${code}` });
        }
    });
});

// ── PROJECTS: DELETE ──────────────────────────────────────────
app.delete('/api/projects/:id', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    stopProjectWatcher(project.id);
    webState.deleteProject(project.id);

    if (req.query.delete_files === 'true') {
        try { fs.rmSync(project.path, { recursive: true, force: true }); } catch {}
    }
    res.status(204).send();
});

// ── PLAN ──────────────────────────────────────────────────────
app.get('/api/projects/:id/plan', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    // 1. Active draft plan
    const planPath = path.join(project.path, '.jonggrang', 'plan.md');
    if (fs.existsSync(planPath)) {
        try {
            const content = fs.readFileSync(planPath, 'utf-8');
            const mtime = fs.statSync(planPath).mtimeMs;
            return res.json({ exists: true, state: 'draft', content, mtime });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // 2. Archived plan from latest feature output dir
    try {
        const featuresDir = path.join(project.path, '.jonggrang', '.output', 'features');
        if (!fs.existsSync(featuresDir)) return res.json({ exists: false });

        const featureDirs = fs.readdirSync(featuresDir)
            .map(name => ({ name, mtime: fs.statSync(path.join(featuresDir, name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

        for (const { name } of featureDirs) {
            const archivedPlan = path.join(featuresDir, name, 'plan.md');
            if (fs.existsSync(archivedPlan)) {
                const content = fs.readFileSync(archivedPlan, 'utf-8');
                const mtime = fs.statSync(archivedPlan).mtimeMs;

                // Try to read MANIFEST for work_type / status
                let manifest = null;
                try {
                    const orchestration = require('./lib/orchestration');
                    const mPath = path.join(featuresDir, name, 'MANIFEST.yaml');
                    if (fs.existsSync(mPath)) manifest = orchestration.readManifest(mPath);
                } catch {}

                return res.json({
                    exists: true,
                    state: manifest?.status === 'done' ? 'archived_done' : 'archived',
                    content,
                    mtime,
                    feature_id: name,
                    work_type: manifest?.work_type || null,
                    manifest_status: manifest?.status || null,
                });
            }
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    res.json({ exists: false });
});

app.post('/api/projects/:id/plan', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    const { description, deep } = req.body || {};
    if (!description) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'description required' } });

    const args = ['plan', description, ...(deep ? ['--deep'] : [])];
    const child = spawnForProject(project, args);
    wireProjectProcess(project.id, child, 'plan');
    res.status(202).json({ job_id: project.id });
});

app.put('/api/projects/:id/plan', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    const { content, mtime } = req.body || {};
    if (content === undefined) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'content required' } });

    const planPath = path.join(project.path, '.jonggrang', 'plan.md');

    // Optimistic concurrency: check mtime if provided
    if (mtime && fs.existsSync(planPath)) {
        const currentMtime = fs.statSync(planPath).mtimeMs;
        if (Math.abs(currentMtime - mtime) > 1000) {
            return res.status(409).json({ error: { code: 'PLAN_MTIME_MISMATCH', message: 'Plan was modified externally' } });
        }
    }

    try {
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(planPath, content, 'utf-8');
        const newMtime = fs.statSync(planPath).mtimeMs;
        res.json({ mtime: newMtime });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/projects/:id/plan', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    const planPath = path.join(project.path, '.jonggrang', 'plan.md');
    try {
        if (fs.existsSync(planPath)) fs.unlinkSync(planPath);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── MANIFEST ──────────────────────────────────────────────────
app.get('/api/projects/:id/manifest', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    try {
        const orchestration = require('./lib/orchestration');
        const featuresDir = path.join(project.path, '.jonggrang', '.output', 'features');
        if (!fs.existsSync(featuresDir)) return res.status(404).json({ error: { code: 'NO_MANIFEST', message: 'No manifest found' } });

        const featureDirs = fs.readdirSync(featuresDir)
            .map(name => ({ name, mtime: fs.statSync(path.join(featuresDir, name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

        for (const { name } of featureDirs) {
            const mPath = path.join(featuresDir, name, 'MANIFEST.yaml');
            if (fs.existsSync(mPath)) {
                const manifest = orchestration.readManifest(mPath);
                return res.json(manifest);
            }
        }
        res.status(404).json({ error: { code: 'NO_MANIFEST', message: 'No manifest found' } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── APPROVE ───────────────────────────────────────────────────
app.post('/api/projects/:id/approve', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    const planPath = path.join(project.path, '.jonggrang', 'plan.md');
    if (!fs.existsSync(planPath)) {
        return res.status(422).json({ error: { code: 'PLAN_NOT_FOUND', message: 'No plan.md found. Generate a plan first.' } });
    }

    const child = spawnForProject(project, ['approve']);
    wireProjectProcess(project.id, child, 'approve');
    res.status(202).json({ job_id: project.id });
});

// ── TASKS ─────────────────────────────────────────────────────
app.get('/api/projects/:id/tasks', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    const tasksPath = path.join(project.path, '.jonggrang', 'jonggrang-tasks.json');
    if (!fs.existsSync(tasksPath)) return res.json({ tasks: [] });
    try {
        const data = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
        res.json({ tasks: data.tasks || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── WORK ──────────────────────────────────────────────────────
const activeWork = new Map(); // projectId -> child process

app.post('/api/projects/:id/work', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

    if (activeWork.has(project.id)) {
        return res.status(409).json({ error: { code: 'PROCESS_ALREADY_RUNNING', message: 'A work process is already running' } });
    }

    const { task_id } = req.body || {};
    const args = ['work', ...(task_id ? ['--task', task_id] : [])];
    const child = spawnForProject(project, args);
    activeWork.set(project.id, child);

    wireProjectProcess(project.id, child, 'work');

    child.on('close', () => activeWork.delete(project.id));
    res.status(202).json({ job_id: project.id });
});

app.post('/api/projects/:id/cancel', (req, res) => {
    const child = activeWork.get(req.params.id);
    if (!child) return res.json({ cancelled: false, message: 'No process running' });
    try {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
        res.json({ cancelled: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/projects/:id/process', (req, res) => {
    const child = activeWork.get(req.params.id);
    res.json({ running: !!child, pid: child?.pid || null });
});

// ── LOGS ──────────────────────────────────────────────────────
app.get('/api/projects/:id/progress', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
    const progressPath = path.join(project.path, '.jonggrang', 'progress.txt');
    if (!fs.existsSync(progressPath)) return res.json({ content: '' });
    try {
        res.json({ content: fs.readFileSync(progressPath, 'utf-8') });
    } catch {
        res.json({ content: '' });
    }
});

// Serve frontend build files
const distPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(distPath));

// ── Global API error handler ───────────────────────────────
app.use('/api', (err, req, res, _next) => {
    console.error(`[jonggrang:api:error] ${req.method} ${req.path}:`, err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Fallback for SPA routing requests (only non-API routes)
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    if (fs.existsSync(path.join(distPath, 'index.html'))) {
        res.sendFile(path.join(distPath, 'index.html'));
    } else {
        // Auto-trigger build if dist is missing (informative but non-blocking)
        console.error('[jonggrang] Frontend build missing. Run: npm run build');
        res.status(503).type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Jonggrang — Build Required</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#05060a;color:#f4f4f5;}</style></head>
<body><div style="text-align:center;max-width:480px">
<h1>🎭 Jonggrang</h1>
<p style="color:#9ca3af">Frontend build files missing.</p>
<pre style="background:#16171f;padding:12px;border-radius:8px;color:#38bdf8;font-size:13px">npm run build</pre>
<p style="color:#4b5563;font-size:13px">Then restart with <code style="color:#10b981">npm start</code></p>
</div></body></html>`);
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
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        throw new Error(`Invalid PORT environment variable: ${portEnv}`);
    }
    envPort = parsedPort;
}

// ── Global error handlers ──────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('[jonggrang:uncaught]', err.message);
    // Don't exit — let the server keep running for dashboard use
});
process.on('unhandledRejection', (reason) => {
    console.error('[jonggrang:unhandledRejection]', reason);
});

// ── Cleanup orphaned child processes on exit ───────────────
function cleanupAllProcesses() {
    if (jonggrangProcess && !jonggrangProcess.killed) {
        try { jonggrangProcess.kill('SIGKILL'); } catch {}
    }
    for (const [, group] of groupProcesses) {
        if (group.process && !group.process.killed) {
            try { group.process.kill('SIGKILL'); } catch {}
        }
    }
}
process.on('SIGINT', () => { cleanupAllProcesses(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAllProcesses(); process.exit(0); });

// ── Rate limiter (simple in-memory, per-IP) ────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000;   // 1 minute
const RATE_LIMIT_MAX = 200;          // max requests per minute
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_LIMIT_WINDOW; }
    entry.count++;
    rateLimitMap.set(ip, entry);
    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }
    next();
});
// Clear stale rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
}, 300_000).unref();

(async () => {
    try {
        const PORT = envPort !== null ? envPort : await findAvailablePort(7777, 7999);
        server.listen(PORT, () => {
            console.log(`Jonggrang dashboard on http://localhost:${PORT}`);
            console.log(`Project root: ${PROJECT_ROOT}`);
        });
    } catch (err) {
        console.error(`[jonggrang] Failed to start server: ${err.message}`);
        process.exit(1);
    }
})();
