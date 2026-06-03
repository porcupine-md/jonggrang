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
// Two execution contexts (see buildCtx):
//   - host:      git ops + worker run on the host (cwd = host paths).
//   - container: when project.sandbox.enabled, EVERYTHING (worktree create,
//                agent work, commit, diff, push) runs INSIDE the project's
//                Docker container via `docker exec`, using container paths. The
//                project dir is bind-mounted, so files are shared with the host.
//
// Run state lives in-memory (deps.activeRuns) so it survives page navigation /
// socket reconnect. A serialized snapshot is mirrored to
// .jonggrang/.ephemeral/orchestration-run.json so diff/push keep working and a
// fresh subscriber can be re-hydrated.

const { Router } = require('express');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');

const lib = require('../../lib/jonggrang');
const sandbox = require('../../lib/sandbox');

const LOG_TAIL_MAX = 200;
const GIT_MAXBUF = 1024 * 1024 * 64;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Working-tree state a worktree needs but that may not be committed in HEAD.
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

    // ── execution context (host vs sandbox container) ─────────────

    function buildCtx(project) {
        if (project.sandbox?.enabled) {
            const container = sandbox.getContainerName(project.id);
            const root = sandbox.getContainerPath(project); // e.g. /root/<name>
            return {
                mode: 'container',
                container,
                root,
                // worktree path INSIDE the container
                wt: (fid) => `${root}/.jonggrang/.worktree/${fid}`,
                // same worktree on the HOST (bind mount) — for fs seeding / mkdir
                hostWt: (fid) => path.join(project.path, '.jonggrang', '.worktree', fid),
            };
        }
        return {
            mode: 'host',
            root: project.path,
            wt: (fid) => path.join(project.path, '.jonggrang', '.worktree', fid),
            hostWt: (fid) => path.join(project.path, '.jonggrang', '.worktree', fid),
        };
    }

    // Run a git command in the right context. Returns stdout (string).
    function gitSync(ctx, cwd, argv) {
        if (ctx.mode === 'container') {
            return execFileSync('docker', ['exec', '--workdir', cwd, ctx.container, 'git', ...argv],
                { encoding: 'utf8', maxBuffer: GIT_MAXBUF });
        }
        return execFileSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: GIT_MAXBUF });
    }

    // Container-only: make git usable on the bind-mounted repo (dubious ownership)
    // and ensure a committer identity exists for our + the agent's commits.
    function prepareContainerGit(ctx) {
        if (ctx.mode !== 'container') return;
        try { gitSync(ctx, ctx.root, ['config', '--global', '--add', 'safe.directory', '*']); } catch {}
        for (const [key, val] of [['user.name', 'jonggrang'], ['user.email', 'jonggrang@local']]) {
            let cur = '';
            try { cur = gitSync(ctx, ctx.root, ['config', '--global', key]).trim(); } catch {}
            if (!cur) { try { gitSync(ctx, ctx.root, ['config', '--global', key, val]); } catch {} }
        }
    }

    function createWorktreeCtx(ctx, g) {
        const wt = ctx.wt(g.featureId);
        const branch = g.branch;
        try { gitSync(ctx, ctx.root, ['worktree', 'prune']); } catch {}
        try { gitSync(ctx, ctx.root, ['worktree', 'remove', wt, '--force']); } catch {}
        try { gitSync(ctx, ctx.root, ['branch', '-D', branch]); } catch {}
        try { fs.mkdirSync(path.dirname(ctx.hostWt(g.featureId)), { recursive: true }); } catch {}
        const baseSha = gitSync(ctx, ctx.root, ['rev-parse', 'HEAD']).trim();
        gitSync(ctx, ctx.root, ['worktree', 'add', '-b', branch, wt, 'HEAD']);
        return { worktreePath: wt, hostWorktreePath: ctx.hostWt(g.featureId), branch, baseSha };
    }

    function commitWorktreeCtx(ctx, wt, message) {
        gitSync(ctx, wt, ['add', '-A']);
        const status = gitSync(ctx, wt, ['status', '--porcelain']).trim();
        if (!status) return false;
        gitSync(ctx, wt, ['commit', '-m', message]);
        return true;
    }

    function changedFilesCtx(ctx, wt, baseSha) {
        const out = gitSync(ctx, wt, ['diff', '--name-status', baseSha]);
        return out.split('\n').filter(Boolean).map(line => {
            const [status, ...rest] = line.split('\t');
            return { status, file: rest.join('\t') };
        });
    }

    function fileDiffCtx(ctx, wt, baseSha, file) {
        return gitSync(ctx, wt, file ? ['diff', baseSha, '--', file] : ['diff', baseSha]);
    }

    // Does the container have an ssh client? (Some agent images ship git but not
    // openssh-client, in which case in-container SSH push is impossible.)
    function containerHasSsh(container) {
        return new Promise((resolve) => {
            execFile('docker', ['exec', container, 'sh', '-c', 'command -v ssh >/dev/null 2>&1 && echo yes || echo no'],
                { timeout: 10000 }, (err, stdout) => resolve(!err && /yes/.test(String(stdout))));
        });
    }

    // In-container push using the mounted SSH key (staged to a root-owned 0600 file).
    function containerPush(ctx, branch) {
        return new Promise((resolve, reject) => {
            const script =
                `set -e; ` +
                `mkdir -p /root/.ssh && cp ${sandbox.SSH_KEY_MOUNT} /root/.ssh/id_jonggrang && chmod 600 /root/.ssh/id_jonggrang; ` +
                `GIT_TERMINAL_PROMPT=0 ` +
                `GIT_SSH_COMMAND='ssh -i /root/.ssh/id_jonggrang -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes' ` +
                `git -C ${ctx.root} push -u origin "${branch}"`;
            execFile('docker', ['exec', ctx.container, 'sh', '-c', script],
                { timeout: 60000, maxBuffer: GIT_MAXBUF }, (err, stdout, stderr) => {
                    if (!err) return resolve();
                    if (err.killed || err.signal === 'SIGTERM') {
                        return reject(new Error('git push timed out (no key or network)'));
                    }
                    reject(new Error((stderr || stdout || err.message).toString().trim()));
                });
        });
    }

    // Push a branch. Host → host git. Container → in-container SSH push when the
    // image has an ssh client + a mounted key; otherwise fall back to host-side
    // push (the branch ref + objects live in the bind-mounted .git, and the host
    // has ssh/credentials — verified to work regardless of the image).
    function pushBranchCtx(ctx, project) {
        return async (branch) => {
            if (ctx.mode === 'container') {
                const hasKey = !!sandbox.resolveProjectSshKey(project.id);
                if (hasKey && await containerHasSsh(ctx.container)) {
                    return containerPush(ctx, branch);
                }
                return lib.pushBranch(project.path, branch); // host fallback
            }
            return lib.pushBranch(ctx.root, branch);
        };
    }

    async function ensureContainerRunning(project) {
        let running = await sandbox.isRunning(project.id).catch(() => false);
        if (running) return true;
        // Auto-start, then wait (bounded) for it to become ready.
        try {
            const status = await sandbox.exists(project.id).catch(() => null);
            if (status) await sandbox.startExisting(project.id);
            else await sandbox.start(project, project.sandbox, webState.getProjectSecretVars(project.id), () => {});
        } catch (err) {
            throw new Error(err.message || 'failed to start sandbox');
        }
        for (let i = 0; i < 30 && !running; i++) {
            await sleep(500);
            running = await sandbox.isRunning(project.id).catch(() => false);
        }
        if (!running) throw new Error('container did not become ready');
        return true;
    }

    // ── helpers ───────────────────────────────────────────────────

    const tasksFileOf  = (project) => path.join(project.path, '.jonggrang', 'jonggrang-tasks.json');
    const snapshotPath = (project) => path.join(project.path, '.jonggrang', '.ephemeral', 'orchestration-run.json');

    function emit(projectId, event, payload) {
        io.to(`project:${projectId}`).emit(event, { project_id: projectId, ...payload });
    }

    function serializeRun(run) {
        if (!run) return null;
        return {
            project_id: run.projectId,
            started_at: run.startedAt,
            status: run.status,
            mode: run.mode || 'host',
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

    function currentRunView(project) {
        const live = activeRuns.get(project.id);
        if (live) return serializeRun(live);
        return readSnapshot(project);
    }
    deps.orchestrationRunView = currentRunView; // used by the subscribe snapshot

    function runActive(run) {
        return run && Object.values(run.groups).some(g => g.status === 'running' || g.status === 'queued');
    }

    // Spawn one worktree worker for a plan, in the right context.
    function spawnGroupWorker(project, ctx, group) {
        const secretVars = webState.getProjectSecretVars(project.id);
        const workerArgs = ['work', '--worktree', '--group-tasks', group.taskIds.join(','), '--branch', group.branch];

        if (ctx.mode === 'container') {
            const envFlags = [];
            const env = {
                JONGGRANG_PROJECT_ROOT: group.worktreePath,
                JONGGRANG_MODE: 'autonomous',
                NO_UPDATE_NOTIFIER: '1',
                FORCE_COLOR: '0',
                ...secretVars,
            };
            for (const [k, v] of Object.entries(env)) envFlags.push('--env', `${k}=${v}`);
            const dockerArgs = ['exec', '-i', '--workdir', group.worktreePath, ...envFlags, ctx.container, 'jonggrang', ...workerArgs];
            return spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        }

        const nodeCli = path.join(__dirname, '..', '..', 'bin', 'jonggrang.js');
        return spawn('node', [nodeCli, ...workerArgs], {
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

    function wireWorker(project, ctx, run, group) {
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
                    continue;
                }
                pushLog(group, trimmed);
                emit(project.id, 'orchestration.group.log', { feature_id: group.featureId, stream, line: trimmed });
            }
        };
        child.stdout.on('data', onData('stdout'));
        child.stderr.on('data', onData('stderr'));

        child.on('close', (code) => {
            group.exitCode = code;
            group.finishedAt = new Date().toISOString();
            if (code === 0) {
                try {
                    group.committed = commitWorktreeCtx(ctx, group.worktreePath, `feat(${group.featureId}): ${group.title}`);
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

    router.post('/:id/orchestration/start', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        if (deps.activeWork?.has(project.id)) {
            return res.status(409).json({ error: { code: 'PROCESS_ALREADY_RUNNING', message: 'A work process is already running' } });
        }
        if (runActive(activeRuns.get(project.id))) {
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

        const ctx = buildCtx(project);

        // For sandbox projects, make sure the container is up before we touch git.
        if (ctx.mode === 'container') {
            try {
                await ensureContainerRunning(project);
            } catch (err) {
                return res.status(409).json({ error: { code: 'SANDBOX_NOT_RUNNING', message: `Docker sandbox is not running: ${err.message}` } });
            }
            prepareContainerGit(ctx);
        }

        const run = { projectId: project.id, startedAt: new Date().toISOString(), status: 'running', mode: ctx.mode, groups: {} };

        try {
            for (const g of groups) {
                const { worktreePath, hostWorktreePath, branch, baseSha } = createWorktreeCtx(ctx, g);
                // Seed working state via host fs (bind-mounted → visible in container).
                lib.copyToWorktree(project.path, hostWorktreePath, COPY_INTO_WORKTREE);
                // Base commit so the run diff (vs baseSha) shows ONLY the agent's work.
                let effectiveBase = baseSha;
                try {
                    if (commitWorktreeCtx(ctx, worktreePath, `chore: jonggrang workspace for ${g.featureId}`)) {
                        effectiveBase = gitSync(ctx, worktreePath, ['rev-parse', 'HEAD']).trim();
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

        for (const group of Object.values(run.groups)) {
            group.child = spawnGroupWorker(project, ctx, group);
            group.status = 'running';
            group.startedAt = new Date().toISOString();
            wireWorker(project, ctx, run, group);
            emit(project.id, 'orchestration.group.started', {
                feature_id: group.featureId, branch: group.branch, title: group.title, pid: group.child.pid,
            });
        }
        persist(project, run);

        res.status(202).json({ run: serializeRun(run) });
    });

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

    router.get('/:id/orchestration', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        res.json(currentRunView(project) || { project_id: project.id, status: 'idle', groups: [] });
    });

    router.get('/:id/orchestration/groups/:featureId/diff', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        const view = currentRunView(project);
        const g = view?.groups?.find(x => x.feature_id === req.params.featureId);
        if (!g) return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'Group not found in current run' } });
        const ctx = buildCtx(project);
        try {
            const files = changedFilesCtx(ctx, g.worktree_path, g.base_sha);
            const { file } = req.query;
            const diff = file ? fileDiffCtx(ctx, g.worktree_path, g.base_sha, String(file)) : null;
            res.json({ feature_id: g.feature_id, branch: g.branch, files, file: file || null, diff });
        } catch (err) {
            res.status(500).json({ error: { code: 'DIFF_ERROR', message: err.message } });
        }
    });

    router.post('/:id/orchestration/groups/:featureId/push', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        const ctx = buildCtx(project);

        if (!lib.hasRemote(project.path)) {
            return res.status(422).json({ error: { code: 'NO_REMOTE', message: 'No "origin" remote configured' } });
        }

        const run = activeRuns.get(project.id);
        const view = currentRunView(project);
        const g = view?.groups?.find(x => x.feature_id === req.params.featureId);
        if (!g) return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'Group not found' } });
        try {
            await pushBranchCtx(ctx, project)(g.branch);
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
