'use strict';

// Base/integration branch (main/master) — carries the plan + task + manifest
// state. "Push plans → main" commits that state on the base branch and pushes
// it to origin. All host-side: the main worktree + .git live on the host (even
// for sandbox projects the project dir is bind-mounted), and the host has the
// git credentials. Feature branches are handled separately by orchestration-run.

const { Router } = require('express');
const { execSync } = require('child_process');

const lib = require('../../lib/jonggrang');

module.exports = function(deps) {
    const { webState, io } = deps;
    const router = Router();

    // Base branch info for the UI.
    router.get('/:id/base', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
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

    // Commit the current plan/task/manifest state on the base branch and push it.
    router.post('/:id/base/push', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        if (!lib.hasRemote(project.path)) {
            return res.status(422).json({ error: { code: 'NO_REMOTE', message: 'No "origin" remote configured' } });
        }
        try {
            const branch = lib.resolveBaseBranch(project.path);
            // Make sure we're on the base branch before committing/pushing.
            try { execSync(`git checkout "${branch}"`, { cwd: project.path, stdio: 'pipe' }); } catch {}
            const committed = lib.commitBaseState(project.path, 'chore: update plans & tasks');
            await lib.pushBranch(project.path, branch);
            io.to(`project:${project.id}`).emit('base.pushed', { project_id: project.id, branch, committed });
            res.json({ branch, committed, pushed: true });
        } catch (err) {
            res.status(500).json({ error: { code: 'BASE_PUSH_ERROR', message: err.message } });
        }
    });

    return router;
};
