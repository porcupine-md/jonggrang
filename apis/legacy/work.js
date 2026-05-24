'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { io, state, spawnJonggrang } = deps;
    const router = Router();

    router.post('/start', (req, res) => {
        if (state.isJonggrangRunning) {
            return res.status(400).json({ error: 'Jonggrang is already running' });
        }

        const { taskId, mode, tool, description } = req.body || {};
        const args = ['work'];
        if (description) args.push(description);
        if (taskId) args.push('--task', taskId);
        if (mode) args.push('--mode', mode);
        if (tool) args.push('--tool', tool);

        console.log('Starting jonggrang work...', args);
        state.jonggrangProcess = spawnJonggrang(args, { JONGGRANG_MODE: mode || 'autonomous' });

        state.isJonggrangRunning = true;
        io.emit('jonggrang_status', { isRunning: true });
        io.emit('log', 'Jonggrang started...\n');

        state.jonggrangProcess.stdout.on('data', (data) => {
            io.emit('log', data.toString());
        });

        state.jonggrangProcess.stderr.on('data', (data) => {
            io.emit('log', data.toString());
        });

        state.jonggrangProcess.on('close', (code) => {
            state.isJonggrangRunning = false;
            state.jonggrangProcess = null;
            io.emit('jonggrang_status', { isRunning: false });
            io.emit('log', `\nJonggrang process exited with code ${code}\n`);
        });

        res.json({ success: true, message: 'Jonggrang started' });
    });

    router.post('/stop', (req, res) => {
        if (!state.isJonggrangRunning || !state.jonggrangProcess) {
            return res.status(400).json({ error: 'Jonggrang is not running' });
        }

        console.log('Stopping jonggrang...');
        state.jonggrangProcess.kill('SIGINT');

        res.json({ success: true, message: 'Jonggrang stop signal sent' });
    });

    return router;
};
