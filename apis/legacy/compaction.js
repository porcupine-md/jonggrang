'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { compaction, PROJECT_ROOT } = deps;
    const router = Router();

    router.get('/compaction', (req, res) => {
        try {
            const state = compaction.refreshCompactionState(PROJECT_ROOT);
            res.json(state);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
