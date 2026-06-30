'use strict';

const { Router } = require('express');

const lib = require('../../lib/jonggrang');

module.exports = function(deps) {
    const { webState } = deps;
    const router = Router();

    router.get('/:id/tasks', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });

        try {
            const { tasks, error } = webState.readAllFeatureTasks(project.path);
            if (error) return res.status(500).json({ error: error.message });
            let taskList = tasks || [];
            // Optional per-plan scope (Work Mode kanban).
            const { feature_id } = req.query;
            if (feature_id) taskList = taskList.filter(t => t.feature_id === feature_id);
            res.json({ tasks: taskList });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
