'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { lib, paths } = deps;
    const router = Router();

    router.get('/tasks', (req, res) => {
        const data = lib.getTasks(paths.tasksFile);
        res.json(data);
    });

    router.get('/tasks/:id', (req, res) => {
        const task = lib.getTask(paths.tasksFile, req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        res.json(task);
    });

    return router;
};
