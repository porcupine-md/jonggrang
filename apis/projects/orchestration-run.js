'use strict';

// Parallel orchestration manager.
//
// Runs every plan (a group of tasks sharing one feature_id) in its own git
// worktree + branch, in parallel. Within a plan, tasks run serially in
// dependency order. The parent process here is the SINGLE writer of the main
// tasks.json: each worktree worker runs `jonggrang work --worktree` which emits
// task_status JSON signals instead of writing tasks.json (anti-race), and we
// translate those into the main board so the kanban updates live.
//
// Run state lives in-memory (deps.activeRuns) so it survives page navigation /
// socket reconnect, exactly like the legacy single-work process. A serialized
// snapshot is mirrored to .jonggrang/.ephemeral/orchestration-run.json so the
// diff/push endpoints keep working and a fresh subscriber can be re-hydrated.

const { Router } = require('express');
const { spawn } = require('child_process');
const path = require('path');

const lib = require('../../lib/jonggrang');

const LOG_TAIL_MAX = 200;

// Working-tree state a worktree needs but that may not be committed in HEAD:
// the task board, plans/manifests, skills, and the agent scaffolding/hooks.
// `.jonggrang/.worktree` is deliberately excluded (would recurse). copyToWorktree
// silently skips entries that don't exist.
const COPY_INTO_WORKTREE = [
    '.jonggrang/jonggrang.json',
    '.jonggrang/jonggrang-tasks.json',
    '.jonggrang/progress.txt',
    '.jonggrang/.output',
    '.jonggrang/skills',
    '.jonggrang/lib',
    '.claude',
    '.opencode',
    '.codex',
    'AGENTS.md',
    'CLAUDE.md',
    'hooks',
];

module.exports = function(deps) {
    const { fs, webState, io, JONGGRANG_HOME, activeRuns } = deps;
    const router = Router();

    // ── helpers ───────────────────────────────────────────────────

    const tasksFileOf  = (project) => path.join(project.path, '.jonggrang', 'jonggrang-tasks.json');
    const snapshotPath = (project) => path.join(project.path, '.jonggrang', '.ephemeral', 'orchestration-run.json');

    function emit(projectId, event, payload) {
        io.to(`project:${projectId}`).emit(event, { project_id: projectId, ...payload });
    }

    // Serializable view of a run (no child handles).
    function serializeRun(run) {
        if (!run) return null;
        return {
            project_id: run.projectId,
            started_at: run.startedAt,
            status: run.status,
            groups: Object.values(run.groups).map(g => ({
                feature_id: g.featureId,
                branch: g.branch,
                title: g.title,
                task_ids: g.taskIds,
                status: g.status,
                worktree_path: g.worktreePath,
                base_sha: g.baseSha,
                pid: g.pid || null,
                started_at: g.startedAt || null,
                finished_at: g.finishedAt || null,
                exit_code: g.exitCode ?? null,
                committed: !!g.committed,
                pushed: !!g.pushed,
                error: g.error || null,
                log_tail: g.logTail || [],
            })),
        };
    }

    function persist(project, run) {
        try {
            fs.mkdirSync(path.dirname(snapshotPath(project)), { recursive: true });
            fs.writeFileSync(snapshotPath(project), JSON.stringify(serializeRun(run), null, 2), 'utf8');
        } catch (err) {
            console.error('orchestration persist error:', err.message);
        }
    }

    function readSnapshot(project) {
        try {
            const p = snapshotPath(project);
            if (!fs.existsSync(p)) return null;
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            return null;
        }
    }

    // Expose current run (live, else last persisted snapshot) for subscribe/GET.
    function currentRunView(project) {
        const live = activeRuns.get(project.id);
        if (live) return serializeRun(live);
        return readSnapshot(project);
    }
    deps.orchestrationRunView = currentRunView; // used by the subscribe snapshot

    function runActive(run) {
        return run && Object.values(run.groups).some(g => g.status === 'running' || g.status === 'queued');
    }

    // Spawn one worktree worker for a plan.
    function spawnGroupWorker(project, group) {
        const secretVars = webState.getProjectSecretVars(project.id);
        const nodeCli = path.join(__dirname, '..', '..', 'bin', 'jonggrang.js');
        const args = [
            nodeCli, 'work',
            '--worktree',
            '--group-tasks', group.taskIds.join(','),
            '--branch', group.branch,
        ];
        return spawn('node', args, {
            cwd: group.worktreePath,
            env: {
                ...process.env,
                JONGGRANG_HOME,
                JONGGRANG_PROJECT_ROOT: group.worktreePath,
                JONGGRANG_MODE: 'autonomous',
                NO_UPDATE_NOTIFIER: '1',
                FORCE_COLOR: '0',
                ...secretVars,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }

    function pushLog(group, line) {
        group.logTail = group.logTail || [];
        group.logTail.push(line);
        if (group.logTail.length > LOG_TAIL_MAX) group.logTail.shift();
    }

    // Apply a worker's task_status signal to the MAIN board (single writer).
    function applySignal(project, signal) {
        if (signal.type !== 'task_status' || !signal.taskId) return;
        const mainTasks = tasksFileOf(project);
        try {
            if (signal.status === 'completed') lib.markTaskDone(mainTasks, signal.taskId);
            else lib.updateTaskStatus(mainTasks, signal.taskId, signal.status);
        } catch (err) {
            console.error('orchestration applySignal error:', err.message);
        }
    }

    function wireWorker(project, run, group) {
        const child = group.child;
        group.pid = child.pid;
        let buf = '';
        const onData = (stream) => (data) => {
            buf += data.toString();
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                const trimmed = line.trim();
                if (!trimmed) continue;
                let signal = null;
                if (trimmed.startsWith('{')) {
                    try { signal = JSON.parse(trimmed); } catch { /* not JSON */ }
                }
                if (signal && signal.type === 'task_status') {
                    applySignal(project, signal);
                    continue; // signals are not human log lines
                }
                pushLog(group, trimmed);
                emit(project.id, 'orchestration.group.log', {
                    feature_id: group.featureId, stream, line: trimmed,
                });
            }
        };
        child.stdout.on('data', onData('stdout'));
        child.stderr.on('data', onData('stderr'));

        child.on('close', (code) => {
            group.exitCode = code;
            group.finishedAt = new Date().toISOString();
            if (code === 0) {
                try {
                    const msg = `feat(${group.featureId}): ${group.title}`;
                    group.committed = lib.commitWorktree(group.worktreePath, msg);
                } catch (err) {
                    group.error = `commit failed: ${err.message}`;
                }
                group.status = 'completed';
                emit(project.id, 'orchestration.group.completed', {
                    feature_id: group.featureId, branch: group.branch, committed: !!group.committed,
                });
            } else {
                group.status = group.status === 'cancelled' ? 'cancelled' : 'failed';
                group.error = group.error || `worker exited with code ${code}`;
                emit(project.id, 'orchestration.group.failed', {
                    feature_id: group.featureId, branch: group.branch, error: group.error,
                });
            }
            persist(project, run);

            if (!runActive(run)) {
                run.status = 'completed';
                emit(project.id, 'orchestration.completed', { run: serializeRun(run) });
                persist(project, run);
            }
        });
    }

    // ── routes ────────────────────────────────────────────────────

    // Start a parallel run: one worktree + branch per plan.
    router.post('/:id/orchestration/start', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        if (deps.activeWork?.has(project.id)) {
            return res.status(409).json({ error: { code: 'PROCESS_ALREADY_RUNNING', message: 'A work process is already running' } });
        }
        const existing = activeRuns.get(project.id);
        if (runActive(existing)) {
            return res.status(409).json({ error: { code: 'RUN_ALREADY_ACTIVE', message: 'An orchestration run is already active' } });
        }

        let groups;
        try {
            groups = lib.groupPlans(tasksFileOf(project), project.path);
        } catch (err) {
            return res.status(500).json({ error: { code: 'GROUP_ERROR', message: err.message } });
        }
        if (!groups.length) {
            return res.status(422).json({ error: { code: 'NO_RUNNABLE_TASKS', message: 'No pending tasks to run' } });
        }

        const run = { projectId: project.id, startedAt: new Date().toISOString(), status: 'running', groups: {} };

        // Create worktrees first (serial, fast) so failures abort cleanly.
        try {
            for (const g of groups) {
                const dir = path.join(project.path, '.jonggrang', '.worktree', g.featureId);
                const { worktreePath, branch, baseSha } = lib.createWorktree(
                    project.path, g.featureId, 'HEAD', { dir, branch: g.branch }
                );
                // Seed the worktree with the current working state (task board,
                // plans, skills, agent scaffolding) since it may not be in HEAD.
                lib.copyToWorktree(project.path, worktreePath, COPY_INTO_WORKTREE);
                // Commit that seeded scaffolding as a base commit so the run diff
                // (computed vs baseSha) shows ONLY the agent's actual work, not the
                // hundreds of jonggrang scaffolding files copied in.
                let effectiveBase = baseSha;
                try {
                    if (lib.commitWorktree(worktreePath, `chore: jonggrang workspace for ${g.featureId}`)) {
                        effectiveBase = lib.gitHead(worktreePath);
                    }
                } catch { /* keep original baseSha */ }
                run.groups[g.featureId] = {
                    featureId: g.featureId, branch, title: g.title, taskIds: g.taskIds,
                    status: 'queued', worktreePath, baseSha: effectiveBase,
                    startedAt: null, finishedAt: null, exitCode: null,
                    committed: false, pushed: false, error: null, logTail: [],
                    child: null,
                };
            }
        } catch (err) {
            return res.status(500).json({ error: { code: 'WORKTREE_ERROR', message: err.message } });
        }

        activeRuns.set(project.id, run);
        emit(project.id, 'orchestration.started', { run: serializeRun(run) });

        // Spawn all workers in parallel.
        for (const group of Object.values(run.groups)) {
            group.child = spawnGroupWorker(project, group);
            group.status = 'running';
            group.startedAt = new Date().toISOString();
            wireWorker(project, run, group);
            emit(project.id, 'orchestration.group.started', {
                feature_id: group.featureId, branch: group.branch, title: group.title, pid: group.child.pid,
            });
        }
        persist(project, run);

        res.status(202).json({ run: serializeRun(run) });
    });

    // Cancel all workers in the active run.
    router.post('/:id/orchestration/cancel', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        const run = activeRuns.get(project.id);
        if (!run) return res.json({ cancelled: false, message: 'No active run' });
        for (const group of Object.values(run.groups)) {
            if (group.child && !group.child.killed && (group.status === 'running' || group.status === 'queued')) {
                group.status = 'cancelled';
                try {
                    group.child.kill('SIGTERM');
                    const c = group.child;
                    setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 5000);
                } catch {}
            }
        }
        run.status = 'cancelled';
        persist(project, run);
        res.json({ cancelled: true });
    });

    // Current run state (live or last persisted).
    router.get('/:id/orchestration', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        res.json(currentRunView(project) || { project_id: project.id, status: 'idle', groups: [] });
    });

    // Changed files (+ optional single-file diff) for one plan's branch.
    router.get('/:id/orchestration/groups/:featureId/diff', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        const view = currentRunView(project);
        const g = view?.groups?.find(x => x.feature_id === req.params.featureId);
        if (!g) return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'Group not found in current run' } });
        try {
            const files = lib.worktreeChangedFiles(g.worktree_path, g.base_sha);
            const { file } = req.query;
            const diff = file ? lib.worktreeFileDiff(g.worktree_path, g.base_sha, String(file)) : null;
            res.json({ feature_id: g.feature_id, branch: g.branch, files, file: file || null, diff });
        } catch (err) {
            res.status(500).json({ error: { code: 'DIFF_ERROR', message: err.message } });
        }
    });

    // Push one plan's branch to origin (same name, no force, never main/master).
    router.post('/:id/orchestration/groups/:featureId/push', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        if (!lib.hasRemote(project.path)) {
            return res.status(422).json({ error: { code: 'NO_REMOTE', message: 'No "origin" remote configured' } });
        }
        const run = activeRuns.get(project.id);
        const view = currentRunView(project);
        const g = view?.groups?.find(x => x.feature_id === req.params.featureId);
        if (!g) return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'Group not found' } });
        try {
            await lib.pushBranch(project.path, g.branch);
            if (run?.groups?.[req.params.featureId]) {
                run.groups[req.params.featureId].pushed = true;
                persist(project, run);
            }
            emit(project.id, 'orchestration.group.pushed', { feature_id: g.feature_id, branch: g.branch });
            res.json({ pushed: true, branch: g.branch });
        } catch (err) {
            res.status(500).json({ error: { code: 'PUSH_ERROR', message: err.message } });
        }
    });

    return router;
};
