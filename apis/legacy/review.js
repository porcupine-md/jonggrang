'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { io, spawnJonggrang } = deps;
    const router = Router();

    router.post('/review', (req, res) => {
        const child = spawnJonggrang(['review'], { JONGGRANG_MODE: 'autonomous' });

        io.emit('log', 'Starting review...\n');

        child.stdout.on('data', (data) => io.emit('log', data.toString()));
        child.stderr.on('data', (data) => io.emit('log', data.toString()));
        child.on('close', (code) => {
            io.emit('log', `\nReview process exited with code ${code}\n`);
        });

        res.json({ success: true, message: 'Review started' });
    });

    return router;
};
