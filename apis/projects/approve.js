'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { fs, path, webState, spawnForProject, wireProjectProcess } = deps;
    const router = Router();

    router.post('/:id/approve', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const planPath = path.join(project.path, '.jonggrang', 'plan.md');
        if (!fs.existsSync(planPath)) {
            return res.status(422).json({ error: { code: 'PLAN_NOT_FOUND', message: 'No plan.md found. Generate a plan first.' } });
        }

        const child = spawnForProject(project, ['approve']);
        wireProjectProcess(project.id, child, 'approve');
        res.status(202).json({ job_id: project.id });
    });

    return router;
};
