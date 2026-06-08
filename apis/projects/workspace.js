'use strict';

const { Router } = require('express');
const fs = require('fs');
const sandbox = require('../../lib/sandbox');

module.exports = function(deps) {
    const { webState } = deps;
    const router = Router();

    router.get('/workspace', (req, res) => {
        try {
            const workspace_path = webState.getWorkspacePath();
            const projects = webState.listProjects();
            res.json({ path: workspace_path, project_count: projects.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.patch('/workspace', (req, res) => {
        const { path: newPath } = req.body || {};
        if (!newPath) return res.status(400).json({ error: 'path required' });
        try {
            const resolved = webState.setWorkspacePath(newPath);
            res.json({ path: resolved });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/settings/sandbox', (req, res) => {
        const config = webState.getSandboxConfig();
        res.json({ ...config, volumes: webState.getVolumes() });
    });

    router.put('/settings/sandbox', (req, res) => {
        const { image, shell, volumes } = req.body || {};
        try {
            const patch = {};
            if (image !== undefined) patch.image = image;
            if (shell !== undefined) patch.shell = shell;
            const config = webState.setSandboxConfig(patch);
            if (Array.isArray(volumes)) webState.setVolumes(volumes);
            res.json({ ...config, volumes: webState.getVolumes() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Global SSH key for in-container git push ─────────────────
    // Used when a project has no per-project key. GET never returns the key.
    router.get('/settings/ssh-key', (req, res) => {
        res.json(sandbox.globalSshKeyStatus());
    });

    router.put('/settings/ssh-key', (req, res) => {
        const { key } = req.body || {};
        if (!key || typeof key !== 'string') {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'key (PEM/OpenSSH private key) required' } });
        }
        try {
            sandbox.writeGlobalSshKey(key);
            res.json({ ok: true, ...sandbox.globalSshKeyStatus() });
        } catch (err) {
            res.status(400).json({ error: { code: 'INVALID_KEY', message: err.message } });
        }
    });

    router.delete('/settings/ssh-key', (req, res) => {
        sandbox.removeGlobalSshKey();
        res.json({ ok: true, ...sandbox.globalSshKeyStatus() });
    });

    // Check whether a host path exists before enabling a volume mount
    router.post('/settings/sandbox/volumes/check', (req, res) => {
        const { source } = req.body || {};
        if (!source || typeof source !== 'string') {
            return res.status(400).json({ error: 'source required' });
        }
        try {
            const exists = fs.existsSync(source);
            let type = null;
            if (exists) {
                const stat = fs.statSync(source);
                type = stat.isDirectory() ? 'directory' : 'file';
            }
            res.json({ exists, type });
        } catch {
            res.json({ exists: false, type: null });
        }
    });

    return router;
};
