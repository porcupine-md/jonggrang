'use strict';

const { Router } = require('express');

module.exports = function(deps) {
    const { state, groupProcesses, PROJECT_ROOT } = deps;
    const router = Router();

    router.get('/status', (req, res) => {
        const groups = Array.from(groupProcesses.entries()).map(([id, g]) => ({
            id, status: g.status, branch: g.branch, taskIds: g.taskIds,
        }));
        res.json({
            isRunning: state.isJonggrangRunning,
            mode: groupProcesses.size > 0 ? 'parallel' : 'sequential',
            projectRoot: PROJECT_ROOT,
            config: state.latestConfig,
            tasks: state.latestTasks,
            progress: state.latestProgress,
            groups,
        });
    });

    return router;
};
