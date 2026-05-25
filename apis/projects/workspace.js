'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { webState } = deps;
    const router = Router();

    router.get('/workspace', (req, res) => {
        try {
            const workspace_path = webState.getWorkspacePath();
            const projects = webState.listProjects();
            res.json({ path: workspace_path, project_count: projects.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.patch('/workspace', (req, res) => {
        const { path: newPath } = req.body || {};
        if (!newPath) return res.status(400).json({ error: 'path required' });
        try {
            const resolved = webState.setWorkspacePath(newPath);
            res.json({ path: resolved });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/settings/sandbox', (req, res) => {
        res.json(webState.getSandboxConfig());
    });

    router.put('/settings/sandbox', (req, res) => {
        const { image, shell } = req.body || {};
        try {
            const config = webState.setSandboxConfig({ image, shell });
            res.json(config);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
