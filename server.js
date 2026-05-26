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

const app = express();
const server = http.createServer(app);

// ── TRUSTED ORIGINS ───────────────────────────────────────────
const TRUSTED_ORIGINS = ['localhost', '127.0.0.1', '::1', '.local'];
function isOriginTrusted(origin) {
    if (!origin) return true;
    try {
        const host = new URL(origin).hostname;
        return TRUSTED_ORIGINS.some(t =>
            t.startsWith('.') ? host.endsWith(t) || host === t.slice(1) : host === t
        );
    } catch { return false; }
}

const io = new Server(server, {
    cors: {
        origin: (origin, cb) => cb(null, isOriginTrusted(origin)),
        methods: ['GET', 'POST']
    }
});

app.use(cors({ origin: (origin, cb) => cb(null, isOriginTrusted(origin)) }));
app.use(express.json({ limit: '1mb' }));

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

const projectsCtx = { JONGGRANG_HOME, webState, orchestration };
const cleanupProjects = require('./apis/projects')(app, io, projectsCtx);

// ── STATIC FRONTEND ───────────────────────────────────────────
const distPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(distPath));

// ── GLOBAL API ERROR HANDLER ──────────────────────────────────
app.use('/api', (err, req, res, _next) => {
    console.error(`[jonggrang:api:error] ${req.method} ${req.path}:`, err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── SPA FALLBACK ──────────────────────────────────────────────
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

// ── RATE LIMITER ──────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 200;
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_LIMIT_WINDOW; }
    entry.count++;
    rateLimitMap.set(ip, entry);
    if (entry.count > RATE_LIMIT_MAX) return res.status(429).json({ error: 'Too many requests. Slow down.' });
    next();
});
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
}, 300_000).unref();

// ── PORT FINDER ───────────────────────────────────────────────
function findAvailablePort(start, end) {
    const net = require('net');
    return new Promise((resolve, reject) => {
        let port = start;
        function tryPort() {
            if (port > end) return reject(new Error(`No available port in ${start}-${end}`));
            const srv = net.createServer();
            srv.once('error', (err) => {
                if (err && err.code === 'EADDRINUSE') { port++; tryPort(); return; }
                reject(err);
            });
            srv.once('listening', () => { srv.close(() => resolve(port)); });
            srv.listen(port);
        }
        tryPort();
    });
}

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
        const PORT = envPort !== null ? envPort : await findAvailablePort(7777, 7999);
        server.listen(PORT, () => {
            console.log(`Jonggrang dashboard on http://localhost:${PORT}`);
            console.log(`Project root: ${PROJECT_ROOT}`);
        });
    } catch (err) {
        console.error(`[jonggrang] Failed to start server: ${err.message}`);
        process.exit(1);
    }
})();
