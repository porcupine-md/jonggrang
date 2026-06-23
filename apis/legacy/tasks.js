'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { lib, PROJECT_ROOT } = deps;
    const router = Router();

    router.get('/tasks', (req, res) => {
        const data = lib.getAllTasks(PROJECT_ROOT);
        res.json(data);
    });

    router.get('/tasks/:id', (req, res) => {
        const all = lib.getAllTasks(PROJECT_ROOT);
        const task = all.tasks.find(t => t.id === req.params.id) || null;
        if (!task) return res.status(404).json({ error: 'Task not found' });
        res.json(task);
    });

    return router;
};
