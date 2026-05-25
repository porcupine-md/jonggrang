'use strict';

const { Router } = require('express');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

module.exports = function(deps) {
    const { io, webState } = deps;
    const router = Router();
    const nodeCli = path.join(__dirname, '..', '..', 'bin', 'jonggrang.js');

    // Map key: `${projectId}:agent` or `${projectId}:terminal`
    const activePtySessions = new Map();

    // ── Helpers ──────────────────────────────────────────────────

    function readProjectTool(project) {
        try {
            const configPath = path.join(project.path, '.jonggrang', 'jonggrang.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return config.tool || 'jonggrang';
        } catch {
            return 'jonggrang';
        }
    }

    function resolveAgentCommand(tool) {
        if (tool === 'claude')    return { cmd: 'claude',   args: [] };
        if (tool === 'opencode')  return { cmd: 'opencode', args: [] };
        return { cmd: 'node', args: [nodeCli, 'agent'] };
    }

    function spawnPty(project, session, cmd, args, cols, rows) {
        const key = `${project.id}:${session}`;

        // Kill existing session if any
        const existing = activePtySessions.get(key);
        if (existing) {
            try { existing.kill(); } catch {}
            activePtySessions.delete(key);
        }

        const secretVars = webState.getProjectSecretVars(project.id);

        const ptyProcess = pty.spawn(cmd, args, {
            name: 'xterm-256color',
            cwd: project.path,
            env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...secretVars },
            cols: cols || 80,
            rows: rows || 24,
        });

        activePtySessions.set(key, ptyProcess);

        ptyProcess.onData(data => {
            io.to(`project:${project.id}`).emit('pty.data', {
                project_id: project.id,
                session,
                data,
            });
        });

        ptyProcess.onExit(({ exitCode }) => {
            activePtySessions.delete(key);
            io.to(`project:${project.id}`).emit('pty.exit', {
                project_id: project.id,
                session,
                code: exitCode,
            });
        });

        return ptyProcess;
    }

    // ── Socket handlers ───────────────────────────────────────────

    io.on('connection', (socket) => {
        socket.on('pty.input', ({ project_id, session, data }) => {
            const ptyProcess = activePtySessions.get(`${project_id}:${session}`);
            if (ptyProcess) ptyProcess.write(data);
        });

        socket.on('pty.resize', ({ project_id, session, cols, rows }) => {
            const ptyProcess = activePtySessions.get(`${project_id}:${session}`);
            if (ptyProcess && cols > 0 && rows > 0) {
                ptyProcess.resize(cols, rows);
            }
        });
    });

    // ── Agent routes ──────────────────────────────────────────────

    router.get('/:id/agent/config', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        const tool = readProjectTool(project);
        const key = `${project.id}:agent`;
        res.json({ tool, running: activePtySessions.has(key) });
    });

    router.post('/:id/agent/start', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

        const { tool, cols = 80, rows = 24 } = req.body || {};
        const resolvedTool = tool || readProjectTool(project);
        const { cmd, args } = resolveAgentCommand(resolvedTool);

        try {
            spawnPty(project, 'agent', cmd, args, cols, rows);
            res.json({ ok: true, tool: resolvedTool });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/:id/agent/stop', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

        const key = `${project.id}:agent`;
        const ptyProcess = activePtySessions.get(key);
        if (ptyProcess) {
            try { ptyProcess.kill(); } catch {}
            activePtySessions.delete(key);
        }
        res.json({ ok: true });
    });

    // ── Terminal routes ───────────────────────────────────────────

    router.post('/:id/terminal/start', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

        const { cols = 80, rows = 24 } = req.body || {};
        const shell = process.env.SHELL || 'bash';

        try {
            spawnPty(project, 'terminal', shell, [], cols, rows);
            res.json({ ok: true, shell });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/:id/terminal/stop', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

        const key = `${project.id}:terminal`;
        const ptyProcess = activePtySessions.get(key);
        if (ptyProcess) {
            try { ptyProcess.kill(); } catch {}
            activePtySessions.delete(key);
        }
        res.json({ ok: true });
    });

    // Expose for cleanup
    router._activePtySessions = activePtySessions;

    return router;
};
