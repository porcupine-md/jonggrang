'use strict';

// Base/integration branch (main/master) — carries the plan + task + manifest
// state. "Push plans → main" commits that state on the base branch and pushes
// it to origin.
//
// Execution context follows the project: a HOST project runs git on the host;
// a SANDBOX project runs every mutating/network git op (checkout, fetch,
// rebase, commit, push, and the untracked-file cleanup) INSIDE its container
// via `docker exec` — sandbox work stays fully sandboxed, using the container's
// git + mounted SSH key, never the host's credentials. The project dir is
// bind-mounted, so it's the same repo either way; only the executor differs.
// Read-only status (GET /base) stays on the host so it works with the container
// stopped. Feature branches are handled separately by orchestration-run.

const { Router } = require('express');

const lib = require('../../lib/jonggrang');
const sandboxGit = require('../../lib/sandbox-git');

module.exports = function (deps) {
    const { webState, io } = deps;
    const router = Router();

    // Untracked local files that also exist in `ref` block the rebase checkout.
    // Most are jonggrang init scaffolding (.claude/, .codex/, hooks/…) that came
    // back tracked via a merged PR — byte-identical, safe to drop (the checkout
    // restores them tracked). Files whose content differs are returned as
    // blockers so the user resolves them instead of us guessing. Runs in `ctx`.
    function clearRedundantUntracked(ctx, ref) {
        const untracked = sandboxGit.gitShell(ctx, 'ls-files --others --exclude-standard')
            .split('\n').filter(Boolean);
        if (!untracked.length) return [];
        const refFiles = new Set(sandboxGit.gitShell(ctx, `ls-tree -r --name-only "${ref}"`)
            .split('\n').filter(Boolean));
        const blockers = [];
        for (const f of untracked) {
            if (!refFiles.has(f)) continue; // not in ref → checkout won't touch it
            let refSha = '', localSha = '';
            try { refSha = sandboxGit.gitShell(ctx, `rev-parse "${ref}:${f}"`).trim(); } catch { continue; }
            try { localSha = sandboxGit.gitShell(ctx, `hash-object -- "${f}"`).trim(); } catch { continue; }
            if (localSha === refSha) {
                try { sandboxGit.shCmd(ctx, `rm -f -- "${f}"`); } catch { blockers.push(f); }
            } else {
                blockers.push(f);
            }
        }
        return blockers;
    }

    const GIT_IDENTITY = {
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'jonggrang-dev',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'koko@jonggrang.dev',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'jonggrang-dev',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'koko@jonggrang.dev',
    };

    // Commit the current plan/task/manifest state on the base branch, in `ctx`.
    // Mirrors lib.commitBaseState but runs through the sandbox when applicable.
    // Returns true if a commit was made, false if there was nothing to commit.
    function commitBaseStateCtx(ctx) {
        for (const p of lib.BASE_STATE_PATHS) {
            try { sandboxGit.gitShell(ctx, `add -- "${p}"`); } catch { /* path may not exist */ }
        }
        const pathArgs = lib.BASE_STATE_PATHS.map(p => `"${p}"`).join(' ');
        const staged = sandboxGit.gitShell(ctx, `diff --cached --name-only -- ${pathArgs}`).trim();
        if (!staged) return false;
        sandboxGit.gitShell(ctx, `commit -m "chore: update plans & tasks" -m "${lib.COAUTHOR_TRAILER}"`,
            { env: GIT_IDENTITY });
        return true;
    }

    // Container projects: bring the sandbox up + prep git before touching the repo.
    async function ensureCtxReady(project, ctx, res) {
        if (ctx.mode !== 'container') return true;
        try {
            await sandboxGit.ensureContainerRunning(project, (id) => webState.getProjectSecretVars(id));
        } catch (err) {
            res.status(409).json({ error: { code: 'SANDBOX_NOT_RUNNING', message: `Docker sandbox is not running: ${err.message}` } });
            return false;
        }
        sandboxGit.prepareContainerGit(ctx);
        return true;
    }

    function projectOr404(req, res) {
        const project = webState.getProject(req.params.id);
        if (!project) res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        return project;
    }

    router.get('/:id/base', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        try {
            // Read-only status: host reads of the bind-mounted repo (works with
            // the container stopped). Identical regardless of execution context.
            const branch = lib.resolveBaseBranch(project.path);
            res.json({
                branch,
                has_remote: lib.hasRemote(project.path),
                dirty: lib.baseStateDirty(project.path),
            });
        } catch (err) {
            res.status(500).json({ error: { code: 'BASE_ERROR', message: err.message } });
        }
    });

    // Pull the remote base branch into local — fetch + rebase only. Does NOT
    // commit local state (the user commits themselves). Uncommitted local
    // changes are preserved via --autostash.
    router.post('/:id/base/pull', async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        if (!lib.hasRemote(project.path)) {
            return res.status(422).json({ error: { code: 'NO_REMOTE', message: 'No "origin" remote configured' } });
        }
        const ctx = sandboxGit.mainRepoCtx(project);
        if (!await ensureCtxReady(project, ctx, res)) return;
        try {
            const branch = lib.resolveBaseBranch(project.path);
            try { sandboxGit.gitShell(ctx, `checkout "${branch}"`); } catch {}

            try {
                sandboxGit.gitShell(ctx, `fetch origin "${branch}"`);
            } catch (err) {
                const detail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-2).join(' ');
                return res.status(409).json({ error: { code: 'FETCH_FAILED', message: `Fetch origin/${branch} failed. ${detail}` } });
            }

            const before = sandboxGit.gitShell(ctx, 'rev-parse HEAD').trim();

            // Identical untracked init-scaffolding files block the rebase checkout.
            const blockers = clearRedundantUntracked(ctx, `origin/${branch}`);
            if (blockers.length) {
                return res.status(409).json({ error: {
                    code: 'UNTRACKED_CONFLICT',
                    message: `Local untracked files differ from origin/${branch}: ` +
                             `${blockers.slice(0, 5).join(', ')}${blockers.length > 5 ? '…' : ''} — resolve manually.`,
                } });
            }

            try {
                sandboxGit.gitShell(ctx, `rebase --autostash "origin/${branch}"`);
            } catch (err) {
                try { sandboxGit.gitShell(ctx, 'rebase --abort'); } catch {}
                const detail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-3).join(' ');
                return res.status(409).json({ error: {
                    code: 'REBASE_CONFLICT',
                    message: `Rebase onto origin/${branch} failed — resolve manually in a terminal. ${detail}`,
                } });
            }

            const after = sandboxGit.gitShell(ctx, 'rev-parse HEAD').trim();
            res.json({ branch, updated: before !== after });
        } catch (err) {
            res.status(500).json({ error: { code: 'BASE_PULL_ERROR', message: err.message } });
        }
    });

    // Commit the current plan/task/manifest state on the base branch, rebase
    // onto the remote (so a moved origin/main never causes a rejected push),
    // then push.
    router.post('/:id/base/push', async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        if (!lib.hasRemote(project.path)) {
            return res.status(422).json({ error: { code: 'NO_REMOTE', message: 'No "origin" remote configured' } });
        }
        const ctx = sandboxGit.mainRepoCtx(project);
        if (!await ensureCtxReady(project, ctx, res)) return;
        try {
            const branch = lib.resolveBaseBranch(project.path);
            // Make sure we're on the base branch before committing/pushing.
            try { sandboxGit.gitShell(ctx, `checkout "${branch}"`); } catch { }
            // Commit local state FIRST so the rebase runs on a clean tree.
            const committed = commitBaseStateCtx(ctx);

            // Sync with remote: fetch + rebase local commits on top of origin.
            // A missing remote branch (fresh repo) just skips the rebase.
            let rebased = false;
            let fetched = true;
            try {
                sandboxGit.gitShell(ctx, `fetch origin "${branch}"`);
            } catch { fetched = false; }
            if (fetched) {
                // Identical untracked init-scaffolding files block the rebase
                // checkout once a merged PR makes them tracked — clear them.
                const blockers = clearRedundantUntracked(ctx, `origin/${branch}`);
                if (blockers.length) {
                    return res.status(409).json({
                        error: {
                            code: 'UNTRACKED_CONFLICT',
                            message: `Local untracked files differ from origin/${branch}: ` +
                                `${blockers.slice(0, 5).join(', ')}${blockers.length > 5 ? '…' : ''} — resolve manually.`,
                        }
                    });
                }
                try {
                    // -X theirs: replayed commits win on conflict. Local commits
                    // here only touch .jonggrang state paths (commitBaseState),
                    // and for those the project's local state is canonical —
                    // merged PRs carry stale worktree snapshots of the same files.
                    sandboxGit.gitShell(ctx, `rebase --autostash -X theirs "origin/${branch}"`, { env: GIT_IDENTITY });
                    rebased = true;
                } catch (err) {
                    try { sandboxGit.gitShell(ctx, 'rebase --abort'); } catch { }
                    const detail = (err.stderr || err.stdout || '').toString().trim().split('\n').slice(-3).join(' ');
                    return res.status(409).json({
                        error: {
                            code: 'REBASE_CONFLICT',
                            message: `Rebase onto origin/${branch} failed — resolve manually in a terminal. ${detail}`,
                        }
                    });
                }
            }

            await sandboxGit.pushBranch(ctx, branch);
            io.to(`project:${project.id}`).emit('base.pushed', { project_id: project.id, branch, committed });
            res.json({ branch, committed, rebased, pushed: true });
        } catch (err) {
            res.status(500).json({ error: { code: 'BASE_PUSH_ERROR', message: err.message } });
        }
    });

    return router;
};
