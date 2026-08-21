'use strict';

const { Router } = require('express');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const sandbox = require('../../lib/sandbox');
const tunnel = require('../../lib/tunnel');
const lib = require('../../lib/jonggrang');

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
                // A device project's files are not here at all — its cwd is a
                // path on the developer's machine, reached through the tunnel.
                deviceCwd: project.device?.enabled ? project.device.workdir : null,
            };
        }
        const hostWt = path.join(sandbox.projectWorktreeDir(project.id), featureId);
        return {
            session: `${base}:${featureId}`,
            hostCwd: hostWt,
            containerCwd: project.sandbox?.enabled
                ? `${sandbox.WORKTREE_MOUNT}/${featureId}`
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

    // ── Plan discussion (interactive, read-only) ──────────────────
    //
    // "Discuss" launches the project's selected coding agent in an interactive
    // PTY session, seeded with the plan draft, running in a read-only / plan
    // mode so the conversation refines the plan without touching the repo.

    function readPlanContent(project, sessionId) {
        try {
            lib.migrateLegacyPlanDraft(project.path);
            const drafts = lib.getAllDrafts(project.path);
            const draft = sessionId
                ? drafts.find(d => d.sessionId === sessionId)
                : drafts[0];
            if (draft && fs.existsSync(draft.planPath)) {
                return fs.readFileSync(draft.planPath, 'utf-8');
            }
        } catch {}
        return '(no plan content found)';
    }

    function buildDiscussSeed(planContent) {
        return [
            'We are in PLAN DISCUSSION mode — a READ-ONLY conversation to refine an implementation plan.',
            'Do NOT create, edit, or delete any files, and do not run commands that modify the repository.',
            '',
            'Here is the current draft plan:',
            '',
            '--- PLAN START ---',
            planContent,
            '--- PLAN END ---',
            '',
            'Give me a 2-3 sentence summary of what this plan does and the single most important gap or risk you see, then wait for my questions. Keep answers concise.',
        ].join('\n');
    }

    // Interactive command for each backend: seed prompt as the initial message,
    // read-only where the CLI supports it (claude plan mode, codex read-only
    // sandbox, Pi restricted tool set). OpenCode has no read-only CLI flag, so
    // the seed prompt carries the constraint.
    function resolveDiscussCommand(tool, seed, sandboxEnabled) {
        if (tool === 'claude')   return { cmd: 'claude',   args: ['--permission-mode', 'plan', seed] };
        if (tool === 'codex')    return { cmd: 'codex',    args: ['--sandbox', 'read-only', seed] };
        if (tool === 'opencode') return { cmd: 'opencode', args: [seed] };
        if (sandboxEnabled)      return { cmd: 'jonggrang', args: ['agent', '--readonly', seed] };
        return { cmd: 'node', args: [nodeCli, 'agent', '--readonly', seed] };
    }

    // Discuss always runs in the project directory (drafts have no worktree yet).
    function discussScope(project) {
        return {
            session: 'discuss',
            hostCwd: project.path,
            containerCwd: project.sandbox?.enabled ? sandbox.getContainerPath(project) : null,
        };
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
        } else if (project.device?.enabled) {
            // Third execution context (the plan's §9): not here, not a container,
            // but the developer's machine at the far end of its reverse tunnel.
            //
            // NOTE — this applies to every spawnPty caller: terminal, agent and
            // discuss. For the Terminal that is exactly right. For the AGENT it
            // is a decision the plan has not made: §2/§3 put the agent on the
            // SERVER and redirect only its Bash, whereas this runs the agent CLI
            // on the device — which also means that machine needs the CLI
            // installed and logged in. Left as-is deliberately rather than
            // guessed at; resolving it is P2's transparent-redirect work.
            const device = tunnel.deviceFor(project.device.device_id);
            if (!device) throw new Error(`device ${project.device.device_id} is no longer registered`);
            args = tunnel.buildSshExecArgs(device, scope.deviceCwd, cmd, args, secretVars);
            cmd = 'ssh';
            tunnel.touchDevice(project.device.device_id);
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

        // A device project is only reachable while its tunnel is up. Saying so
        // beats an ssh that hangs and then fails with a connection refused.
        if (project.device?.enabled) {
            const device = tunnel.deviceFor(project.device.device_id);
            if (!device) return res.status(409).json({ error: 'DEVICE_NOT_REGISTERED', message: 'This project\'s device is no longer registered.' });
            if (!await tunnel.portListening(device.port)) {
                return res.status(503).json({
                    error: 'DEVICE_TUNNEL_DOWN',
                    message: `No tunnel from ${device.label}. Run \`jonggrang tunnel up\` on that machine.`,
                });
            }
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

    // ── Plan discussion routes ────────────────────────────────────

    router.get('/:id/plan/discuss/config', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        const tool = readProjectTool(project);
        const { session } = discussScope(project);
        res.json({ tool, running: activePtySessions.has(`${project.id}:${session}`) });
    });

    router.post('/:id/plan/discuss/start', async (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });

        const { tool, cols = 80, rows = 24, sessionId = '' } = req.body || {};
        const resolvedTool = tool || readProjectTool(project);
        const seed = buildDiscussSeed(readPlanContent(project, sessionId));
        const { cmd, args } = resolveDiscussCommand(resolvedTool, seed, project.sandbox?.enabled);
        const scope = discussScope(project);

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

    router.post('/:id/plan/discuss/stop', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
        const { session } = discussScope(project);
        const ptyProcess = activePtySessions.get(`${project.id}:${session}`);
        if (ptyProcess) {
            try { ptyProcess.kill(); } catch {}
            activePtySessions.delete(`${project.id}:${session}`);
        }
        res.json({ ok: true });
    });

    // Expose for cleanup
    router._activePtySessions = activePtySessions;

    return router;
};
