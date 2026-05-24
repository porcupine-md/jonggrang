'use strict';

const { Router } = require('express');
const fs = require('fs');

module.exports = function(deps) {
    const { io, lib, paths, JONGGRANG_HOME, PROJECT_ROOT, state } = deps;
    const router = Router();

    router.post('/init', (req, res) => {
        const options = req.body;
        try {
            const result = lib.runInit(options, JONGGRANG_HOME, PROJECT_ROOT);
            // Re-read state after init and emit updates (mirrors original readConfigFile/readTasks/readProgress)
            try {
                if (lib.fileExists(paths.configFile)) {
                    state.latestConfig = lib.readJSON(paths.configFile);
                    io.emit('config_update', state.latestConfig);
                }
            } catch {}
            try {
                if (lib.fileExists(paths.tasksFile)) {
                    const data = lib.readJSON(paths.tasksFile);
                    if (data) { state.latestTasks = data; io.emit('tasks_update', state.latestTasks); }
                }
            } catch {}
            try {
                if (lib.fileExists(paths.progressFile)) {
                    state.latestProgress = fs.readFileSync(paths.progressFile, 'utf8');
                    io.emit('progress_update', state.latestProgress);
                }
            } catch {}
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/config', (req, res) => {
        if (state.latestConfig) {
            res.json(state.latestConfig);
        } else {
            res.status(404).json({ error: 'No config found' });
        }
    });

    return router;
};
