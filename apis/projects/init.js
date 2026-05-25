'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { io, fs, path, webState, spawnForProject, wireProjectProcess, startProjectWatcher } = deps;
    const router = Router();

    router.post('/:id/init', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        if (!['imported', 'error'].includes(project.init_status)) {
            return res.status(409).json({ error: { code: 'ALREADY_INITIALIZED', message: 'Project not in importable state' } });
        }

        const { type = 'api', stack = 'node-typescript', tool = 'opencode', autonomy = 'autonomous', sandbox } = req.body || {};
        const initArgs = [
            'init', '--force',
            '--name', project.name,
            '--type', type,
            '--stack', stack,
            '--tool', tool,
            '--autonomy', autonomy,
            '--state', fs.existsSync(path.join(project.path, '.git')) ? 'existing' : 'new',
        ];

        if (sandbox?.enabled) {
            webState.updateProject(project.id, { sandbox });
        }
        webState.updateProject(project.id, { init_status: 'initializing' });
        res.status(202).json({ job_id: project.id });

        const child = spawnForProject(project, initArgs);
        wireProjectProcess(project.id, child, 'init');
        child.on('close', (code) => {
            if (code === 0) {
                webState.updateProject(project.id, { init_status: 'ready' });
                io.to(`project:${project.id}`).emit('init.done', { project_id: project.id });
                startProjectWatcher(webState.getProject(project.id));
            } else {
                webState.updateProject(project.id, { init_status: 'error', init_error: `Exit code ${code}` });
            }
        });
    });

    return router;
};
