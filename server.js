const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { spawn } = require('child_process');
const lib = require('./lib/jonggrang');

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
function spawnJonggrang(args, env = {}) {
    const nodeCli = path.join(__dirname, 'bin', 'jonggrang.js');
    return spawn('node', [nodeCli, ...args], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, JONGGRANG_HOME, JONGGRANG_PROJECT_ROOT: PROJECT_ROOT, ...env }
    });
}

// ============================================================
// API Routes
// ============================================================

// --- Status / Info ---
app.get('/api/jonggrang/status', (req, res) => {
    res.json({
        isRunning: isJonggrangRunning,
        projectRoot: PROJECT_ROOT,
        config: latestConfig,
        tasks: latestTasks,
        progress: latestProgress,
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Jonggrang dashboard on http://localhost:${PORT}`);
    console.log(`Project root: ${PROJECT_ROOT}`);
});
