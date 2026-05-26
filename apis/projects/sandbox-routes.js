'use strict';

const { Router } = require('express');
const sandbox = require('../../lib/sandbox');

// Track in-progress starts to avoid duplicate starts
const startingSet = new Set();

module.exports = function(deps) {
    const { io, webState } = deps;
    const router = Router();

    router.get('/:id/sandbox/status', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        if (!project.sandbox?.enabled) return res.json({ status: 'disabled' });

        try {
            const running = await sandbox.isRunning(project.id);
            const starting = startingSet.has(project.id);
            const status = starting ? 'starting' : running ? 'running' : 'stopped';
            res.json({ status, container: sandbox.getContainerName(project.id) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/:id/sandbox/start', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        if (!project.sandbox?.enabled) return res.status(400).json({ error: 'SANDBOX_DISABLED' });

        if (startingSet.has(project.id)) {
            return res.json({ ok: true, status: 'starting' });
        }

        startingSet.add(project.id);
        const running = await sandbox.isRunning(project.id);
        if (running) {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
            return res.json({ ok: true, status: 'running' });
        }

        io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'starting' });
        res.json({ ok: true, status: 'starting' });

        // If container exists (stopped) → docker start, otherwise full docker run
        const containerStatus = await sandbox.exists(project.id);
        if (containerStatus === 'exited' || containerStatus === 'created') {
            sandbox.startExisting(project.id).then(() => {
                startingSet.delete(project.id);
                io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
            }).catch((err) => {
                startingSet.delete(project.id);
                io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'error', message: err.message });
            });
            return;
        }

        const secretVars = webState.getProjectSecretVars(project.id);
        const globalConfig = webState.getSandboxConfig();
        const sandboxConfig = {
            image: project.sandbox?.image || globalConfig.image,
            shell: project.sandbox?.shell || globalConfig.shell,
        };
        sandbox.start(project, sandboxConfig, secretVars, (line) => {
            io.to(`project:${project.id}`).emit('sandbox.log', { project_id: project.id, line });
        }).then(() => {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
        }).catch((err) => {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'error', message: err.message });
        });
    });

    router.post('/:id/sandbox/restart', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        if (!project.sandbox?.enabled) return res.status(400).json({ error: 'SANDBOX_DISABLED' });

        if (startingSet.has(project.id)) return res.json({ ok: true, status: 'starting' });

        startingSet.add(project.id);
        io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'starting' });
        res.json({ ok: true, status: 'starting' });

        try {
            await sandbox.restart(project.id);
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
        } catch (err) {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'error', message: err.message });
        }
    });

    router.post('/:id/sandbox/rebuild', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        if (!project.sandbox?.enabled) return res.status(400).json({ error: 'SANDBOX_DISABLED' });

        if (startingSet.has(project.id)) return res.json({ ok: true, status: 'starting' });

        startingSet.add(project.id);
        io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'starting' });
        res.json({ ok: true, status: 'starting' });

        await sandbox.remove(project.id);

        const secretVars = webState.getProjectSecretVars(project.id);
        const globalConfig = webState.getSandboxConfig();
        const sandboxConfig = {
            image: project.sandbox?.image || globalConfig.image,
            shell: project.sandbox?.shell || globalConfig.shell,
        };
        sandbox.start(project, sandboxConfig, secretVars, (line) => {
            io.to(`project:${project.id}`).emit('sandbox.log', { project_id: project.id, line });
        }).then(() => {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
        }).catch((err) => {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'error', message: err.message });
        });
    });

    router.post('/:id/sandbox/stop', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

        try {
            await sandbox.stop(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'stopped' });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
