'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { fs, path, webState } = deps;
    const router = Router();

    router.get('/:id/progress', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        const progressPath = path.join(project.path, '.jonggrang', 'progress.txt');
        if (!fs.existsSync(progressPath)) return res.json({ content: '' });
        try {
            res.json({ content: fs.readFileSync(progressPath, 'utf-8') });
        } catch {
            res.json({ content: '' });
        }
    });

    return router;
};
