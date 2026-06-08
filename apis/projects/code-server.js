'use strict';

// "Full" code-editor mode: openvscode-server per project, reverse-proxied through
// the dashboard at /api/projects/:id/code/* (no published-to-the-world port — the
// container's editor port is bound to a random loopback host port, reachable only
// by this server). Lazy-start on first request, idle-stop after inactivity.

const { Router } = require('express');
const { spawn, execFile } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const sandbox = require('../../lib/sandbox');

const IDLE_MS = 15 * 60 * 1000;   // stop an editor 15 min after last use
const READY_TIMEOUT_MS = 20000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = function(deps) {
    const { webState } = deps;
    const router = Router();
    const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });
    proxy.on('error', (err, req, res) => {
        try {
            if (res && res.writeHead && !res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
            if (res && res.end) res.end(`editor proxy error: ${err.message}`);
        } catch {}
    });

    // projectId -> { target, lastActivity, startPromise, host (proc|null) }
    const editors = new Map();
    const basePathOf = (id) => `/api/projects/${id}/code`;

    function pollReady(target, basePath) {
        return new Promise((resolve) => {
            const deadline = Date.now() + READY_TIMEOUT_MS;
            const tryOnce = () => {
                const req = http.get(`${target}${basePath}/`, (resp) => {
                    resp.resume();
                    resolve(true);
                });
                req.on('error', () => {
                    if (Date.now() > deadline) return resolve(false);
                    setTimeout(tryOnce, 400);
                });
                req.setTimeout(2000, () => { req.destroy(); });
            };
            tryOnce();
        });
    }

    function containerEditorRunning(container) {
        return new Promise((resolve) => {
            execFile('docker', ['exec', container, 'pgrep', '-f', 'openvscode-server'],
                { timeout: 8000 }, (err, stdout) => resolve(!err && !!String(stdout).trim()));
        });
    }

    // Start (or reuse) the project's editor and return its proxy target.
    async function ensureEditor(project) {
        const id = project.id;
        const existing = editors.get(id);
        if (existing?.startPromise) return existing.startPromise;
        if (existing?.target) { existing.lastActivity = Date.now(); return existing.target; }

        const basePath = basePathOf(id);
        const rec = { target: null, lastActivity: Date.now(), startPromise: null, host: null };
        editors.set(id, rec);

        rec.startPromise = (async () => {
            if (project.sandbox?.enabled) {
                const container = sandbox.getContainerName(id);
                if (!await sandbox.isRunning(id).catch(() => false)) {
                    throw new Error('Docker sandbox is not running. Start it first.');
                }
                const hostPort = await sandbox.getEditorHostPort(id);
                if (!hostPort) {
                    throw new Error('Editor port not published — rebuild the sandbox after enabling the Full editor.');
                }
                const target = `http://127.0.0.1:${hostPort}`;
                const folder = sandbox.getContainerPath(project);
                if (!await containerEditorRunning(container)) {
                    // detached; binds 0.0.0.0 inside the container so the published port reaches it
                    spawn('docker', ['exec', '-d', container, 'openvscode-server',
                        '--host', '0.0.0.0', '--port', String(sandbox.EDITOR_CONTAINER_PORT),
                        '--without-connection-token', '--server-base-path', basePath, folder],
                        { stdio: 'ignore' });
                }
                const ok = await pollReady(target, basePath);
                if (!ok) throw new Error('Editor did not become ready in time.');
                rec.target = target;
            } else {
                // Host project: requires openvscode-server on the host PATH.
                const net = require('net');
                const port = await new Promise((resolve, reject) => {
                    const s = net.createServer();
                    s.once('error', reject);
                    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
                });
                const target = `http://127.0.0.1:${port}`;
                rec.host = spawn('openvscode-server', [
                    '--host', '127.0.0.1', '--port', String(port),
                    '--without-connection-token', '--server-base-path', basePath, project.path],
                    { stdio: 'ignore' });
                rec.host.on('error', () => {});
                const ok = await pollReady(target, basePath);
                if (!ok) { try { rec.host.kill(); } catch {} throw new Error('openvscode-server not available on host or failed to start.'); }
                rec.target = target;
            }
            rec.startPromise = null;
            rec.lastActivity = Date.now();
            return rec.target;
        })().catch((err) => { editors.delete(id); throw err; });

        return rec.startPromise;
    }

    function stopEditor(id) {
        const rec = editors.get(id);
        if (!rec) return;
        if (rec.host) { try { rec.host.kill(); } catch {} }
        else { try { execFile('docker', ['exec', sandbox.getContainerName(id), 'pkill', '-f', 'openvscode-server'], () => {}); } catch {} }
        editors.delete(id);
    }

    // Idle reaper
    const reaper = setInterval(() => {
        const now = Date.now();
        for (const [id, rec] of editors) {
            if (rec.target && now - rec.lastActivity > IDLE_MS) stopEditor(id);
        }
    }, 60000).unref();

    // ── HTTP proxy: /api/projects/:id/code(/*) ────────────────────
    async function handle(req, res) {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        if (project.code_editor !== 'full') return res.status(409).json({ error: { code: 'EDITOR_OFF', message: 'Full code editor not enabled for this project' } });
        try {
            const target = await ensureEditor(project);
            const rec = editors.get(project.id);
            if (rec) rec.lastActivity = Date.now();
            // Express strips the mount path from req.url; openvscode runs under the
            // FULL base path (/api/projects/:id/code), so forward the original URL.
            req.url = req.originalUrl;
            proxy.web(req, res, { target });
        } catch (err) {
            res.status(503).json({ error: { code: 'EDITOR_START_FAILED', message: err.message } });
        }
    }
    router.all('/:id/code', handle);
    router.all('/:id/code/*', handle);

    // ── status (for the iframe view to show a friendly message) ───
    router.get('/:id/code-status', (req, res) => {
        const project = webState.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'not found' });
        const folder = project.sandbox?.enabled ? sandbox.getContainerPath(project) : project.path;
        res.json({ mode: project.code_editor || 'off', running: !!editors.get(project.id)?.target, folder });
    });

    // WebSocket upgrade handler — wired into the http server by server.js.
    // Only handles the editor path; returns false otherwise so socket.io keeps its upgrades.
    function upgrade(req, socket, head) {
        const m = req.url.match(/^\/api\/projects\/([^/]+)\/code(\/|$|\?)/);
        if (!m) return false;
        const project = webState.getProject(m[1]);
        if (!project || project.code_editor !== 'full') { socket.destroy(); return true; }
        const rec = editors.get(project.id);
        if (!rec?.target) { socket.destroy(); return true; }
        rec.lastActivity = Date.now();
        proxy.ws(req, socket, head, { target: rec.target });
        return true;
    }
    deps.codeEditorUpgrade = upgrade;

    router._cleanup = () => { clearInterval(reaper); for (const id of [...editors.keys()]) stopEditor(id); };
    return router;
};
