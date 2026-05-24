'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { io, lib, paths, spawnJonggrang, emitPlanUpdate } = deps;
    const router = Router();

    router.post('/approve', (req, res) => {
        if (!lib.fileExists(paths.planFile)) {
            return res.status(400).json({ error: 'No pending plan.md found. Run plan first.' });
        }

        const args = ['approve'];
        console.log('Starting jonggrang approve (Phase 2)...');

        const child = spawnJonggrang(args, { JONGGRANG_MODE: 'autonomous' });

        io.emit('log', 'Approving plan — decomposing to tasks...\n');

        child.stdout.on('data', (data) => io.emit('log', data.toString()));
        child.stderr.on('data', (data) => io.emit('log', data.toString()));
        child.on('close', (code) => {
            io.emit('log', `\nApprove phase 2 exited with code ${code}\n`);
            emitPlanUpdate();
        });

        res.json({ success: true, message: 'Approve started' });
    });

    return router;
};
