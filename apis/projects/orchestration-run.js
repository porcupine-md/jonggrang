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
const tunnel = require('../../lib/tunnel');

const LOG_TAIL_MAX = 200;
// How often to ask whether a device is still reachable, and how many misses
// before a run is stopped. 15s × 2 ≈ half a minute of grace, which covers an
// autossh reconnect without letting an agent burn a turn on a dead mount.
const DEVICE_WATCH_INTERVAL_MS = 15_000;
const DEVICE_MISSES_BEFORE_STOP = 2;
const GIT_MAXBUF = 1024 * 1024 * 64;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Working-tree state a worktree needs but that may not be committed in HEAD.
// `.jonggrang/.worktree` is deliberately excluded (would recurse). copyToWorktree
// silently skips entries that don't exist.
const COPY_INTO_WORKTREE = [
    '.jonggrang/jonggrang.json',
    '.jonggrang/.output',
    '.jonggrang/MEMORY.md',
    '.jonggrang/UI.md',
    '.jonggrang/skills',
    '.jonggrang/lib',
    '.claude',
    '.opencode',
    '.codex',
    'AGENTS.md',
    'CLAUDE.md',
    'hooks',
];

// Send a control frame down the worker's stdin — how keystrokes reach the pty.
//
// ONLY a worker that actually opened a pty reads these frames. A headless worker
// never reads its stdin, so a frame written there sits in the pipe until
// something else reads a line from it — and the work loop's test-retry
// escalation does exactly that (`readline.question`). A stray `pty_resize` from
// a browser tab then arrives as if a human had typed feedback, which resets the
// retry counter and re-dispatches the same task forever. So: no live pty, no
// frames.
//
// A resize that arrives before the pty is live is remembered rather than dropped
// — the browser terminal emits its geometry on mount, which is usually before
// the agent has printed its first byte, and the TUI needs it to lay out.
function sendPtyFrame(group, frame) {
    if (!group) return false;
    if (!group.ptyLive) {
        if (frame && frame.type === 'pty_resize') group.pendingResize = frame;
        return false;
    }
    const stdin = group.child && group.child.stdin;
    if (!stdin || stdin.destroyed) return false;
    try { stdin.write(`${JSON.stringify(frame)}\n`); return true; } catch { return false; }
}

// The worker's first pty_data frame is the proof that it runs a pty and is
// reading control frames back. Flush any geometry the browser sent early.
function markPtyLive(group) {
    if (group.ptyLive) return;
    group.ptyLive = true;
    const pending = group.pendingResize;
    group.pendingResize = null;
    if (pending) sendPtyFrame(group, pending);
}

module.exports = function(deps) {
    const { fs, webState, io, JONGGRANG_HOME, activeRuns } = deps;
    const router = Router();

    function projectOr404(req, res) {
        const project = webState.getProject(req.params.id);
        if (!project) res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        return project;
    }

    /**
     * A device project's agent runs on the server with its Bash redirected to the
     * device — and that redirect is a Claude Code `PreToolUse` hook. Another
     * backend gets no redirect, so its commands would run HERE while its file
     * tools act on the device: the split view, silently, for whichever backend the
     * project happens to be set to. The agent route already refused this; the work
     * loop did not, and started `opencode run` on the server.
     *
     * Answers the request and returns true when it has.
     */
    function refusedForDeviceTool(project, res) {
        if (!project.device?.enabled) return false;
        const configFile = path.join(project.path, '.jonggrang', 'jonggrang.json');
        const tool = lib.readConfig(configFile, 'tool', 'claude');
        if (tool === 'claude') return false;
        res.status(400).json({
            error: {
                code: 'DEVICE_TOOL_UNSUPPORTED',
                message: `A device project runs its agent here with Bash redirected to the device, which today is claude-only (this project is set to ${tool}).`,
            },
        });
        return true;
    }

    /**
     * A device project's state is read through `project.path/.jonggrang`, a symlink
     * onto the mount — so it has to be mounted BEFORE anything reads it, not when
     * execution starts.
     *
     * This was three separate mysteries before it was one cause: a task list that
     * read empty ("No pending tasks for this plan"), a worktree registry that read
     * empty (so a resumed run tried to create a worktree that already existed), and
     * a git error about a branch that "already exists". All of them were the
     * project simply not being mounted yet.
     */
    function mountIfDevice(project) {
        if (!project.device?.enabled) return;
        const device = tunnel.deviceFor(project.device.device_id);
        if (!device) return;
        try { tunnel.mountDevice(device, project.device.workdir); }
        catch (err) { console.error('device project mount:', err.message); }
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
        // A device project's repository is on the developer's machine, so its
        // worktrees are too — `git worktree add` has to run where the repo is.
        // The orchestrator and the agent still run here, over a mount of that
        // worktree at the same absolute path, so `wt` and `hostWt` agree.
        if (project.device?.enabled) {
            const device = tunnel.deviceFor(project.device.device_id);
            if (!device) throw new Error(`device ${project.device.device_id} is no longer registered`);
            // Mount the PROJECT, not just the worktree. jonggrang's own state —
            // including the worktree registry — is read through
            // `project.path/.jonggrang`, which is a symlink onto this mount. With
            // it down the registry reads empty, a resumed run concludes its
            // worktree is gone, and tries to create one that already exists:
            // three error messages away from "the project is not mounted".
            try { tunnel.mountDevice(device, project.device.workdir); }
            catch (err) { console.error('device project mount:', err.message); }
            return {
                mode: 'device',
                device,
                root: project.device.workdir,
                wt: (fid) => tunnel.deviceWorktreePath(device, fid),
                hostWt: (fid) => tunnel.deviceWorktreePath(device, fid),
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
        // Not against the mount: a worktree's .git points at the repository by
        // its DEVICE path, so git run here reports "not a git repository" for a
        // directory it can otherwise read perfectly. Measured, not assumed.
        if (ctx.mode === 'device') return tunnel.deviceExec(ctx.device, cwd, 'git', argv);
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
        // Device: drop any mount FIRST. This function removes and re-adds the
        // worktree, and an sshfs session survives that — it then points at a
        // directory that no longer exists, so the mount looks healthy and every
        // write into it fails ENOENT.
        if (ctx.mode === 'device') tunnel.unmountDevice(ctx.device, wt);
        try { gitSync(ctx, ctx.root, ['worktree', 'prune']); } catch {}
        try { gitSync(ctx, ctx.root, ['worktree', 'remove', wt, '--force']); } catch {}
        // Best-effort: drop a worktree left at the OLD in-repo location (migration).
        try { gitSync(ctx, ctx.root, ['worktree', 'remove', `${ctx.root}/.jonggrang/.worktree/${g.featureId}`, '--force']); } catch {}
        try { gitSync(ctx, ctx.root, ['branch', '-D', branch]); } catch {}
        try { fs.mkdirSync(path.dirname(ctx.hostWt(g.featureId)), { recursive: true }); } catch {}
        const startRef = resolveStartRef(ctx, g.base);
        const baseSha = gitSync(ctx, ctx.root, ['rev-parse', startRef]).trim();
        // Adopt the branch if it is still there rather than insisting on -b.
        // The `branch -D` above is best-effort and refuses while the branch is
        // checked out somewhere — which is the normal state when a plan is being
        // re-run — and then `add -b` fails outright with "a branch named … already
        // exists" and takes the whole run with it.
        const hasBranch = (() => {
            try { gitSync(ctx, ctx.root, ['rev-parse', '--verify', `refs/heads/${branch}`]); return true; }
            catch { return false; }
        })();
        gitSync(ctx, ctx.root, hasBranch
            ? ['worktree', 'add', wt, branch]
            : ['worktree', 'add', '-b', branch, wt, startRef]);
        // Device: git made the worktree on the developer's machine. Mount it here,
        // at the same path, so the orchestrator and the agent can work in it.
        if (ctx.mode === 'device') tunnel.mountDevice(ctx.device, wt);
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

    function commitWorktreeCtx(ctx, wt, message, featureId) {
        gitSync(ctx, wt, ['add', '-A']);
        // Unstage seeded scaffold + deps so the feature commit is code-only...
        try { gitSync(ctx, wt, ['reset', '-q', '--', ...SEEDED_PATHS]); } catch {}
        // ...but DO include THIS feature's own progress state (tasks/manifest/
        // progress/plan) so it travels with the work-mode branch. Other features
        // and shared scaffold stay excluded.
        if (featureId) {
            try { gitSync(ctx, wt, ['add', '-A', '--', `.jonggrang/.output/features/${featureId}`]); } catch {}
        }
        // ...and the project MEMORY.md: `promote` updates it in THIS worktree at
        // pipeline completion, so it's a change this feature produced — commit it
        // with the branch (shows in Changes, reaches main on PR merge), same as
        // feature memory. (The rest of the .jonggrang scaffold stays excluded.)
        try { gitSync(ctx, wt, ['add', '-A', '--', PROJECT_MEMORY_PATH]); } catch {}
        // A designated UI-foundation task may promote a planned token source to
        // ready in the canonical project guide. Keep that reviewed guide change
        // with the feature branch, just like project memory.
        try { gitSync(ctx, wt, ['add', '-A', '--', PROJECT_UI_PATH]); } catch {}
        const staged = gitSync(ctx, wt, ['diff', '--cached', '--name-only']).trim();
        if (!staged) return false;
        gitSync(ctx, wt, ['commit', '-m', message, '-m', lib.COAUTHOR_TRAILER]);
        return true;
    }

    // Positive pathspec for a feature's own progress dir — git exclude pathspecs
    // always win, so we run a SEPARATE diff for this and merge it with the code diff.
    const featureOutputPathspec = (featureId) => `.jonggrang/.output/features/${featureId}`;
    // Project memory lives at repo root; `.jonggrang` is a seeded/excluded path, so
    // it also needs a separate positive diff to surface in the Changes view.
    const PROJECT_MEMORY_PATH = '.jonggrang/MEMORY.md';
    const PROJECT_UI_PATH = '.jonggrang/UI.md';

    // Untracked files (from Agent/Terminal sessions) don't show in `git diff`
    // until registered — mark intent-to-add first so new files appear with
    // their content. Harmless: push/worker-exit commits run `git add -A` anyway.
    function registerUntracked(ctx, wt) {
        try { gitSync(ctx, wt, ['add', '-A', '-N']); } catch {}
    }

    function changedFilesCtx(ctx, wt, baseSha, featureId) {
        registerUntracked(ctx, wt);
        // Code changes (all seeded/.jonggrang excluded)...
        let out = gitSync(ctx, wt, ['diff', '--name-status', baseSha, '--', '.', ...DIFF_EXCLUDES]);
        // ...plus THIS feature's own progress dir (separate diff — exclude wins).
        if (featureId) {
            try { out += '\n' + gitSync(ctx, wt, ['diff', '--name-status', baseSha, '--', featureOutputPathspec(featureId)]); } catch {}
        }
        // ...plus project-level durable artifacts updated by this feature.
        try { out += '\n' + gitSync(ctx, wt, ['diff', '--name-status', baseSha, '--', PROJECT_MEMORY_PATH]); } catch {}
        try { out += '\n' + gitSync(ctx, wt, ['diff', '--name-status', baseSha, '--', PROJECT_UI_PATH]); } catch {}
        const seen = new Set();
        return out.split('\n').filter(Boolean).map(line => {
            const tabIdx = line.indexOf('\t');
            if (tabIdx < 0) return { status: line.trim(), file: '' };
            return { status: line.slice(0, tabIdx), file: line.slice(tabIdx + 1) };
        }).filter(e => e.file && !seen.has(e.file) && seen.add(e.file));
    }

    function fileDiffCtx(ctx, wt, baseSha, file) {
        registerUntracked(ctx, wt);
        // A specific file (code or the feature's own .output) diffs directly; the
        // full diff excludes seeded/.jonggrang (feature .output shows via file view).
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
        // Device: the worktree lives on the developer's machine, so "is it there?"
        // is only answerable through the mount — try to (re)establish it first.
        // A run resumed after a tunnel drop otherwise reads as "no worktree" and
        // would try to create one that already exists.
        if (ctx.mode === 'device') {
            // Report a failure here rather than swallowing it. A silent one turns
            // "the mount did not come up" into three unrelated-looking errors
            // further down: an empty task list, a missing worktree registry, and
            // finally git complaining that a branch already exists.
            try { tunnel.mountDevice(ctx.device, ctx.wt(info.featureId)); }
            catch (err) { console.error(`device worktree mount (${info.featureId}):`, err.message); }
        }
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
            // Device: the source is this server's project dir (jonggrang's own
            // state, including the redirect bundle) and the destination is the
            // mount — so a plain copy lands on the device. The seeded paths are
            // already excluded from feature commits (SEEDED_PATHS).
            lib.copyToWorktree(project.path, made.hostWorktreePath, COPY_INTO_WORKTREE);
        }
        // Base commit so the diff (vs baseSha) shows ONLY work done in the worktree.
        let effectiveBase = made.baseSha;
        try {
            if (commitWorktreeCtx(ctx, made.worktreePath, `chore: jonggrang workspace for ${info.featureId}`, info.featureId)) {
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

    // Re-seed the feature's task list from MAIN into the worktree at run start.
    // approve/append writes tasks to MAIN's .output/features/<fid>/; a REUSED
    // worktree (created earlier, before an append) would otherwise keep a stale
    // task list and the appended tasks would never appear/run (the dashboard now
    // reads the worktree). Main is authoritative at run start (it holds the approved
    // + appended list plus the previous run's completed snapshot); the worktree
    // then takes over as the live source during the run.
    function seedFeatureFromMain(project, ctx, featureId) {
        const rel = path.join('.jonggrang', '.output', 'features', featureId);
        const wt = ctx.wt(featureId);
        try {
            if (ctx.mode === 'container') {
                containerCopy(ctx, [{ src: `${ctx.root}/${rel}`, dst: `${wt}/${rel}` }]);
            } else {
                lib.copyToWorktree(project.path, ctx.hostWt(featureId), [rel]);
            }
        } catch (err) { console.error('seedFeatureFromMain error:', err.message); }
    }

    // Project settings live in .jonggrang/jonggrang.json and are seeded into a
    // worktree when it is CREATED — so a worktree outlives every later change to
    // them. That made project settings silently not apply: switching Claude to
    // interactive execution, or the pipeline to compact, left an existing plan's
    // worker running with whatever the worktree was born with. Re-seed the file
    // on every run so the dashboard stays the source of truth for settings.
    //
    // Only this one file: the rest of COPY_INTO_WORKTREE (AGENTS.md, hooks,
    // .claude, …) is branch content the agent may legitimately have changed, and
    // re-copying that would clobber its work.
    function seedProjectConfig(project, ctx, featureId) {
        const rel = path.join('.jonggrang', 'jonggrang.json');
        const wt = ctx.wt(featureId);
        try {
            if (ctx.mode === 'container') {
                containerCopy(ctx, [{ src: `${ctx.root}/${rel}`, dst: `${wt}/${rel}` }]);
            } else {
                lib.copyToWorktree(project.path, ctx.hostWt(featureId), [rel]);
            }
        } catch (err) { console.error('seedProjectConfig error:', err.message); }
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

    /**
     * A snapshot records what was true when it was written. If the dashboard was
     * restarted (or crashed) while a group was running, its worker died with it —
     * but the file still says `running`, forever. That is not just cosmetic: the
     * already-running guard then refuses to start the plan again, so a plan whose
     * run was interrupted can never be resumed.
     *
     * There is no live run for this project, so nothing in the snapshot can still
     * be running. Say so.
     */
    function reconcileSnapshot(snap) {
        if (!snap) return snap;
        let touched = false;
        for (const g of snap.groups || []) {
            if (g.status === 'running' || g.status === 'queued') {
                g.status = 'interrupted';
                g.error = g.error || 'the dashboard restarted while this plan was running';
                touched = true;
            }
        }
        if (touched && snap.status === 'running') snap.status = 'interrupted';
        return snap;
    }

    function currentRunView(project) {
        const live = activeRuns.get(project.id);
        if (live) return serializeRun(live);
        return reconcileSnapshot(readSnapshot(project));
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

    /**
     * Running means a process is alive, not that a field says so. A worker that
     * died with its parent leaves `status: running` behind, and trusting that
     * locks the plan out of being started again.
     */
    function groupIsLive(project, fid) {
        const g = activeRuns.get(project.id)?.groups?.[fid];
        if (!g) return false;
        if (g.status !== 'running' && g.status !== 'queued') return false;
        const pid = g.child?.pid;
        if (!pid) return g.status === 'queued';
        try { process.kill(pid, 0); return true; } catch { return false; }
    }

    // Spawn one worktree worker for a plan, in the right context.
    // group.workerArgs lets callers run a single task (`--task`) or resume the
    // pipeline (`--resume`) instead of the default all-group-tasks run.
    function spawnGroupWorker(project, ctx, group) {
        const secretVars = webState.getProjectSecretVars(project.id);
        // Pass the group's featureId explicitly so the worker resolves its feature
        // deterministically instead of guessing from a bare task id (per-feature
        // numbering makes task-001 recur across features).
        const workerArgs = [
            ...(group.workerArgs
                || ['work', '--worktree', '--group-tasks', group.taskIds.join(','), '--branch', group.branch, '--feature', group.featureId]),
            ...(group.extraArgs || []),
        ];

        // Interactive runs mirror their pty to the dashboard under this session
        // key, so the agent's TUI can be watched and typed into live.
        const ptySession = `work:${group.featureId}`;

        if (ctx.mode === 'container') {
            const envFlags = [];
            const env = {
                JONGGRANG_PROJECT_ROOT: group.worktreePath,
                JONGGRANG_MODE: 'autonomous',
                JONGGRANG_PTY_SESSION: ptySession,
                NO_UPDATE_NOTIFIER: '1',
                FORCE_COLOR: '0',
                ...secretVars,
            };
            for (const [k, v] of Object.entries(env)) envFlags.push('--env', `${k}=${v}`);
            const dockerArgs = ['exec', '-i', '--workdir', group.worktreePath, ...envFlags, ctx.container, 'jonggrang', ...workerArgs];
            return spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        }

        const nodeCli = path.join(__dirname, '..', '..', 'bin', 'jonggrang.js');

        // A device project's worker runs HERE, in the mounted worktree — the
        // orchestrator and the agent stay on the server (§2) and only the agent's
        // Bash crosses to the device, via the redirect hook seeded into the
        // worktree. These vars are what make that hook fire, and the prompt is
        // what stops the agent writing GNU syntax for a BSD userland.
        const deviceEnv = {};
        if (ctx.mode === 'device') {
            Object.assign(deviceEnv, tunnel.deviceRedirectEnv(ctx.device, group.worktreePath));
            deviceEnv.JONGGRANG_DEVICE_PROMPT = tunnel.devicePlatformPrompt(
                ctx.device, tunnel.devicePlatform(project.device.device_id), group.worktreePath);
            // The redirect hook comes from the server-side bundle, not from the
            // worktree's .claude — that one is seeded from the project and gets
            // rewritten by `init`, which silently stopped the redirect and ran the
            // agent's commands on the server.
            deviceEnv.JONGGRANG_DEVICE_SETTINGS = tunnel.ensureDeviceHooks(project.path);
        }

        return spawn('node', [nodeCli, ...workerArgs], {
            cwd: group.worktreePath,
            env: {
                ...process.env,
                ...deviceEnv,
                // Override inherited PWD so the agent CLI (opencode resolves its
                // project root from $PWD, not process.cwd()) runs inside the
                // worktree instead of the server's launch dir.
                PWD: group.worktreePath,
                JONGGRANG_HOME,
                JONGGRANG_PROJECT_ROOT: group.worktreePath,
                JONGGRANG_MODE: 'autonomous',
                JONGGRANG_PTY_SESSION: ptySession,
                NO_UPDATE_NOTIFIER: '1',
                FORCE_COLOR: '0',
                ...secretVars,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }

    // Raw terminal scrollback for a plan's live agent session. Bounded, because
    // a TUI repaints constantly — a tab opened mid-run replays this and then
    // follows the socket stream.
    const PTY_SCROLLBACK_MAX = 256 * 1024;

    function pushPtyScrollback(group, text) {
        group.ptyBuffer = (group.ptyBuffer || '') + text;
        if (group.ptyBuffer.length > PTY_SCROLLBACK_MAX) {
            group.ptyBuffer = group.ptyBuffer.slice(-PTY_SCROLLBACK_MAX);
        }
    }

    function groupForSession(projectId, session) {
        const run = activeRuns.get(projectId);
        if (!run || typeof session !== 'string' || !session.startsWith('work:')) return null;
        return run.groups?.[session.slice('work:'.length)] || null;
    }

    function pushLog(group, line) {
        group.logTail = group.logTail || [];
        group.logTail.push(line);
        if (group.logTail.length > LOG_TAIL_MAX) group.logTail.shift();
    }

    // NOTE: the host no longer writes main tasks.json from task_status signals.
    // The worktree worker writes its OWN .output/features/<fid>/jonggrang-tasks.json
    // (the single source of truth); the host only READS it and emits to the UI
    // (see emitFeatureProgress). This removes the dual-writer "tasks disappear" bug.

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
    // Write a file into MAIN's project tree (host fs; falls back to an in-container
    // write when the host copy is root-owned under sandbox).
    function writeMainFile(project, ctx, rel, content) {
        const dst = path.join(project.path, rel);
        try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, content); return; }
        catch (e) { if (ctx.mode !== 'container') throw e; }
        const dstC = path.join(ctx.root, rel);
        execFileSync('docker', ['exec', '-i', ctx.container, 'sh', '-c', `mkdir -p "$(dirname "${dstC}")" && cat > "${dstC}"`], { input: content, maxBuffer: GIT_MAXBUF });
    }

    // MERGE the worktree's task board into main (not overwrite): the worktree holds
    // the live statuses of the tasks it ran, but MAIN may carry tasks APPENDED during
    // the run (append writes to main). Overwriting would wipe those. Keep worktree
    // versions for shared ids and preserve main-only (appended) tasks. Returns true
    // if any preserved appended task is still pending (→ reopen manifest so it runs).
    function snapshotTasksMerged(project, ctx, group) {
        const fid = group.featureId;
        const rel = path.join('.jonggrang', '.output', 'features', fid, 'jonggrang-tasks.json');
        const base = group.hostWorktreePath || group.worktreePath;
        let wt; try { wt = JSON.parse(fs.readFileSync(path.join(base, rel), 'utf8')); } catch { return false; }
        let main; try { main = JSON.parse(fs.readFileSync(path.join(project.path, rel), 'utf8')); } catch { main = { tasks: [] }; }
        const wtIds = new Set((wt.tasks || []).map(t => t.id));
        const appended = (main.tasks || []).filter(t => !wtIds.has(t.id));
        const merged = { ...wt, tasks: (wt.tasks || []).concat(appended) };
        writeMainFile(project, ctx, rel, JSON.stringify(merged, null, 2) + '\n');
        return appended.some(t => t.status !== 'completed' && t.status !== 'skipped');
    }

    // If tasks were appended to main mid-run, the worktree manifest (snapshotted over
    // main) marks execution phases completed — reopen them so `work` runs the appended
    // tasks instead of skipping to post-work.
    function reopenMainManifestIfPending(project, ctx, group) {
        const rel = path.join('.jonggrang', '.output', 'features', group.featureId, 'MANIFEST.yaml');
        try {
            const m = orchestration.readManifest(path.join(project.path, rel));
            if (!m) return;
            let changed = false;
            for (const n of (m.active_phases || [])) {
                if (n >= 8 && m.phases?.[n]?.status === 'completed') { m.phases[n].status = 'pending'; changed = true; }
            }
            if (changed || m.status === 'completed') {
                m.status = 'in_progress'; m.updated_at = new Date().toISOString();
                // Use orchestration.writeManifest (correct serializer, same as approve's
                // reopen). Host write works for host + macOS-sandbox (bind mount); fall
                // back to an in-container write only if the host copy is root-owned.
                try { orchestration.writeManifest(path.join(project.path, rel), m); }
                catch (e) { if (ctx.mode === 'container') writeMainFile(project, ctx, rel, require('js-yaml').dump(m)); else throw e; }
            }
        } catch (err) { console.error('reopenMainManifestIfPending error:', err.message); }
    }

    // ONE-TIME snapshot of the feature's live worktree progress → main, taken when
    // the run ends. The isolated worktree is the source of truth WHILE it runs
    // (dashboard reads it via sandbox.featureOutputDir); this leaves a final copy in
    // main so the dashboard still has state after the worktree is removed. Tasks are
    // MERGED (preserving any tasks appended to main mid-run); the manifest is then
    // reopened if those appended tasks are still pending.
    function snapshotFeatureToMain(project, ctx, group) {
        syncManifest(project, ctx, group);
        syncProgress(project, ctx, group);
        const hasPendingAppended = snapshotTasksMerged(project, ctx, group);
        if (hasPendingAppended) reopenMainManifestIfPending(project, ctx, group);
    }

    // Read the feature's LIVE progress from its worktree and push it to the UI over
    // sockets — READ-ONLY (never writes main), so there is no dual-writer revert.
    // Running feature's tasks come from the worktree (live); other features from main.
    function emitFeatureProgress(project, group) {
        const fid = group.featureId;
        const dir = sandbox.featureOutputDir(project, fid);
        try {
            const others = (lib.getAllTasks(project.path).tasks || []).filter(t => t.feature_id !== fid);
            const live = JSON.parse(fs.readFileSync(path.join(dir, 'jonggrang-tasks.json'), 'utf8')).tasks || [];
            const tasks = others.concat(live.map(t => ({ ...t, feature_id: fid })));
            emit(project.id, 'tasks.update', { tasks });
        } catch { /* tasks file not ready */ }
        try {
            const manifest = orchestration.readManifest(path.join(dir, 'MANIFEST.yaml'));
            if (manifest) emit(project.id, 'manifest.updated', { manifest });
        } catch { /* manifest not ready */ }
        try {
            const content = fs.readFileSync(path.join(dir, 'progress.txt'), 'utf8');
            emit(project.id, 'progress.update', { content });
        } catch { /* no progress log yet */ }
    }

    function wireWorker(project, ctx, run, group) {
        const child = group.child;
        group.pid = child.pid;
        // Live progress: READ the worktree (source of truth) and emit to the UI.
        // No writes to main → no dual-writer revert (the "tasks disappear" bug).
        group.manifestSync = setInterval(() => emitFeatureProgress(project, group), 1500);

        // Device runs need a watchdog. When the tunnel drops the mount answers
        // EIO, and the agent — which now knows enough to say "the device has been
        // unreachable" — sits there retrying a machine that is not coming back, at
        // LLM prices, with the run reporting `running` forever. Measured.
        //
        // Two strikes, not one: a brief drop that autossh reconnects through
        // should not kill a run that is otherwise fine.
        if (ctx.mode === 'device') {
            let misses = 0;
            group.deviceWatch = setInterval(async () => {
                const live = await tunnel.portListening(ctx.device.port);
                if (live) { misses = 0; return; }
                if (++misses < DEVICE_MISSES_BEFORE_STOP) {
                    pushLog(group, `[jonggrang] ${ctx.device.label} unreachable (${misses}/${DEVICE_MISSES_BEFORE_STOP})`);
                    return;
                }
                clearInterval(group.deviceWatch); group.deviceWatch = null;
                group.status = 'cancelled';
                group.error = `${ctx.device.label} went offline — the tunnel dropped mid-run`;
                // The next agent needs to know its predecessor was cut off
                // mid-turn, or it will trust half-finished work as deliberate.
                // It cannot be told now — the device is gone — so remember it and
                // write it into the worktree when the device is back.
                markDeviceInterruption(project, group.featureId, group.error);
                pushLog(group, `[jonggrang] ${group.error}. Stopping so the agent does not retry a machine that is gone.`);
                emit(project.id, 'orchestration.group.log', { feature_id: group.featureId, stream: 'stderr', line: group.error });
                try { group.child?.kill('SIGTERM'); } catch { /* already gone */ }
                // Clear the stale mount so the next start is not handed a
                // directory that answers EIO.
                try { tunnel.unmountDevice(ctx.device, group.worktreePath); } catch { /* nothing to drop */ }
                // The group is terminal; if it was the last one running, the run
                // is too. Otherwise the dashboard shows a run in progress with
                // nothing in it.
                if (!runActive(run)) run.status = 'cancelled';
                persist(project, run);
            }, DEVICE_WATCH_INTERVAL_MS);
        }

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
                    // Worker already wrote its own worktree tasks.json; just refresh
                    // the UI live from that source (read-only, no main write).
                    emitFeatureProgress(project, group);
                    continue;
                }
                // Raw pty bytes from an interactive agent session — relayed to the
                // browser terminal and kept as scrollback for tabs opened later.
                if (signal && signal.type === 'pty_data' && signal.b64) {
                    const text = Buffer.from(signal.b64, 'base64').toString('utf8');
                    markPtyLive(group);
                    pushPtyScrollback(group, text);
                    emit(project.id, 'pty.data', { project_id: project.id, session: signal.session, data: text });
                    continue;
                }
                if (signal && signal.type === 'pty_exit') {
                    group.ptyLive = false;
                    emit(project.id, 'pty.exit', { project_id: project.id, session: signal.session, code: signal.code });
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
            group.ptyLive = false;
            group.finishedAt = new Date().toISOString();
            if (group.manifestSync) { clearInterval(group.manifestSync); group.manifestSync = null; }
            if (group.deviceWatch) { clearInterval(group.deviceWatch); group.deviceWatch = null; }
            // Nothing is using the worktree mount now, and a mount outliving its
            // run is just a hostage to the tunnel's next hiccup.
            if (ctx.mode === 'device') {
                try { tunnel.unmountDevice(ctx.device, group.worktreePath); } catch { /* already gone */ }
            }
            // Decision (b): one-time snapshot of the worktree's final progress → main
            // so the dashboard keeps the last state after the worktree is removed.
            snapshotFeatureToMain(project, ctx, group);
            emitFeatureProgress(project, group); // final UI refresh
            if (code === 0) {
                try {
                    group.committed = commitWorktreeCtx(ctx, group.worktreePath, `feat(${group.featureId}): ${group.title}`, group.featureId);
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
                // "worker exited with code 1" is true and useless when the real
                // story is that the developer's machine went away. The agent gets
                // EIO on every file, gives up, and the user is left reading an
                // exit code. Name the cause while we still can.
                if (ctx.mode === 'device' && !group.error.includes('offline')) {
                    tunnel.portListening(ctx.device.port).then((live) => {
                        if (live) return;
                        group.error = `${ctx.device.label} is offline — the tunnel dropped during this run (worker exited ${code})`;
                        pushLog(group, `[jonggrang] ${group.error}`);
                        emit(project.id, 'orchestration.group.failed', {
                            feature_id: group.featureId, branch: group.branch, error: group.error,
                        });
                        persist(project, run);
                    }).catch(() => { /* keep the exit-code message */ });
                }
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
    // Interruptions are noted on the server because the device is, by definition,
    // unreachable when one happens. `applyDeviceInterruption` is what actually
    // tells the next agent, once the worktree is reachable again.
    // In the server-side bundle dir, NOT under `.jonggrang` — for a device project
    // that path is a symlink onto the device, which is exactly what is
    // unreachable when an interruption happens. First attempt wrote the marker
    // there and it silently went nowhere.
    const interruptionsPath = (project) => path.join(tunnel.deviceBundleDir(project.path), 'interruptions.json');

    function markDeviceInterruption(project, featureId, reason) {
        try {
            const p = interruptionsPath(project);
            let all = {};
            try { all = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* first one */ }
            all[featureId] = { at: new Date().toISOString(), reason };
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(all, null, 2));
        } catch (err) {
            console.error('markDeviceInterruption:', err.message);
        }
    }

    /**
     * Tell the next agent that the previous run was cut off mid-turn, and clean up
     * after it: a task left `in_progress` goes back to `pending` so the queue is
     * honest about what still needs doing.
     *
     * Both writes land in the worktree, which is why this runs at START rather
     * than when the interruption happened — that was the moment the device
     * stopped being writable.
     */
    function applyDeviceInterruption(project, ctx, featureId) {
        const p = interruptionsPath(project);
        let all = {};
        try { all = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return; }
        const note = all[featureId];
        if (!note) return;

        const wt = ctx.hostWt(featureId);
        try {
            const progress = path.join(wt, '.jonggrang', '.output', 'features', featureId, 'progress.txt');
            fs.mkdirSync(path.dirname(progress), { recursive: true });
            fs.appendFileSync(progress, [
                '',
                `## Interrupted run (${note.at})`,
                `The previous session ended mid-turn: ${note.reason}.`,
                'Anything it had started may be half-finished — verify the working tree',
                'against the task before assuming earlier work was deliberate.',
                '',
            ].join('\n'));
        } catch (err) {
            console.error('applyDeviceInterruption progress:', err.message);
        }

        try {
            const tasksFile = path.join(wt, '.jonggrang', '.output', 'features', featureId, 'jonggrang-tasks.json');
            const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
            let touched = false;
            for (const t of data.tasks || []) {
                if (t.status === 'in_progress') { t.status = 'pending'; touched = true; }
            }
            if (touched) fs.writeFileSync(tasksFile, `${JSON.stringify(data, null, 2)}\n`);
        } catch { /* no task file yet, or unreadable — the note is the important half */ }

        delete all[featureId];
        try { fs.writeFileSync(p, JSON.stringify(all, null, 2)); } catch { /* it will be re-applied, harmlessly */ }
    }

    function startGroup(project, ctx, run, g, opts = {}) {
        const wt = ensureWorktree(project, ctx, g);
        // Pull the latest approved/appended task list from main into the worktree
        // so a reused worktree picks up tasks added since it was created.
        seedFeatureFromMain(project, ctx, g.featureId);
        // …and the current project settings, which a long-lived worktree would
        // otherwise keep ignoring (see seedProjectConfig).
        seedProjectConfig(project, ctx, g.featureId);
        // If a previous run on this feature was cut off by its device going away,
        // this is the first moment the worktree can be told about it.
        if (ctx.mode === 'device') applyDeviceInterruption(project, ctx, g.featureId);
        const group = {
            featureId: g.featureId, branch: wt.branch, title: g.title, taskIds: g.taskIds,
            status: 'running', worktreePath: wt.worktreePath, hostWorktreePath: wt.hostWorktreePath,
            baseSha: wt.baseSha,
            startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
            committed: false, pushed: false, error: null, logTail: [],
            workerArgs: opts.workerArgs || null,
            extraArgs: opts.extraArgs || null,
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

    // Per-run pipeline override from the dashboard. `compact: true` stops the
    // worker after Implement (gates deferred, memory still written); `false`
    // forces the full pipeline. Omitted → the project's
    // orchestration.pipeline_mode decides.
    function pipelineFlags(req) {
        const compact = (req.body || {}).compact;
        if (compact === true) return ['--compact'];
        if (compact === false) return ['--full'];
        return [];
    }

    // Keystrokes and resizes from the browser terminal, routed to the worker
    // that owns that plan's pty. The agent keeps driving its own input; this
    // just lets a human type into the same session.
    io.on('connection', (socket) => {
        socket.on('pty.input', ({ project_id, session, data }) => {
            const group = groupForSession(project_id, session);
            if (!group || !data) return;
            sendPtyFrame(group, { type: 'pty_input', b64: Buffer.from(String(data), 'utf8').toString('base64') });
        });

        socket.on('pty.resize', ({ project_id, session, cols, rows }) => {
            const group = groupForSession(project_id, session);
            if (!group || !(cols > 0) || !(rows > 0)) return;
            sendPtyFrame(group, { type: 'pty_resize', cols, rows });
        });
    });

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
        if (groupIsLive(project, fid)) {
            return res.status(409).json({ error: { code: 'GROUP_ALREADY_RUNNING', message: 'This plan is already running' } });
        }

        mountIfDevice(project);
        if (refusedForDeviceTool(project, res)) return;

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
            startGroup(project, ctx, run, g, { extraArgs: pipelineFlags(req) });
        } catch (err) {
            return res.status(500).json({ error: { code: 'WORKTREE_ERROR', message: err.message } });
        }
        persist(project, run);
        emit(project.id, 'orchestration.started', { run: serializeRun(run) });
        res.status(202).json({ run: serializeRun(run) });
    });

    // Shared guard + spawn for the single-task and resume variants below.
    async function startGroupVariant(req, res, buildArgs, fallbackTitle, extraArgs = null) {
        const project = projectOr404(req, res);
        if (!project) return;
        const fid = req.params.featureId;

        if (deps.activeWork?.has(project.id)) {
            return res.status(409).json({ error: { code: 'PROCESS_ALREADY_RUNNING', message: 'A work process is already running' } });
        }
        if (groupIsLive(project, fid)) {
            return res.status(409).json({ error: { code: 'GROUP_ALREADY_RUNNING', message: 'This plan is already running' } });
        }

        mountIfDevice(project);
        if (refusedForDeviceTool(project, res)) return;

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
            startGroup(project, ctx, run, g, { workerArgs, extraArgs: extraArgs || pipelineFlags(req) });
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
    // machine stopped at Implement — either because the worktree run ended
    // there, or because compact mode deferred the gates. `--full` makes sure a
    // project that defaults to compact does not immediately stop again.
    router.post('/:id/orchestration/groups/:featureId/resume', (req, res) => {
        return startGroupVariant(req, res,
            () => ({ args: ['work', '--worktree', '--resume'], title: 'resume pipeline' }),
            'resume pipeline', ['--full']);
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
        const extraArgs = pipelineFlags(req);
        try {
            for (const g of groups) startGroup(project, ctx, run, g, { extraArgs });
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

    // Terminal scrollback for a plan's live agent session — replayed when a tab
    // is opened mid-run, before the socket stream takes over.
    router.get('/:id/orchestration/groups/:featureId/pty', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const group = activeRuns.get(project.id)?.groups?.[req.params.featureId];
        res.json({
            session: `work:${req.params.featureId}`,
            running: !!(group && group.status === 'running'),
            data: group?.ptyBuffer || '',
        });
    });

    router.get('/:id/orchestration/groups/:featureId/diff', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const g = groupView(project, req.params.featureId);
        if (!g) return res.status(404).json({ error: { code: 'GROUP_NOT_FOUND', message: 'No worktree for this plan yet' } });
        const ctx = buildCtx(project);
        try {
            const files = changedFilesCtx(ctx, g.worktree_path, g.base_sha, g.feature_id);
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
                    commitWorktreeCtx(ctx, g.worktree_path, `feat(${g.feature_id}): ${g.title || 'worktree changes'}`, g.feature_id);
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

// The pty relay policy is the fix for a real defect (frames written into a
// headless worker's stdin were read by its next readline prompt), so it is
// unit-tested directly — see test/pty-relay-guard.test.js.
module.exports.ptyRelay = { sendPtyFrame, markPtyLive };
