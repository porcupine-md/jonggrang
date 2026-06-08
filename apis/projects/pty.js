'use strict';

const { Router } = require('express');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const sandbox = require('../../lib/sandbox');

module.exports = function(deps) {
    const { io, webState, lastActivity } = deps;
    const router = Router();
    const nodeCli = path.join(__dirname, '..', '..', 'bin', 'jonggrang.js');

    // Map key: `${projectId}:${session}` where session is 'agent'/'terminal'
    // (project scope) or 'agent:<featureId>'/'terminal:<featureId>' (Work
    // Mode — runs inside the plan's worktree).
    const activePtySessions = new Map();

    // ── Helpers ──────────────────────────────────────────────────

    // Session name + cwd (host & container) for an optional plan scope.
    function resolveScope(project, base, featureId) {
        if (!featureId) {
            return {
                session: base,
                hostCwd: project.path,
                containerCwd: project.sandbox?.enabled ? sandbox.getContainerPath(project) : null,
            };
        }
        const hostWt = path.join(project.path, '.jonggrang', '.worktree', featureId);
        return {
            session: `${base}:${featureId}`,
            hostCwd: hostWt,
            containerCwd: project.sandbox?.enabled
                ? `${sandbox.getContainerPath(project)}/.jonggrang/.worktree/${featureId}`
                : null,
            hostWt,
        };
    }

    function worktreeMissing(scope, res) {
        if (scope.hostWt && !fs.existsSync(scope.hostWt)) {
            res.status(409).json({ error: 'WORKTREE_MISSING', message: 'Plan worktree not created yet. Enter Work Mode first.' });
            return true;
        }
        return false;
    }

    function readProjectTool(project) {
        const configPath = path.join(project.path, '.jonggrang', 'jonggrang.json');
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return config.tool || 'jonggrang';
        } catch (err) {
            if (err.code === 'ENOENT') return 'jonggrang';
            throw err;
        }
    }

    function resolveAgentCommand(tool, sandboxEnabled) {
        if (tool === 'claude')    return { cmd: 'claude',   args: [] };
        if (tool === 'opencode')  return { cmd: 'opencode', args: [] };
        if (sandboxEnabled)       return { cmd: 'jonggrang', args: ['agent'] };
        return { cmd: 'node', args: [nodeCli, 'agent'] };
    }

    function spawnPty(project, scope, cmd, args, cols, rows) {
        const { session } = scope;
        const key = `${project.id}:${session}`;

        // Kill existing session if any — emit replaced first so UI can ignore stale exit
        const existing = activePtySessions.get(key);
        if (existing) {
            io.to(`project:${project.id}`).emit('pty.replaced', {
                project_id: project.id,
                session,
            });
            try { existing.kill(); } catch {}
            activePtySessions.delete(key);
        }

        const secretVars = webState.getProjectSecretVars(project.id);

        if (project.sandbox?.enabled) {
            const containerName = sandbox.getContainerName(project.id);
            const execArgs = sandbox.buildExecArgs(containerName, scope.containerCwd, cmd, args, secretVars);
            cmd = 'docker';
            args = execArgs;
        }

        const ptyProcess = pty.spawn(cmd, args, {
            name: 'xterm-256color',
            cwd: scope.hostCwd,
            env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...secretVars },
            cols: cols || 80,
            rows: rows || 24,
        });

        activePtySessions.set(key, ptyProcess);

        ptyProcess.onData(data => {
            lastActivity.set(project.id, Date.now());
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

    function stopSession(project, base, featureId) {
        const { session } = resolveScope(project, base, featureId);
        const key = `${project.id}:${session}`;
        const ptyProcess = activePtySessions.get(key);
        if (ptyProcess) {
            try { ptyProcess.kill(); } catch {}
            activePtySessions.delete(key);
        }
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
        const { session } = resolveScope(project, 'agent', req.query.feature_id);
        res.json({ tool, running: activePtySessions.has(`${project.id}:${session}`) });
    });

    router.post('/:id/agent/start', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

        const { tool, cols = 80, rows = 24, feature_id } = req.body || {};
        const resolvedTool = tool || readProjectTool(project);
        const { cmd, args } = resolveAgentCommand(resolvedTool, project.sandbox?.enabled);
        const scope = resolveScope(project, 'agent', feature_id);
        if (worktreeMissing(scope, res)) return;

        if (project.sandbox?.enabled) {
            const running = await sandbox.isRunning(project.id);
            if (!running) return res.status(503).json({ error: 'SANDBOX_NOT_RUNNING', message: 'Docker sandbox is not running. Start it first.' });
        }

        try {
            spawnPty(project, scope, cmd, args, cols, rows);
            res.json({ ok: true, tool: resolvedTool, session: scope.session });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/:id/agent/stop', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        stopSession(project, 'agent', (req.body || {}).feature_id);
        res.json({ ok: true });
    });

    // ── Terminal routes ───────────────────────────────────────────

    router.post('/:id/terminal/start', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

        const { cols = 80, rows = 24, feature_id } = req.body || {};
        const shell = project.sandbox?.enabled
            ? (project.sandbox.shell || webState.getSandboxConfig().shell || '/bin/bash')
            : (process.env.SHELL || 'bash');
        const scope = resolveScope(project, 'terminal', feature_id);
        if (worktreeMissing(scope, res)) return;

        if (project.sandbox?.enabled) {
            const running = await sandbox.isRunning(project.id);
            if (!running) return res.status(503).json({ error: 'SANDBOX_NOT_RUNNING', message: 'Docker sandbox is not running. Start it first.' });
        }

        try {
            spawnPty(project, scope, shell, [], cols, rows);
            res.json({ ok: true, shell, session: scope.session });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/:id/terminal/stop', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        stopSession(project, 'terminal', (req.body || {}).feature_id);
        res.json({ ok: true });
    });

    // Expose for cleanup
    router._activePtySessions = activePtySessions;

    return router;
};
