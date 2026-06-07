'use strict';

// Base/integration branch (main/master) — carries the plan + task + manifest
// state. "Push plans → main" commits that state on the base branch and pushes
// it to origin. All host-side: the main worktree + .git live on the host (even
// for sandbox projects the project dir is bind-mounted), and the host has the
// git credentials. Feature branches are handled separately by orchestration-run.

const { Router } = require('express');
const { execSync } = require('child_process');

const lib = require('../../lib/jonggrang');

module.exports = function (deps) {
    const { webState, io, fs, path } = deps;
    const router = Router();

    const git = (cwd, cmd) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: 'pipe' });

    // Untracked local files that also exist in `ref` block the rebase checkout.
    // Most are jonggrang init scaffolding (.claude/, .codex/, hooks/…) that came
    // back tracked via a merged PR — byte-identical, safe to drop (the checkout
    // restores them tracked). Files whose content differs are returned as
    // blockers so the user resolves them instead of us guessing.
    function clearRedundantUntracked(projectRoot, ref) {
        const untracked = git(projectRoot, 'ls-files --others --exclude-standard')
            .split('\n').filter(Boolean);
        if (!untracked.length) return [];
        const refFiles = new Set(git(projectRoot, `ls-tree -r --name-only "${ref}"`)
            .split('\n').filter(Boolean));
        const blockers = [];
        for (const f of untracked) {
            if (!refFiles.has(f)) continue; // not in ref → checkout won't touch it
            let refSha = '', localSha = '';
            try { refSha = git(projectRoot, `rev-parse "${ref}:${f}"`).trim(); } catch { continue; }
            try { localSha = git(projectRoot, `hash-object -- "${f}"`).trim(); } catch { continue; }
            if (localSha === refSha) {
                try { fs.unlinkSync(path.join(projectRoot, f)); } catch { blockers.push(f); }
            } else {
                blockers.push(f);
            }
        }
        return blockers;
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
        try {
            const branch = lib.resolveBaseBranch(project.path);
            try { git(project.path, `checkout "${branch}"`); } catch {}

            try {
                git(project.path, `fetch origin "${branch}"`);
            } catch (err) {
                const detail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-2).join(' ');
                return res.status(409).json({ error: { code: 'FETCH_FAILED', message: `Fetch origin/${branch} failed. ${detail}` } });
            }

            const before = git(project.path, 'rev-parse HEAD').trim();

            // Identical untracked init-scaffolding files block the rebase checkout.
            const blockers = clearRedundantUntracked(project.path, `origin/${branch}`);
            if (blockers.length) {
                return res.status(409).json({ error: {
                    code: 'UNTRACKED_CONFLICT',
                    message: `Local untracked files differ from origin/${branch}: ` +
                             `${blockers.slice(0, 5).join(', ')}${blockers.length > 5 ? '…' : ''} — resolve manually.`,
                } });
            }

            try {
                git(project.path, `rebase --autostash "origin/${branch}"`);
            } catch (err) {
                try { git(project.path, 'rebase --abort'); } catch {}
                const detail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-3).join(' ');
                return res.status(409).json({ error: {
                    code: 'REBASE_CONFLICT',
                    message: `Rebase onto origin/${branch} failed — resolve manually in a terminal. ${detail}`,
                } });
            }

            const after = git(project.path, 'rev-parse HEAD').trim();
            res.json({ branch, updated: before !== after });
        } catch (err) {
            res.status(500).json({ error: { code: 'BASE_PULL_ERROR', message: err.message } });
        }
    });

    const GIT_IDENTITY = {
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'jonggrang-dev',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'koko@jonggrang.dev',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'jonggrang-dev',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'koko@jonggrang.dev',
    };

    // Commit the current plan/task/manifest state on the base branch, rebase
    // onto the remote (so a moved origin/main never causes a rejected push),
    // then push.
    router.post('/:id/base/push', async (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        if (!lib.hasRemote(project.path)) {
            return res.status(422).json({ error: { code: 'NO_REMOTE', message: 'No "origin" remote configured' } });
        }
        try {
            const branch = lib.resolveBaseBranch(project.path);
            // Make sure we're on the base branch before committing/pushing.
            try { execSync(`git checkout "${branch}"`, { cwd: project.path, stdio: 'pipe' }); } catch { }
            // Commit local state FIRST so the rebase runs on a clean tree.
            const committed = lib.commitBaseState(project.path, 'chore: update plans & tasks');

            // Sync with remote: fetch + rebase local commits on top of origin.
            // A missing remote branch (fresh repo) just skips the rebase.
            let rebased = false;
            let fetched = true;
            try {
                execSync(`git fetch origin "${branch}"`, { cwd: project.path, stdio: 'pipe' });
            } catch { fetched = false; }
            if (fetched) {
                // Identical untracked init-scaffolding files block the rebase
                // checkout once a merged PR makes them tracked — clear them.
                const blockers = clearRedundantUntracked(project.path, `origin/${branch}`);
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
                    execSync(`git rebase --autostash -X theirs "origin/${branch}"`, {
                        cwd: project.path, stdio: 'pipe',
                        env: { ...process.env, ...GIT_IDENTITY },
                    });
                    rebased = true;
                } catch (err) {
                    try { execSync('git rebase --abort', { cwd: project.path, stdio: 'pipe' }); } catch { }
                    const detail = (err.stderr || err.stdout || '').toString().trim().split('\n').slice(-3).join(' ');
                    return res.status(409).json({
                        error: {
                            code: 'REBASE_CONFLICT',
                            message: `Rebase onto origin/${branch} failed — resolve manually in a terminal. ${detail}`,
                        }
                    });
                }
            }

            await lib.pushBranch(project.path, branch);
            io.to(`project:${project.id}`).emit('base.pushed', { project_id: project.id, branch, committed });
            res.json({ branch, committed, rebased, pushed: true });
        } catch (err) {
            res.status(500).json({ error: { code: 'BASE_PUSH_ERROR', message: err.message } });
        }
    });

    return router;
};
