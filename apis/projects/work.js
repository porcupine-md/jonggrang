'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { webState, activeWork, spawnForProject, wireProjectProcess } = deps;
    const router = Router();

    router.post('/:id/work', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        if (activeWork.has(project.id)) {
            return res.status(409).json({ error: { code: 'PROCESS_ALREADY_RUNNING', message: 'A work process is already running' } });
        }

        const { task_id, resume, compact } = req.body || {};
        const args = ['work'];
        if (resume) args.push('--resume');
        else if (task_id) args.push('--task', task_id);
        // Per-run pipeline override; omitted → orchestration.pipeline_mode decides.
        if (compact === true) args.push('--compact');
        else if (compact === false) args.push('--full');
        const child = spawnForProject(project, args);
        activeWork.set(project.id, child);

        wireProjectProcess(project.id, child, 'work');

        child.on('close', () => activeWork.delete(project.id));
        res.status(202).json({ job_id: project.id });
    });

    router.post('/:id/cancel', (req, res) => {
        const child = activeWork.get(req.params.id);
        if (!child) return res.json({ cancelled: false, message: 'No process running' });
        try {
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
            res.json({ cancelled: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/:id/process', (req, res) => {
        const child = activeWork.get(req.params.id);
        res.json({ running: !!child, pid: child?.pid || null });
    });

    return router;
};
