'use strict';

const sandbox = require('../../lib/sandbox');
const tunnel = require('../../lib/tunnel');
const lib = require('../../lib/jonggrang');

module.exports = function register(app, io, ctx) {
    const { JONGGRANG_HOME, webState, orchestration, server } = ctx;

    const fs = require('fs');
    const path = require('path');
    const chokidar = require('chokidar');
    const { spawn } = require('child_process');

    // ── Local state ──────────────────────────────────────────────
    const projectWatchers = new Map();
    const activeWork = new Map();
    const activePlan = new Map();
    const activeRuns = new Map();
    const lastActivity = new Map();

    // ── Helpers ──────────────────────────────────────────────────

    // Spawn `jonggrang <args>` for a project.
    // If project.sandbox.enabled → docker exec into the project container
    // so the agent runs in isolation. Otherwise spawn locally on the host.
    // Pass `{ local: true }` to force host execution (init bootstrap).
    function spawnForProject(project, args, extraEnv = {}, opts = {}) {
        const secretVars = webState.getProjectSecretVars(project.id);

        if (project.sandbox?.enabled && !opts.local) {
            const containerName = sandbox.getContainerName(project.id);
            const containerPath = sandbox.getContainerPath(project);
            const envFlags = [];
            const envForContainer = {
                JONGGRANG_PROJECT_ROOT: containerPath,
                JONGGRANG_MODE: 'autonomous',
                NO_UPDATE_NOTIFIER: '1',
                FORCE_COLOR: '0',
                ...secretVars,
                ...extraEnv,
            };
            for (const [k, v] of Object.entries(envForContainer)) {
                envFlags.push('--env', `${k}=${v}`);
            }
            const dockerArgs = [
                'exec', '-i',
                '--workdir', containerPath,
                ...envFlags,
                containerName,
                'jonggrang', ...args,
            ];
            return spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        }

        // A device project's code is on the developer's machine, so jonggrang runs
        // HERE but works THERE: cwd is the mount, and the agent it spawns gets the
        // redirect env plus the sentence that stops it writing for the wrong
        // platform. Without this the planner would read an empty directory and
        // write a plan about nothing.
        let cwd = project.path;
        const deviceEnv = {};
        // `opts.local` means "not in the container" — init uses it because a
        // container may not be up yet. It must NOT mean "ignore the device": for a
        // device project the CLI runs here either way, and what changes is only
        // the directory it works in. Skipping this branch for init left the tool
        // scaffold (AGENTS.md, .claude) on the server while .jonggrang — a symlink
        // — landed on the device: one project, its instructions split across two
        // machines.
        if (project.device?.enabled) {
            const device = tunnel.deviceFor(project.device.device_id);
            if (!device) throw new Error(`device ${project.device.device_id} is no longer registered`);
            tunnel.mountDevice(device, project.device.workdir);
            tunnel.linkProjectState(project, project.device.workdir);
            cwd = project.device.workdir;
            Object.assign(deviceEnv, tunnel.deviceRedirectEnv(device, project.device.workdir));
            deviceEnv.JONGGRANG_DEVICE_PROMPT = tunnel.devicePlatformPrompt(
                device, tunnel.devicePlatform(project.device.device_id), project.device.workdir);
        }

        const nodeCli = path.join(__dirname, '..', '..', 'bin', 'jonggrang.js');
        return spawn('node', [nodeCli, ...args], {
            cwd,
            env: {
                ...process.env,
                // Override inherited PWD: Node's `cwd` option sets the child's real
                // working directory but leaves PWD pointing at the server's launch
                // dir. Agent CLIs (opencode) resolve their project root from $PWD,
                // so without this they run in the wrong repo.
                PWD: cwd,
                JONGGRANG_HOME,
                JONGGRANG_PROJECT_ROOT: cwd,
                JONGGRANG_MODE: 'autonomous',
                NO_UPDATE_NOTIFIER: '1',
                FORCE_COLOR: '0',
                ...secretVars,
                ...deviceEnv,
                ...extraEnv,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }

    function wireProjectProcess(projectId, child, command) {
        io.to(`project:${projectId}`).emit('process.started', { project_id: projectId, command, pid: child.pid });
        let seq = 0;
        // Read the stored clarifying questions and relay them to the client so it
        // can render an answer form (feature: plan ask). Questions live per-draft
        // under .drafts/<session>/ — resolve the session from the signal (the CLI
        // emits it) and fall back to scanning for the newest pending draft.
        const emitPlanQuestions = (session) => {
            const project = webState.getProject(projectId);
            if (!project) return;
            const sid = session || lib.resolveActiveQuestionDraft(project.path);
            if (!sid) return;
            const qPath = lib.questionsFileFor(project.path, sid);
            if (!fs.existsSync(qPath)) return;
            try {
                const questions = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
                io.to(`project:${projectId}`).emit('plan.questions', { project_id: projectId, sessionId: sid, ...questions });
            } catch { /* unreadable store — ignore */ }
        };

        const handleLine = (stream, line) => {
            if (!line.trim()) return;
            io.to(`project:${projectId}`).emit('process.log', { project_id: projectId, stream, line, raw: line, seq: seq++ });
            // The planning agent surfaces clarifying questions via a JSON signal
            // line (`{"type":"plan_questions",...}`). Parse the *complete* line.
            if (stream === 'stdout' && line.includes('"plan_questions"')) {
                try {
                    const sig = JSON.parse(line.trim());
                    if (sig && sig.type === 'plan_questions') emitPlanQuestions(sig.session);
                } catch { /* not a signal line — ignore */ }
            }
        };

        // `stdout`/`stderr` 'data' events do NOT guarantee whole lines — a JSON
        // signal line can be split across chunks. Buffer per stream and only
        // handle a line once its terminating newline has arrived.
        const buffers = { stdout: '', stderr: '' };
        const onData = (stream) => (data) => {
            buffers[stream] += data.toString();
            let nl;
            while ((nl = buffers[stream].indexOf('\n')) !== -1) {
                const line = buffers[stream].slice(0, nl).replace(/\r$/, '');
                buffers[stream] = buffers[stream].slice(nl + 1);
                handleLine(stream, line);
            }
        };
        child.stdout.on('data', onData('stdout'));
        child.stderr.on('data', onData('stderr'));
        child.on('close', (code, signal) => {
            // Flush any trailing partial line (output not terminated by a newline).
            for (const stream of ['stdout', 'stderr']) {
                if (buffers[stream]) { handleLine(stream, buffers[stream].replace(/\r$/, '')); buffers[stream] = ''; }
            }
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
        // Skip projects whose path isn't on disk yet (e.g., still importing).
        // mkdirSync below would otherwise create the target dir and race the git clone.
        if (!fs.existsSync(project.path)) return;
        const jonggrangDir = path.join(project.path, '.jonggrang');
        try { fs.mkdirSync(jonggrangDir, { recursive: true }); } catch {}
        const watcher = chokidar.watch(jonggrangDir, { ignoreInitial: true, depth: 3 });

        const emit = (changedPath) => {
            try {
                try { lib.migrateLegacyPlanDraft(project.path); } catch {}
                const sid = lib.resolveActiveDraft(project.path);
                const planPath = sid ? lib.draftFileFor(project.path, sid) : '';
                const state = webState.deriveState(project.path);
                io.to(`project:${project.id}`).emit('state', { project_id: project.id, state });
                if (planPath && fs.existsSync(planPath)) {
                    const content = fs.readFileSync(planPath, 'utf-8');
                    const mtime = fs.statSync(planPath).mtimeMs;
                    io.to(`project:${project.id}`).emit('plan.content', { project_id: project.id, sessionId: sid, content, mtime });
                } else {
                    io.to(`project:${project.id}`).emit('plan.deleted', { project_id: project.id, sessionId: sid || null });
                }
                try {
                    const allTasks = lib.getAllTasks(project.path);
                    io.to(`project:${project.id}`).emit('tasks.update', { project_id: project.id, tasks: allTasks.tasks || [] });
                } catch {
                    console.log('Error reading tasks', project.path);
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
                try { lib.migrateLegacyPlanDraft(project.path); } catch {}
                const state = webState.deriveState(project.path);
                const sid = lib.resolveActiveDraft(project.path);
                const planPath = sid ? lib.draftFileFor(project.path, sid) : '';
                // Tasks are per-feature under .output/features/<id>/; merge via getAllTasks.
                let tasks = [];
                try { tasks = lib.getAllTasks(project.path).tasks || []; } catch {}
                let planContent = null;
                let planMtime = null;
                if (planPath && fs.existsSync(planPath)) {
                    planContent = fs.readFileSync(planPath, 'utf-8');
                    planMtime = fs.statSync(planPath).mtimeMs;
                }
                const running = activeWork.has(project_id);
                const planEntry = activePlan.get(project_id);
                // process precedence: work wins if somehow both, then a running
                // plan-family op reports its stored command kind, else null.
                let process = null;
                if (running) {
                    process = { command: 'work' };
                } else if (planEntry) {
                    process = { command: planEntry.command };
                }
                // Pending-questions signal: a produced-but-unanswered clarifying
                // -questions draft exists when its questions file is present on
                // disk. A mid Pass-A draft has questions but NO plan.md yet, so
                // resolveActiveDraft() (plan.md-gated) can't see it — resolve the
                // questions-bearing draft the same way GET /plan/questions does
                // (newest questions-file, else the active draft). Distinguishes
                // "still generating" from "questions ready" for the client.
                let planQuestionsPending = false;
                let planQuestionsSid = null;
                try {
                    planQuestionsSid = lib.resolveActiveQuestionDraft(project.path) || sid;
                    if (planQuestionsSid) {
                        planQuestionsPending = fs.existsSync(lib.questionsFileFor(project.path, planQuestionsSid));
                    }
                } catch { planQuestionsPending = false; planQuestionsSid = null; }
                const orchView = deps.orchestrationRunView ? deps.orchestrationRunView(project) : null;
                socket.emit('subscribed', {
                    project_id,
                    snapshot: {
                        state,
                        tasks,
                        plan_exists: !!planContent,
                        plan_session_id: sid || null,
                        plan_content: planContent,
                        plan_mtime: planMtime,
                        process,
                        plan_questions_pending: planQuestionsPending,
                        plan_questions_session_id: planQuestionsPending ? planQuestionsSid : null,
                        orchestration: orchView,
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
        activePlan,
        activeRuns,
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
    app.use('/api/projects', require('./orchestration-run')(deps));
    app.use('/api/projects', require('./base')(deps));
    app.use('/api/projects', require('./pty')(deps));
    app.use('/api/projects', require('./files')(deps));
    const codeServerRouter = require('./code-server')(deps);
    app.use('/api/projects', codeServerRouter);
    // Route websocket upgrades for the editor through the proxy; let socket.io
    // keep handling everything else (it ignores requests its handler doesn't own).
    if (server && deps.codeEditorUpgrade) {
        server.on('upgrade', (req, socket, head) => {
            try { deps.codeEditorUpgrade(req, socket, head); } catch {}
        });
    }
    app.use('/api/projects', require('./sandbox-routes')(deps));
    app.use('/api', require('../secrets')(deps));
    app.use('/api', require('../issues')(deps));
    app.use('/api/projects', require('./settings')(deps));

    // Idle sandbox auto-stop disabled — containers stopped manually only

    // ── Cleanup ───────────────────────────────────────────────────

    return function cleanup() {
        for (const [, child] of activeWork) {
            if (!child.killed) try { child.kill('SIGKILL'); } catch {}
        }
        for (const [, entry] of activePlan) {
            const child = entry && entry.child;
            if (child && !child.killed) try { child.kill('SIGKILL'); } catch {}
        }
        for (const [, run] of activeRuns) {
            for (const group of Object.values(run.groups || {})) {
                if (group.child && !group.child.killed) try { group.child.kill('SIGKILL'); } catch {}
            }
        }
        for (const [, w] of projectWatchers) {
            try { w.close(); } catch {}
        }
        try { codeServerRouter._cleanup?.(); } catch {}
    };
};
