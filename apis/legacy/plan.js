'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { io, paths, spawnJonggrang } = deps;
    const router = Router();

    router.post('/plan', (req, res) => {
        const { description } = req.body;
        if (!description) return res.status(400).json({ error: 'description required' });

        const args = ['plan', description];
        console.log('Starting jonggrang plan (Phase 1)...', args);

        const child = spawnJonggrang(args, { JONGGRANG_MODE: 'autonomous' });

        io.emit('log', `Planning: ${description}\n`);

        child.stdout.on('data', (data) => io.emit('log', data.toString()));
        child.stderr.on('data', (data) => io.emit('log', data.toString()));
        child.on('close', (code) => {
            io.emit('log', `\nPlan phase 1 exited with code ${code}\n`);
            emitPlanUpdate();
        });

        res.json({ success: true, message: 'Plan Phase 1 started' });
    });

    return router;
};
