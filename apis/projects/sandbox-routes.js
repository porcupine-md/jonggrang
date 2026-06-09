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
        // Reuse a running container only if its SSH-key mount still matches the
        // resolved key. If the key changed after the container was created, fall
        // through to recreate it (Docker can't remount on start/restart).
        if (running && !sandbox.sshMountDrifted(project.id)) {
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

            // Reconcile an existing container against the current config. Reuse it
            // only if BOTH the image and the SSH-key mount still match — otherwise
            // remove it and create a fresh one (mounts are fixed at `docker run`
            // time, so a changed image OR a changed key both need a recreate).
            const containerStatus = await sandbox.exists(project.id);
            if (containerStatus) {
                const runningImage = await sandbox.getContainerImage(project.id);
                const drifted = runningImage !== configuredImage || sandbox.sshMountDrifted(project.id);
                if (!drifted) {
                    if (containerStatus !== 'running') await sandbox.startExisting(project.id);
                    startingSet.delete(project.id);
                    io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'running' });
                    return;
                }
                // Image or key/mount config changed — recreate with current config.
                await sandbox.remove(project.id);
            }
            // Recreating gives the container a fresh published editor port and
            // kills the old openvscode process — drop the stale cached target.
            deps.dropEditor?.(project.id);
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
            // restart kills the in-container openvscode process (it was started
            // via `docker exec -d`, not part of the container's main process).
            deps.dropEditor?.(project.id);
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
            // Rebuild recreates the container — fresh editor port, dead old
            // openvscode process. Invalidate the cached editor target.
            deps.dropEditor?.(project.id);
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
            deps.dropEditor?.(project.id);
            await sandbox.stop(project.id);
            io.to(`project:${project.id}`).emit('sandbox.status', { project_id: project.id, status: 'stopped' });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
