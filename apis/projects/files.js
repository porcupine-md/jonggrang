'use strict';

// File explorer API for the "Lite" code-editor mode (CodeMirror in the browser).
// Lists directories, reads and writes files — for host projects via fs, for
// sandbox projects via `docker exec` so the tree matches what the agent sees.
// Optional ?feature_id scopes the root to that plan's worktree.

const { Router } = require('express');
const { execFileSync } = require('child_process');
const pathp = require('path').posix;
const sandbox = require('../../lib/sandbox');

const MAX_READ_BYTES = 1024 * 1024; // 1MB — refuse larger / binary files in the editor
const EXEC_MAXBUF = 1024 * 1024 * 8;

module.exports = function(deps) {
    const { fs, path, webState } = deps;
    const router = Router();

    function projectOr404(req, res) {
        const project = webState.getProject(req.params.id);
        if (!project) res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Not found' } });
        return project;
    }

    function ctxOf(project, featureId) {
        const sub = featureId ? `.jonggrang/.worktree/${featureId}` : '';
        if (project.sandbox?.enabled) {
            const container = sandbox.getContainerName(project.id);
            const base = sandbox.getContainerPath(project);
            return { mode: 'container', container, root: sub ? `${base}/${sub}` : base };
        }
        const base = project.path;
        return { mode: 'host', root: sub ? path.join(base, sub) : base };
    }

    // Resolve a client-supplied relative path against root and refuse escapes.
    function resolveSafe(root, rel) {
        const cleanRel = String(rel || '').replace(/^\/+/, '');
        const full = pathp.normalize(pathp.join(root, cleanRel));
        if (full !== root && !full.startsWith(root + '/')) return null;
        return full;
    }

    const dockerExec = (ctx, args, opts = {}) =>
        execFileSync('docker', ['exec', ...(opts.stdin !== undefined ? ['-i'] : []), ctx.container, ...args],
            { encoding: 'utf8', maxBuffer: EXEC_MAXBUF, input: opts.stdin });

    // ── list directory ────────────────────────────────────────────
    router.get('/:id/files', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const ctx = ctxOf(project, req.query.feature_id);
        const full = resolveSafe(ctx.root, req.query.path);
        if (full === null) return res.status(400).json({ error: { code: 'BAD_PATH', message: 'Invalid path' } });

        try {
            let entries = [];
            if (ctx.mode === 'container') {
                const out = dockerExec(ctx, ['sh', '-c', `ls -1Ap "${full}" 2>/dev/null`]);
                entries = out.split('\n').filter(Boolean).map(name => {
                    const isDir = name.endsWith('/');
                    return { name: isDir ? name.slice(0, -1) : name, type: isDir ? 'dir' : 'file' };
                });
            } else {
                entries = fs.readdirSync(full, { withFileTypes: true }).map(d => ({
                    name: d.name, type: d.isDirectory() ? 'dir' : 'file',
                }));
            }
            // hide the noisy .git internals; keep dotfiles otherwise. dirs first, alpha.
            entries = entries.filter(e => e.name !== '.git')
                .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
            res.json({ path: req.query.path || '', entries });
        } catch (err) {
            res.status(500).json({ error: { code: 'LIST_ERROR', message: err.message } });
        }
    });

    // ── read file ─────────────────────────────────────────────────
    router.get('/:id/files/content', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const ctx = ctxOf(project, req.query.feature_id);
        const full = resolveSafe(ctx.root, req.query.path);
        if (full === null) return res.status(400).json({ error: { code: 'BAD_PATH', message: 'Invalid path' } });
        if (!req.query.path) return res.status(400).json({ error: { code: 'BAD_PATH', message: 'path required' } });

        try {
            let content;
            if (ctx.mode === 'container') {
                const size = parseInt(dockerExec(ctx, ['sh', '-c', `wc -c < "${full}" 2>/dev/null || echo -1`]).trim(), 10);
                if (size < 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
                if (size > MAX_READ_BYTES) return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'File too large to edit' } });
                content = dockerExec(ctx, ['cat', full]);
            } else {
                const st = fs.statSync(full);
                if (st.isDirectory()) return res.status(400).json({ error: { code: 'IS_DIR', message: 'Path is a directory' } });
                if (st.size > MAX_READ_BYTES) return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'File too large to edit' } });
                content = fs.readFileSync(full, 'utf8');
            }
            if (/\u0000/.test(content)) return res.status(415).json({ error: { code: 'BINARY', message: 'Binary file' } });
            res.json({ path: req.query.path, content });
        } catch (err) {
            res.status(500).json({ error: { code: 'READ_ERROR', message: err.message } });
        }
    });

    // ── write file ────────────────────────────────────────────────
    router.put('/:id/files/content', (req, res) => {
        const project = projectOr404(req, res);
        if (!project) return;
        const { path: rel, content, feature_id } = req.body || {};
        if (!rel || content === undefined) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'path and content required' } });
        const ctx = ctxOf(project, feature_id);
        const full = resolveSafe(ctx.root, rel);
        if (full === null) return res.status(400).json({ error: { code: 'BAD_PATH', message: 'Invalid path' } });

        try {
            if (ctx.mode === 'container') {
                dockerExec(ctx, ['sh', '-c', `cat > "${full}"`], { stdin: String(content) });
            } else {
                fs.writeFileSync(full, String(content), 'utf8');
            }
            res.json({ ok: true, path: rel });
        } catch (err) {
            res.status(500).json({ error: { code: 'WRITE_ERROR', message: err.message } });
        }
    });

    return router;
};
