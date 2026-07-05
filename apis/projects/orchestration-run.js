'use strict';

// Parallel orchestration manager.
//
// Runs every plan (group of tasks sharing one feature_id) in its own git
// worktree + branch. Plans are started individually from each plan's Work
// Mode in the web UI (per-group start), and still run in parallel: the run
// is an incremental registry that groups join as they start. The parent
// process is the SINGLE writer of tasks.json: workers emit task_status JSON
// signals via stdout, which we translate into the main board so the kanban
// updates live.
//
// Two execution contexts (host vs Docker container). For sandbox projects
// everything runs INSIDE the container via `docker exec`.

const { Router } = require('express');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');

const lib = require('../../lib/jonggrang');
const sandbox = require('../../lib/sandbox');
const sandboxGit = require('../../lib/sandbox-git');

const LOG_TAIL_MAX = 200;
const GIT_MAXBUF = 1024 * 1024 * 64;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Working-tree state a worktree needs but that may not be committed in HEAD.
// `.jonggrang/.worktree` is deliberately excluded (would recurse). copyToWorktree
// silently skips entries that don't exist.
const COPY_INTO_WORKTREE = [
    '.jonggrang/jonggrang.json',
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

    function projectOr404(req, res) {
        const project = webState.getProject(req.params.id);
        if (!project) res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        return project;
    }

    // ── execution context (host vs sandbox container) ─────────────

    function buildCtx(project) {
        // Worktrees live centrally under ~/.jonggrang/worktree/<id>/<fid>; for
        // sandbox projects that dir is bind-mounted into the container at
        // sandbox.WORKTREE_MOUNT, so git ops run on container-absolute paths.
        const hostDir = sandbox.projectWorktreeDir(project.id);
        if (project.sandbox?.enabled) {
            const container = sandbox.getContainerName(project.id);
            const root = sandbox.getContainerPath(project); // e.g. /root/<name>
            return {
                mode: 'container',
                container,
                root,
                wt: (fid) => `${sandbox.WORKTREE_MOUNT}/${fid}`,
                hostWt: (fid) => path.join(hostDir, fid),
            };
        }
        return {
            mode: 'host',
            root: project.path,
            wt: (fid) => path.join(hostDir, fid),
            hostWt: (fid) => path.join(hostDir, fid),
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

    // Copy paths between two container-absolute locations, run as root INSIDE
    // the container. In sandbox mode every file the run produces lands in a
    // root-owned bind mount, so the host (a different uid) can't write into it
    // — seeding/mirroring must happen in-container or it EACCESes. `items` is a
    // list of {src, dst} container-absolute paths; missing srcs are skipped.
    // `rm -rf dst` first: a worktree created from a HEAD that already tracks the
    // seeded path (e.g. main carries .jonggrang/ via "Push plans") would make
    // `cp -a src dst` nest the dir inside the existing one (.output/.output),
    // hiding the feature's manifest. Removing dst first guarantees a clean copy.
    function containerCopy(ctx, items) {
        if (!items.length) return;
        const script = items.map(({ src, dst }) =>
            `if [ -e "${src}" ]; then mkdir -p "$(dirname "${dst}")" && rm -rf "${dst}" && cp -a "${src}" "${dst}"; fi`
        ).join('; ');
        execFileSync('docker', ['exec', ctx.container, 'sh', '-c', script],
            { encoding: 'utf8', maxBuffer: GIT_MAXBUF });
    }

    // Container-only: ensure git is usable on the bind-mounted repo
    // and a committer identity exists.
    function prepareContainerGit(ctx) {
        if (ctx.mode !== 'container') return;
        try { gitSync(ctx, ctx.root, ['config', '--global', '--add', 'safe.directory', '*']); } catch {}
        for (const [key, val] of [['user.name', 'jonggrang'], ['user.email', 'jonggrang@local']]) {
            let cur = '';
            try { cur = gitSync(ctx, ctx.root, ['config', '--global', key]).trim(); } catch {}
            if (!cur) { try { gitSync(ctx, ctx.root, ['config', '--global', key, val]); } catch {} }
        }
    }

    // Resolve the worktree start-point. If the plan picked a base branch, fetch
    // it from origin and branch off the FRESH remote tip (FETCH_HEAD) so the
    // worktree always starts from the latest remote (fetch is non-interactive +
    // uses the sandbox SSH key via sandbox-git). Falls back to the local branch,
    // then HEAD, if the fetch fails (offline / no such remote branch / no base).
    function resolveStartRef(ctx, base) {
        if (!base) return 'HEAD';
        // This is the single choke point every base value flows through (CLI
        // --base, web API, AI-written frontmatter, committed plan.md). `base` is
        // interpolated into a shell command below, so reject anything that isn't
        // a plain branch name before it reaches the shell.
        if (!lib.isSafeBranchName(base)) {
            console.warn(`orchestration: ignoring unsafe base "${base}" — starting worktree from HEAD`);
            return 'HEAD';
        }
        try {
            sandboxGit.gitShell(ctx, `fetch origin "${base}"`);
            return 'FETCH_HEAD';
        } catch (fetchErr) {
            try { gitSync(ctx, ctx.root, ['rev-parse', '--verify', `refs/heads/${base}`]); return base; }
            catch {
                // The plan explicitly asked for this base but it's neither on
                // origin nor local — surface it instead of silently using HEAD.
                console.warn(`orchestration: base "${base}" not found on origin or locally (${fetchErr.message}) — starting worktree from HEAD`);
                return 'HEAD';
            }
        }
    }

    function createWorktreeCtx(ctx, g) {
        const wt = ctx.wt(g.featureId);
        const branch = g.branch;
        try { gitSync(ctx, ctx.root, ['worktree', 'prune']); } catch {}
        try { gitSync(ctx, ctx.root, ['worktree', 'remove', wt, '--force']); } catch {}
        // Best-effort: drop a worktree left at the OLD in-repo location (migration).
        try { gitSync(ctx, ctx.root, ['worktree', 'remove', `${ctx.root}/.jonggrang/.worktree/${g.featureId}`, '--force']); } catch {}
        try { gitSync(ctx, ctx.root, ['branch', '-D', branch]); } catch {}
        try { fs.mkdirSync(path.dirname(ctx.hostWt(g.featureId)), { recursive: true }); } catch {}
        const startRef = resolveStartRef(ctx, g.base);
        const baseSha = gitSync(ctx, ctx.root, ['rev-parse', startRef]).trim();
        gitSync(ctx, ctx.root, ['worktree', 'add', '-b', branch, wt, startRef]);
        return { worktreePath: wt, hostWorktreePath: ctx.hostWt(g.featureId), branch, baseSha };
    }

    // Paths kept OUT of feature-branch commits and the run diff. jonggrang seeds
    // its own scaffold + runtime (COPY_INTO_WORKTREE) into every worktree so the
    // agent has its config + skills; none of it is the user's code. If any of it
    // lands in a feature commit, merging the PR drags jonggrang's scaffold
    // (.claude, .codex, .opencode, hooks, AGENTS.md, CLAUDE.md) and runtime state
    // onto main. Derive the exclude set from the seeded list (single source of
    // truth) + installed deps, so this can never drift from what we seed.
    const SEEDED_PATHS = [...new Set(COPY_INTO_WORKTREE.map(p => p.split('/')[0])), 'node_modules'];
    const DIFF_EXCLUDES = SEEDED_PATHS.flatMap(p => [`:(exclude)${p}`, `:(exclude)${p}/**`]);

    function commitWorktreeCtx(ctx, wt, message) {
        gitSync(ctx, wt, ['add', '-A']);
        // Unstage seeded scaffold + deps so the feature commit is code-only.
        try { gitSync(ctx, wt, ['reset', '-q', '--', ...SEEDED_PATHS]); } catch {}
        const staged = gitSync(ctx, wt, ['diff', '--cached', '--name-only']).trim();
        if (!staged) return false;
        gitSync(ctx, wt, ['commit', '-m', message, '-m', lib.COAUTHOR_TRAILER]);
        return true;
    }

    // Untracked files (from Agent/Terminal sessions) don't show in `git diff`
    // until registered — mark intent-to-add first so new files appear with
    // their content. Harmless: push/worker-exit commits run `git add -A` anyway.
    function registerUntracked(ctx, wt) {
        try { gitSync(ctx, wt, ['add', '-A', '-N']); } catch {}
    }

    function changedFilesCtx(ctx, wt, baseSha) {
        registerUntracked(ctx, wt);
        const out = gitSync(ctx, wt, ['diff', '--name-status', baseSha, '--', '.', ...DIFF_EXCLUDES]);
        return out.split('\n').filter(Boolean).map(line => {
            const tabIdx = line.indexOf('\t');
            if (tabIdx < 0) return { status: line.trim(), file: '' };
            return { status: line.slice(0, tabIdx), file: line.slice(tabIdx + 1) };
        });
    }

    function fileDiffCtx(ctx, wt, baseSha, file) {
        registerUntracked(ctx, wt);
        return gitSync(ctx, wt, file
            ? ['diff', baseSha, '--', file]
            : ['diff', baseSha, '--', '.', ...DIFF_EXCLUDES]);
    }

    // ── per-plan worktree registry ─────────────────────────────────
    // Worktrees outlive runs: entering Work Mode creates the plan's worktree
    // so Agent/Terminal can use it before (or without) a run. Meta is kept in
    // .jonggrang/.ephemeral/worktrees.json so diff/push work across restarts.

    const worktreeMetaPath = (project) => path.join(project.path, '.jonggrang', '.ephemeral', 'worktrees.json');

    function readWorktreeMeta(project) {
        try {
            const p = worktreeMetaPath(project);
            if (!fs.existsSync(p)) return {};
            return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
        } catch {
            return {};
        }
    }

    function writeWorktreeMeta(project, meta) {
        try {
            fs.mkdirSync(path.dirname(worktreeMetaPath(project)), { recursive: true });
            fs.writeFileSync(worktreeMetaPath(project), JSON.stringify(meta, null, 2), 'utf8');
        } catch (err) {
            console.error('worktree meta write error:', err.message);
        }
    }

    // Branch/title for a plan, independent of runnable tasks (works for plans
    // whose tasks are all done — Work Mode is still enterable).
    function planGroupInfo(project, featureId) {
        const planPath = path.join(project.path, '.jonggrang', '.output', 'features', featureId, 'plan.md');
        if (!fs.existsSync(planPath)) return null;
        const fm = lib.parsePlanFrontmatter(planPath);
        return {
            featureId,
            branch: fm.branch || `jonggrang/${featureId}`,
            base: fm.base || '',
            title: fm.feature || fm.description || featureId,
        };
    }

    // Idempotent: reuse the plan's existing worktree, otherwise create it,
    // seed working state, make the base "workspace" commit, and record meta.
    function ensureWorktree(project, ctx, info) {
        const all = readWorktreeMeta(project);
        const meta = all[info.featureId];
        const hostWt = ctx.hostWt(info.featureId);
        if (meta && fs.existsSync(path.join(hostWt, '.git'))) {
            return {
                worktreePath: ctx.wt(info.featureId), hostWorktreePath: hostWt,
                branch: meta.branch, baseSha: meta.base_sha, created: false,
            };
        }
        const made = createWorktreeCtx(ctx, info);
        // Seed working state. Sandbox: copy IN the container (root) — the worktree
        // dir was created by the container and is root-owned, so a host-fs copy
        // would EACCES. Host: plain fs copy.
        if (ctx.mode === 'container') {
            containerCopy(ctx, COPY_INTO_WORKTREE.map((rel) => ({
                src: `${ctx.root}/${rel}`,
                dst: `${made.worktreePath}/${rel}`,
            })));
        } else {
            lib.copyToWorktree(project.path, made.hostWorktreePath, COPY_INTO_WORKTREE);
        }
        // Base commit so the diff (vs baseSha) shows ONLY work done in the worktree.
        let effectiveBase = made.baseSha;
        try {
            if (commitWorktreeCtx(ctx, made.worktreePath, `chore: jonggrang workspace for ${info.featureId}`)) {
                effectiveBase = gitSync(ctx, made.worktreePath, ['rev-parse', 'HEAD']).trim();
            }
        } catch { /* keep original baseSha */ }
        all[info.featureId] = {
            branch: made.branch, base_sha: effectiveBase,
            worktree_path: made.worktreePath, created_at: new Date().toISOString(),
        };
        writeWorktreeMeta(project, all);
        return { ...made, baseSha: effectiveBase, created: true };
    }

    // In-container push using the mounted SSH key (staged to a root-owned 0600 file).
    function containerPush(ctx, branch) {
        return new Promise((resolve, reject) => {
            const script =
                `set -e; ` +
                `mkdir -p /root/.ssh && cp ${sandbox.SSH_KEY_MOUNT} /root/.ssh/id_rsa && chmod 600 /root/.ssh/id_rsa; ` +
                `GIT_TERMINAL_PROMPT=0 ` +
                `GIT_SSH_COMMAND='ssh -i /root/.ssh/id_rsa -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes' ` +
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

    // Push a branch. Host → host git. Container → in-container SSH push using
    // the mounted key (the agent image ships an ssh client and stages the key
    // on start). NO host fallback: in sandbox mode the push stays sandboxed —
    // a missing key/remote surfaces as an error instead of silently using the
    // host's credentials.
    function pushBranchCtx(ctx, project) {
        return async (branch) => {
            if (ctx.mode === 'container') {
                return containerPush(ctx, branch);
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

    // Resolve a group for diff/push: prefer the current run view, fall back to
    // the worktree registry (Work Mode without a run, or after a restart).
    function groupView(project, featureId) {
        const view = currentRunView(project);
        const g = view?.groups?.find(x => x.feature_id === featureId);
        if (g && g.worktree_path) return g;
        const meta = readWorktreeMeta(project)[featureId];
        if (!meta) return null;
        const info = planGroupInfo(project, featureId);
        return {
            feature_id: featureId,
            branch: meta.branch,
            title: info?.title || featureId,
            worktree_path: meta.worktree_path,
            base_sha: meta.base_sha,
        };
    }

    // Get-or-create the project's run registry. Groups join incrementally.
    function ensureRun(project, mode) {
        let run = activeRuns.get(project.id);
        if (!run) {
            run = { projectId: project.id, startedAt: new Date().toISOString(), status: 'running', mode, groups: {} };
            activeRuns.set(project.id, run);
        } else {
            run.status = 'running';
            run.mode = mode;
        }
        return run;
    }

    // Spawn one worktree worker for a plan, in the right context.
    // group.workerArgs lets callers run a single task (`--task`) or resume the
    // pipeline (`--resume`) instead of the default all-group-tasks run.
    function spawnGroupWorker(project, ctx, group) {
        const secretVars = webState.getProjectSecretVars(project.id);
        // Pass the group's featureId explicitly so the worker resolves its feature
        // deterministically instead of guessing from a bare task id (per-feature
        // numbering makes task-001 recur across features).
        const workerArgs = group.workerArgs
            || ['work', '--worktree', '--group-tasks', group.taskIds.join(','), '--branch', group.branch, '--feature', group.featureId];

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
                // Override inherited PWD so the agent CLI (opencode resolves its
                // project root from $PWD, not process.cwd()) runs inside the
                // worktree instead of the server's launch dir.
                PWD: group.worktreePath,
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

    function applySignal(project, signal, group) {
        if (signal.type !== 'task_status' || !signal.taskId) return;
        try {
            // Scope resolution to the emitting group's feature. Per-feature numbering
            // means a bare id (task-001) recurs across features, so without this hint
            // findTaskFeature could resolve to the wrong feature (active/first-match)
            // and mark done a task in a different plan.
            const featureId = lib.findTaskFeature(project.path, signal.taskId, { featureId: group?.featureId });
            if (!featureId) {
                console.error('orchestration applySignal error: task feature not found', signal.taskId);
                return;
            }
            const tasksFile = lib.tasksFileFor(project.path, featureId);
            if (signal.status === 'completed') lib.markTaskDone(tasksFile, signal.taskId);
            else lib.updateTaskStatus(tasksFile, signal.taskId, signal.status);
            // The host write succeeded, so applySignal is the LIVE writer of main
            // tasks.json for this group. Tell the periodic mirror to leave tasks.json
            // alone — otherwise it copies the worktree's stale copy (the worker emits
            // signals but never updates its own tasks.json mid-task) back over these
            // updates, reverting in_progress/completed → pending during the run.
            if (group) group._tasksLiveWritten = true;
        } catch (err) {
            // Host write failed (e.g. sandbox-Linux root-owned main → EACCES). Leave
            // _tasksLiveWritten unset so syncTasks mirrors the worktree copy as the
            // fallback path. Single writer either way — never both at once.
            console.error('orchestration applySignal error:', err.message);
        }
    }

    // The worktree worker updates the manifest in its OWN seeded copy
    // (<worktree>/.jonggrang/.output/...), but the web pipeline view reads the
    // MAIN project's manifest. Mirror the worktree manifest back to the main
    // project so the project's file watcher emits `manifest.updated` and the
    // pipeline view advances live (Implement → … → Complete) instead of
    // stalling at the phase it was seeded with.
    // Mirror one worktree file back to the MAIN project copy. `rel` is the path
    // relative to the project root. The main copy may be root-owned (seeded /
    // written in-container), so in sandbox mode the copy runs IN the container
    // to avoid a host EACCES — keeps every sandbox write in the sandbox.
    function mirrorFromWorktree(project, ctx, group, rel, label) {
        try {
            const base = group.hostWorktreePath || group.worktreePath;
            if (!base) return;
            const src = path.join(base, rel);
            const dst = path.join(project.path, rel);
            if (!fs.existsSync(src)) return;
            const data = fs.readFileSync(src);
            let cur = null;
            try { cur = fs.readFileSync(dst); } catch { /* missing */ }
            if (cur && cur.equals(data)) return; // unchanged → don't churn the watcher
            if (ctx.mode === 'container') {
                const srcC = path.join(group.worktreePath, rel);
                const dstC = path.join(ctx.root, rel);
                execFileSync('docker', ['exec', ctx.container, 'sh', '-c',
                    `mkdir -p "$(dirname "${dstC}")" && cp -a "${srcC}" "${dstC}"`],
                    { encoding: 'utf8', maxBuffer: GIT_MAXBUF });
            } else {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.writeFileSync(dst, data);
            }
        } catch (err) {
            console.error(`orchestration ${label} error:`, err.message);
        }
    }

    // The worktree worker updates its OWN manifest + progress log; the dashboard
    // reads the MAIN project's copies and the NEXT plan's worktree is seeded from
    // them. Mirror both back so the pipeline view advances live AND the progress
    // log accumulates across plans (tasks.json already syncs via task signals).
    function syncManifest(project, ctx, group) {
        mirrorFromWorktree(project, ctx, group,
            path.join('.jonggrang', '.output', 'features', group.featureId, 'MANIFEST.yaml'), 'syncManifest');
    }
    function syncProgress(project, ctx, group) {
        mirrorFromWorktree(project, ctx, group,
            path.join('.jonggrang', '.output', 'features', group.featureId, 'progress.txt'), 'syncProgress');
    }
    // Mirror the worktree's per-feature task board back to main. The host-side
    // applySignal write fails under sandbox (main tasks.json is root-owned by the
    // in-container approve → host EACCES), so mirror the file via the container.
    function syncTasks(project, ctx, group) {
        // If applySignal is successfully writing main tasks.json (host / macOS bind
        // mount), it is the single live writer — mirroring the worktree's stale copy
        // here would revert its in_progress/completed updates back to pending. Only
        // mirror when applySignal's host write can't land (sandbox-Linux root-owned).
        if (group._tasksLiveWritten) return;
        mirrorFromWorktree(project, ctx, group,
            path.join('.jonggrang', '.output', 'features', group.featureId, 'jonggrang-tasks.json'), 'syncTasks');
    }

    function wireWorker(project, ctx, run, group) {
        const child = group.child;
        group.pid = child.pid;
        // Live-mirror the worktree manifest + progress log + task board → main while the worker runs.
        group.manifestSync = setInterval(() => {
            syncManifest(project, ctx, group);
            syncProgress(project, ctx, group);
            syncTasks(project, ctx, group);
        }, 1500);
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
                    applySignal(project, signal, group);
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
            if (group.manifestSync) { clearInterval(group.manifestSync); group.manifestSync = null; }
            syncManifest(project, ctx, group); // final state (e.g. completed) → main project
            syncProgress(project, ctx, group); // final progress log → main project
            syncTasks(project, ctx, group);    // final task board → main project
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

    // Ensure worktree + register group in the run + spawn its worker.
    // `g` comes from lib.groupPlans (has featureId/branch/title/taskIds).
    // opts.workerArgs overrides the default all-tasks args (single task / resume).
    function startGroup(project, ctx, run, g, opts = {}) {
        const wt = ensureWorktree(project, ctx, g);
        const group = {
            featureId: g.featureId, branch: wt.branch, title: g.title, taskIds: g.taskIds,
            status: 'running', worktreePath: wt.worktreePath, hostWorktreePath: wt.hostWorktreePath,
            baseSha: wt.baseSha,
            startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
            committed: false, pushed: false, error: null, logTail: [],
            workerArgs: opts.workerArgs || null,
            child: null, manifestSync: null,
        };
        run.groups[g.featureId] = group;
        group.child = spawnGroupWorker(project, ctx, group);
        wireWorker(project, ctx, run, group);
        emit(project.id, 'orchestration.group.started', {
            feature_id: group.featureId, branch: group.branch, title: group.title, pid: group.child.pid,
        });
        return group;
    }

    function cancelGroup(group) {
        if (group.child && !group.child.killed && (group.status === 'running' || group.status === 'queued')) {
            group.status = 'cancelled';
            try {
                group.child.kill('SIGTERM');
                const c = group.child;
                setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 5000);
            } catch {}
            return true;
        }
        return false;
    }

    // Container projects: make sure the sandbox is up before touching git.
    // Returns true when ready, otherwise responds 409 and returns false.
    async function readyCtx(project, ctx, res) {
        if (ctx.mode !== 'container') return true;
        try {
            await ensureContainerRunning(project);
        } catch (err) {
            res.status(409).json({ error: { code: 'SANDBOX_NOT_RUNNING', message: `Docker sandbox is not running: ${err.message}` } });
            return false;
        }
        prepareContainerGit(ctx);
        return true;
    }

    // ── routes ────────────────────────────────────────────────────

    // Ensure a plan's worktree exists (idempotent) — called on entering Work
    // Mode so Agent/Terminal can target the worktree before any run starts.
    router.post('/:id/plans/:featureId/worktree', async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const info = planGroupInfo(project, req.params.featureId);
        if (!info) return res.status(404).json({ error: { code: 'PLAN_NOT_FOUND', message: 'Plan not found' } });

        const ctx = buildCtx(project);
        if (!await readyCtx(project, ctx, res)) return;
        try {
            const wt = ensureWorktree(project, ctx, info);
            res.json({
                feature_id: info.featureId, title: info.title, branch: wt.branch,
                worktree_path: wt.worktreePath, base_sha: wt.baseSha, created: wt.created,
            });
        } catch (err) {
            res.status(500).json({ error: { code: 'WORKTREE_ERROR', message: err.message } });
        }
    });

    // Start ONE plan's group (Work Mode "Run" button). Other plans keep
    // running untouched — the run registry is shared and parallel.
    router.post('/:id/orchestration/groups/:featureId/start', async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const fid = req.params.featureId;

        if (deps.activeWork?.has(project.id)) {
            return res.status(409).json({ error: { code: 'PROCESS_ALREADY_RUNNING', message: 'A work process is already running' } });
        }
        const existing = activeRuns.get(project.id)?.groups?.[fid];
        if (existing && (existing.status === 'running' || existing.status === 'queued')) {
            return res.status(409).json({ error: { code: 'GROUP_ALREADY_RUNNING', message: 'This plan is already running' } });
        }

        let groups;
        try {
            groups = lib.groupPlansAll(project.path);
        } catch (err) {
            return res.status(500).json({ error: { code: 'GROUP_ERROR', message: err.message } });
        }
        const g = groups.find(x => x.featureId === fid);
        if (!g) {
            return res.status(422).json({ error: { code: 'NO_RUNNABLE_TASKS', message: 'No pending tasks for this plan' } });
        }

        const ctx = buildCtx(project);
        if (!await readyCtx(project, ctx, res)) return;

        const run = ensureRun(project, ctx.mode);
        try {
            startGroup(project, ctx, run, g);
        } catch (err) {
            return res.status(500).json({ error: { code: 'WORKTREE_ERROR', message: err.message } });
        }
        persist(project, run);
        emit(project.id, 'orchestration.started', { run: serializeRun(run) });
        res.status(202).json({ run: serializeRun(run) });
    });

    // Shared guard + spawn for the single-task and resume variants below.
    async function startGroupVariant(req, res, buildArgs, fallbackTitle) {
        const project = projectOr404(req, res);
        if (!project) return;
        const fid = req.params.featureId;

        if (deps.activeWork?.has(project.id)) {
            return res.status(409).json({ error: { code: 'PROCESS_ALREADY_RUNNING', message: 'A work process is already running' } });
        }
        const existing = activeRuns.get(project.id)?.groups?.[fid];
        if (existing && (existing.status === 'running' || existing.status === 'queued')) {
            return res.status(409).json({ error: { code: 'GROUP_ALREADY_RUNNING', message: 'This plan is already running' } });
        }

        const info = planGroupInfo(project, fid);
        if (!info) return res.status(404).json({ error: { code: 'PLAN_NOT_FOUND', message: 'Plan not found' } });

        const built = buildArgs(info);
        if (built.error) return res.status(built.code || 422).json({ error: { code: built.error, message: built.message } });

        const ctx = buildCtx(project);
        if (!await readyCtx(project, ctx, res)) return;

        const run = ensureRun(project, ctx.mode);
        const g = { featureId: info.featureId, branch: info.branch, title: built.title || fallbackTitle, taskIds: built.taskIds || [] };
        try {
            const workerArgs = [...built.args, '--branch', info.branch];
            startGroup(project, ctx, run, g, { workerArgs });
        } catch (err) {
            return res.status(500).json({ error: { code: 'WORKTREE_ERROR', message: err.message } });
        }
        persist(project, run);
        emit(project.id, 'orchestration.started', { run: serializeRun(run) });
        res.status(202).json({ run: serializeRun(run) });
    }

    // Run this task in the plan's worktree, including its blocked_by deps.
    // `--task` resolves the dependency chain via lib.getTaskQueue, which already
    // skips any dependency that is already `completed` — so completed deps are
    // never re-run, only the task and its unfinished prerequisites execute.
    router.post('/:id/orchestration/groups/:featureId/run-task', (req, res) => {
        const { task_id } = req.body || {};
        if (!task_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'task_id required' } });
        return startGroupVariant(req, res,
            () => ({ args: ['work', '--worktree', '--task', task_id], taskIds: [task_id], title: `task ${task_id}` }),
            `task ${task_id}`);
    });

    // Resume the pipeline phases (Simplify → … → Completion) in the worktree:
    // `jonggrang work --resume`. Used when all tasks are done but the phase
    // machine stopped at Implement (worktree workers skip post-work phases).
    router.post('/:id/orchestration/groups/:featureId/resume', (req, res) => {
        return startGroupVariant(req, res,
            () => ({ args: ['work', '--worktree', '--resume'], title: 'resume pipeline' }),
            'resume pipeline');
    });

    // Cancel ONE plan's group.
    router.post('/:id/orchestration/groups/:featureId/cancel', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const run = activeRuns.get(project.id);
        const group = run?.groups?.[req.params.featureId];
        if (!group) return res.json({ cancelled: false, message: 'No active run for this plan' });
        const cancelled = cancelGroup(group);
        if (!runActive(run)) run.status = 'cancelled';
        persist(project, run);
        res.json({ cancelled });
    });

    // Start ALL runnable plans at once (kept for compat / CLI parity).
    router.post('/:id/orchestration/start', async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;

        if (deps.activeWork?.has(project.id)) {
            return res.status(409).json({ error: { code: 'PROCESS_ALREADY_RUNNING', message: 'A work process is already running' } });
        }
        if (runActive(activeRuns.get(project.id))) {
            return res.status(409).json({ error: { code: 'RUN_ALREADY_ACTIVE', message: 'An orchestration run is already active' } });
        }

        let groups;
        try {
            groups = lib.groupPlansAll(project.path);
        } catch (err) {
            return res.status(500).json({ error: { code: 'GROUP_ERROR', message: err.message } });
        }
        if (!groups.length) {
            return res.status(422).json({ error: { code: 'NO_RUNNABLE_TASKS', message: 'No pending tasks to run' } });
        }

        const ctx = buildCtx(project);
        if (!await readyCtx(project, ctx, res)) return;

        const run = ensureRun(project, ctx.mode);
        try {
            for (const g of groups) startGroup(project, ctx, run, g);
        } catch (err) {
            return res.status(500).json({ error: { code: 'WORKTREE_ERROR', message: err.message } });
        }
        persist(project, run);
        emit(project.id, 'orchestration.started', { run: serializeRun(run) });
        res.status(202).json({ run: serializeRun(run) });
    });

    router.post('/:id/orchestration/cancel', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const run = activeRuns.get(project.id);
        if (!run) return res.json({ cancelled: false, message: 'No active run' });
        for (const group of Object.values(run.groups)) cancelGroup(group);
        run.status = 'cancelled';
        persist(project, run);
        res.json({ cancelled: true });
    });

    router.get('/:id/orchestration', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        res.json(currentRunView(project) || { project_id: project.id, status: 'idle', groups: [] });
    });

    router.get('/:id/orchestration/groups/:featureId/diff', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const g = groupView(project, req.params.featureId);
        if (!g) return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'No worktree for this plan yet' } });
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
        const project = projectOr404(req, res);
        if (!project) return;
        const ctx = buildCtx(project);

        if (!lib.hasRemote(project.path)) {
            return res.status(422).json({ error: { code: 'NO_REMOTE', message: 'No "origin" remote configured' } });
        }

        // Sandbox commit + push run via `docker exec` — make sure the container
        // is up first (no host fallback). No-op for host projects.
        if (!await readyCtx(project, ctx, res)) return;

        const run = activeRuns.get(project.id);
        const g = groupView(project, req.params.featureId);
        if (!g) return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'No worktree for this plan yet' } });
        try {
            // Include manual (Agent/Terminal) work: commit pending worktree
            // changes before pushing. No-op when the tree is clean.
            try {
                if (fs.existsSync(ctx.hostWt(g.feature_id))) {
                    commitWorktreeCtx(ctx, g.worktree_path, `feat(${g.feature_id}): ${g.title || 'worktree changes'}`);
                }
            } catch (err) {
                return res.status(500).json({ error: { code: 'COMMIT_ERROR', message: err.message } });
            }
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
