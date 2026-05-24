'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { fs, path, webState } = deps;
    const router = Router();

    router.get('/:id/tasks', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        const tasksPath = path.join(project.path, '.jonggrang', 'jonggrang-tasks.json');
        if (!fs.existsSync(tasksPath)) return res.json({ tasks: [] });
        try {
            const data = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
            res.json({ tasks: data.tasks || [] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
