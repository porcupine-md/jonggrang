'use strict';

const { Router } = require('express');
const fs = require('fs');

module.exports = function(deps) {
    const { io, lib, paths, spawnJonggrang, emitPlanUpdate } = deps;
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

    router.get('/plan/content', (req, res) => {
        if (!lib.fileExists(paths.planFile)) {
            return res.json({ exists: false, content: '' });
        }
        try {
            const content = fs.readFileSync(paths.planFile, 'utf8');
            res.json({ exists: true, content });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.put('/plan/content', (req, res) => {
        const { content } = req.body;
        if (content === undefined) return res.status(400).json({ error: 'content required' });
        try {
            fs.writeFileSync(paths.planFile, content, 'utf8');
            emitPlanUpdate();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/plan/content', (req, res) => {
        try {
            if (lib.fileExists(paths.planFile)) fs.unlinkSync(paths.planFile);
            emitPlanUpdate();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
