'use strict';

const { Router } = require('express');
const lib = require('../../lib/jonggrang');

module.exports = function (deps) {
    const { fs, webState, spawnForProject, wireProjectProcess, activePlan } = deps;
    const router = Router();

    router.post('/:id/approve', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        try { lib.migrateLegacyPlanDraft(project.path); } catch { }
        const requestedSession = (req.body && (req.body.sessionId || req.body.session))
            || (req.query && (req.query.sessionId || req.query.session))
            || '';
        const drafts = lib.getAllDrafts(project.path);
        const draft = requestedSession
            ? drafts.find(d => d.sessionId === requestedSession)
            : drafts[0];
        if (!draft || !fs.existsSync(draft.planPath)) {
            return res.status(422).json({ error: { code: 'PLAN_NOT_FOUND', message: 'No draft plan found. Generate a plan first.' } });
        }

        const child = spawnForProject(project, ['approve', '--session', draft.sessionId]);
        wireProjectProcess(project.id, child, 'approve');
        activePlan.set(project.id, { child, command: 'approve' });
        child.on('close', () => activePlan.delete(project.id));
        res.status(202).json({ job_id: project.id });
    });

    return router;
};
