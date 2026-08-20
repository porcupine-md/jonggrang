const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const lib = require('./lib/jonggrang');
const orchestration = require('./lib/orchestration');
const compaction = require('./lib/compaction');
const feedback = require('./lib/feedback');
const webState = require('./lib/web-state');
const sandbox = require('./lib/sandbox');

// Central worktree root (~/.jonggrang/worktree). Worktrees live here, per project.
sandbox.ensureWorktreeRoot();

const app = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────
// Open to all origins — no origin whitelist, no rate limiting, no body cap.
const io = new Server(server, {
    cors: {
        origin: true,
        methods: ['GET', 'POST']
    }
});

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1gb' }));

// ── PROJECT / HOME PATHS ──────────────────────────────────────
const PROJECT_ROOT = process.env.JONGGRANG_PROJECT_ROOT || path.resolve(__dirname, '..');

function resolveJonggrangHome() {
    if (process.env.JONGGRANG_HOME) return process.env.JONGGRANG_HOME;
    const candidates = [__dirname, path.resolve(__dirname, '..')];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'templates', 'AGENTS.md.template'))) return c;
    }
    return __dirname;
}

const JONGGRANG_HOME = resolveJonggrangHome();
const paths = lib.getProjectPaths(PROJECT_ROOT);

// ── REGISTER ROUTE MODULES ────────────────────────────────────
const legacyCtx = { PROJECT_ROOT, JONGGRANG_HOME, lib, orchestration, compaction, feedback, paths };
const cleanupLegacy = require('./apis/legacy')(app, io, legacyCtx);

webState.cleanupStaleImports();
webState.initVolumes();

const projectsCtx = { JONGGRANG_HOME, webState, orchestration, server };
const cleanupProjects = require('./apis/projects')(app, io, projectsCtx);

// Global design-template studio API (~/.jonggrang/design)
const cleanupDesign = require('./apis/design')(app, io, { JONGGRANG_HOME, server });

// Global object-storage API (S3-compatible uploads: R2, MinIO, custom)
const cleanupStorage = require('./apis/storage')(app, io, { JONGGRANG_HOME });

// ── FRONTEND ──────────────────────────────────────────────────
// Production (default): serve the built client from client/dist.
// Development (NODE_ENV=development): run Vite in middleware mode so the
// client hot-reloads — a single `node server.js` serves both API and client.
const distPath = path.join(__dirname, 'client', 'dist');

async function setupFrontend() {
    const isProduction = process.env.NODE_ENV !== 'development';

    if (isProduction) {
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            if (req.path.startsWith('/api/')) {
                return res.status(404).json({ error: 'API endpoint not found' });
            }
            if (fs.existsSync(path.join(distPath, 'index.html'))) {
                res.sendFile(path.join(distPath, 'index.html'));
            } else {
                console.error('[jonggrang] Frontend build missing. Run: npm run build');
                res.status(503).type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Jonggrang — Build Required</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#05060a;color:#f4f4f5;}</style></head>
<body><div style="text-align:center;max-width:480px">
<h1>🎭 Jonggrang</h1>
<p style="color:#9ca3af">Frontend build files missing.</p>
<pre style="background:#16171f;padding:12px;border-radius:8px;color:#38bdf8;font-size:13px">npm run build</pre>
<p style="color:#4b5563;font-size:13px">Then restart with <code style="color:#10b981">npm start</code></p>
</div></body></html>`);
            }
        });
        console.log(`Serving static files from: ${distPath}`);
        return;
    }

    // Development: Vite dev server as Express middleware (client HMR).
    // Vite is a devDependency of client/, so resolve it from there.
    const clientDir = path.join(__dirname, 'client');
    const { pathToFileURL } = require('url');
    const viteEntry = require.resolve('vite', { paths: [clientDir] });
    const { createServer: createViteServer } = await import(pathToFileURL(viteEntry).href);
    const vite = await createViteServer({
        root: clientDir,
        configFile: path.join(clientDir, 'vite.config.js'),
        server: { middlewareMode: true },
        appType: 'spa',
    });
    app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
    app.use(vite.middlewares);
    console.log('Vite dev middleware active — client HMR enabled');
}

// ── GLOBAL API ERROR HANDLER ──────────────────────────────────
app.use('/api', (err, req, res, _next) => {
    console.error(`[jonggrang:api:error] ${req.method} ${req.path}:`, err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── GLOBAL ERROR HANDLERS ─────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('[jonggrang:uncaught]', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[jonggrang:unhandledRejection]', reason);
});

function cleanupAll() {
    cleanupLegacy();
    cleanupProjects();
}
process.on('SIGINT',  () => { cleanupAll(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });

// ── START SERVER ──────────────────────────────────────────────
const portEnv = process.env.PORT;
const HOST = process.env.HOST || '127.0.0.1';
let envPort = null;
if (portEnv !== undefined) {
    const parsedPort = Number(portEnv);
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        throw new Error(`Invalid PORT environment variable: ${portEnv}`);
    }
    envPort = parsedPort;
}

(async () => {
    try {
        await setupFrontend();
        const PORT = envPort !== null ? envPort : 7777;
        server.listen(PORT, HOST, () => {
            console.log(`Jonggrang dashboard on http://${HOST}:${PORT}`);
            console.log(`Project root: ${PROJECT_ROOT}`);
        });
    } catch (err) {
        console.error(`[jonggrang] Failed to start server: ${err.message}`);
        process.exit(1);
    }
})();
