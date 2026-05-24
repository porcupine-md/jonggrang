'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { feedback, PROJECT_ROOT } = deps;
    const router = Router();

    router.get('/feedback-state', (req, res) => {
        try {
            const state = feedback.readFeedbackState(PROJECT_ROOT);
            res.json(state);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/feedback-state/record', (req, res) => {
        const { domain, phase, status, agent } = req.body || {};
        if (!domain || !phase || !status) {
            return res.status(400).json({ error: 'domain, phase, status required' });
        }
        try {
            const { state, allPassed } = feedback.recordPhaseResult(PROJECT_ROOT, domain, phase, status, agent);
            res.json({ state, allPassed });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/feedback-state', (req, res) => {
        try {
            feedback.clearFeedbackState(PROJECT_ROOT);
            res.json({ cleared: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
