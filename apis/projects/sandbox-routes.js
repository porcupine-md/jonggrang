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
            return res.status(202).json({ job_id: project.id, status: 'starting' });
        }

        startingSet.add(project.id);
        const running = await sandbox.isRunning(project.id);
        if (running) {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
            return res.json({ ok: true, status: 'running' });
        }

        io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'starting' });
        res.status(202).json({ job_id: project.id, status: 'starting' });

        try {
            const secretVars = webState.getProjectSecretVars(project.id);
            const globalConfig = webState.getSandboxConfig();
            const sandboxConfig = {
                image: project.sandbox?.image || globalConfig.image,
                shell: project.sandbox?.shell || globalConfig.shell,
                volumes: [...webState.getVolumes(), ...(project.sandbox?.volumes || [])],
                network: project.sandbox?.network || globalConfig.network,
            };
            const configuredImage = sandboxConfig.image || sandbox.DEFAULT_AGENT_IMAGE;

            // If container exists (stopped) → reuse it only if the image hasn't changed.
            // If the image changed, remove the old container so it gets recreated with the new one.
            const containerStatus = await sandbox.exists(project.id);
            if (containerStatus === 'exited' || containerStatus === 'created') {
                const runningImage = await sandbox.getContainerImage(project.id);
                if (runningImage === configuredImage) {
                    await sandbox.startExisting(project.id);
                    startingSet.delete(project.id);
                    io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
                    return;
                }
                // Image changed — remove old container and fall through to create a new one
                await sandbox.remove(project.id);
            }
            await sandbox.start(project, sandboxConfig, secretVars, (line) => {
                io.to(`project:${project.id}`).emit('sandbox.log', { project_id: project.id, line });
            });
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
        } catch (err) {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'error', message: err.message });
        }
    });

    router.post('/:id/sandbox/restart', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        if (!project.sandbox?.enabled) return res.status(400).json({ error: 'SANDBOX_DISABLED' });

        if (startingSet.has(project.id)) return res.status(202).json({ job_id: project.id, status: 'starting' });

        startingSet.add(project.id);
        io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'starting' });
        res.status(202).json({ job_id: project.id, status: 'starting' });

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

        if (startingSet.has(project.id)) return res.status(202).json({ job_id: project.id, status: 'starting' });

        startingSet.add(project.id);
        io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'starting' });
        res.status(202).json({ job_id: project.id, status: 'starting' });

        try {
            await sandbox.remove(project.id);
            const secretVars = webState.getProjectSecretVars(project.id);
            const globalConfig = webState.getSandboxConfig();
            const sandboxConfig = {
                image: project.sandbox?.image || globalConfig.image,
                shell: project.sandbox?.shell || globalConfig.shell,
                volumes: [...webState.getVolumes(), ...(project.sandbox?.volumes || [])],
                network: project.sandbox?.network || globalConfig.network,
            };
            await sandbox.start(project, sandboxConfig, secretVars, (line) => {
                io.to(`project:${project.id}`).emit('sandbox.log', { project_id: project.id, line });
            });
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
        } catch (err) {
            startingSet.delete(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'error', message: err.message });
        }
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
