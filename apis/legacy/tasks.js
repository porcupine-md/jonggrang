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

    router.patch('/tasks/:id', (req, res) => {
        const { status } = req.body;
        if (!status) return res.status(400).json({ error: 'status required' });

        if (status === 'completed') {
            lib.markTaskDone(paths.tasksFile, req.params.id);
        } else {
            lib.updateTaskStatus(paths.tasksFile, req.params.id, status);
        }
        res.json({ success: true });
    });

    router.post('/tasks', (req, res) => {
        const { title, description, priority, skill, blocked_by } = req.body;
        if (!title) return res.status(400).json({ error: 'title required' });

        const data = lib.getTasks(paths.tasksFile);
        const maxId = data.tasks.reduce((max, t) => {
            const num = parseInt(t.id.replace('task-', ''), 10);
            return num > max ? num : max;
        }, 0);
        const newId = `task-${String(maxId + 1).padStart(3, '0')}`;

        data.tasks.push({
            id: newId,
            title,
            description: description || title,
            priority: priority || data.tasks.length + 1,
            status: 'pending',
            owner: null,
            skill: skill || null,
            skill_inputs: {},
            files: [],
            blocked_by: blocked_by || [],
            passes: false,
            retry_count: 0,
            started_at: null,
            completed_at: null,
            error_log: [],
        });
        lib.writeJSON(paths.tasksFile, data);
        res.json({ success: true, id: newId });
    });

    router.delete('/tasks/:id', (req, res) => {
        const data = lib.getTasks(paths.tasksFile);
        const idx = data.tasks.findIndex(t => t.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Task not found' });
        if (data.tasks[idx].status === 'completed') {
            return res.status(400).json({ error: 'Cannot delete completed task' });
        }
        data.tasks.splice(idx, 1);
        lib.writeJSON(paths.tasksFile, data);
        res.json({ success: true });
    });

    return router;
};
