'use strict';

// Global design-template API (see lib/design.js + docs/plans/2026-08-15-jonggrang-design-studio.md).
// Backs the web "Design" studio: list/read/create/promote/save/delete templates, validate
// (lint on save), and render a self-contained preview document for a sandboxed <iframe>.

const fs = require('fs');
const path = require('path');
const design = require('../lib/design');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function renderPreviewDoc(tokensCss, bodyHtml, theme, width) {
  return `<!doctype html>
<html data-theme="${theme === 'dark' ? 'dark' : 'light'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${tokensCss}
html, body { margin: 0; background: var(--ui-canvas, #fff); color: var(--ui-text, #111);
  font-family: system-ui, -apple-system, sans-serif; }
.preview-wrap { max-width: ${width}px; margin: 0 auto; padding: var(--ui-space-8, 2rem) var(--ui-space-4, 1rem); }
.preview-item { margin-bottom: var(--ui-space-8, 2rem); }
.preview-item > .preview-label { font: 600 0.72rem/1.4 system-ui; letter-spacing: .04em;
  text-transform: uppercase; color: var(--ui-text-muted, #666); margin: 0 0 var(--ui-space-3, .75rem); }
</style>
</head>
<body><div class="preview-wrap">${bodyHtml}</div></body>
</html>`;
}

module.exports = function register(app, io, _ctx) {
  // Live preview: watch the design store so ANY change — the studio's Save button
  // OR the TUI agent writing files directly (in sandbox mode via the ~/.jonggrang
  // bind mount) — emits `design.changed` and refreshes the open preview. Polling is
  // used so it also fires for writes made inside the container. (fixes: preview not
  // live-updating on agent edits — used to require a manual refresh.)
  let designWatcher = null;
  try {
    const chokidar = require('chokidar');
    const root = design.designRoot();
    fs.mkdirSync(root, { recursive: true });
    designWatcher = chokidar.watch(root, {
      ignoreInitial: true,
      usePolling: true,
      interval: 400,
      depth: 4,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    });
    const onFsEvent = (changed) => {
      const rel = path.relative(root, changed);
      const name = rel.split(path.sep)[0];
      if (name && name !== 'core' && io && io.emit) io.emit('design.changed', { name, path: rel });
    };
    for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) designWatcher.on(ev, onFsEvent);
  } catch { /* watching is best-effort */ }

  // List templates.
  app.get('/api/design', (req, res) => {
    try {
      const templates = design.listTemplates().map(t => ({
        id: t.id, key: t.key, version: t.version, intent: t.intent,
        product_shapes: t.product_shapes || [], components: (t.components || []).map(c => c.id),
        valid: t.valid, errors: t.errors || [], source: t.source,
      }));
      res.json({ templates, root: design.designRoot() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Read one template (manifest + guide + tokens + components + validation).
  app.get('/api/design/:name', (req, res) => {
    try {
      const t = design.loadTemplate(req.params.name);
      res.json({
        key: t.key, dir: t.dir, manifest: t.manifest,
        guideFragment: t.guideFragment, tokenTemplate: t.tokenTemplate,
        components: t.components.map(c => ({ id: c.id, variants: c.variants, file: c.file, html: c.html })),
        validation: design.validateTemplate(req.params.name),
      });
    } catch (err) { res.status(404).json({ error: err.message }); }
  });

  // Create (scaffold) a template.
  app.post('/api/design', (req, res) => {
    try {
      const { name, intent, product_shapes, recommend_keywords, force } = req.body || {};
      res.status(201).json(design.newTemplate(name, { intent, product_shapes, recommend_keywords, force }));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Promote a project's UI.md + tokens into a template.
  app.post('/api/design/promote', (req, res) => {
    try {
      const { name, fromProjectPath, force } = req.body || {};
      if (!fromProjectPath) return res.status(400).json({ error: 'fromProjectPath required' });
      res.status(201).json(design.promoteFromProject(name, path.resolve(fromProjectPath), { force }));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Save a file inside a template (studio editor) — path-guarded, lints on save.
  app.put('/api/design/:name/file', (req, res) => {
    try {
      const { file, content } = req.body || {};
      if (!file || content == null) return res.status(400).json({ error: 'file and content required' });
      const dir = path.join(design.designRoot(), req.params.name);
      if (!fs.existsSync(dir)) return res.status(404).json({ error: 'template not found' });
      const target = path.resolve(dir, file);
      if (target !== path.resolve(dir) && !target.startsWith(path.resolve(dir) + path.sep)) {
        return res.status(400).json({ error: 'path escapes template dir' });
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(content), 'utf8');
      const validation = design.validateTemplate(req.params.name);
      if (io && io.emit) io.emit('design.changed', { name: req.params.name, file });
      res.json({ ok: true, validation });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Delete a template.
  app.delete('/api/design/:name', (req, res) => {
    try { res.json(design.removeTemplate(req.params.name)); }
    catch (err) { res.status(404).json({ error: err.message }); }
  });

  // Validate (lint).
  app.get('/api/design/:name/validate', (req, res) => {
    try { res.json(design.validateTemplate(req.params.name)); }
    catch (err) { res.status(404).json({ error: err.message }); }
  });

  // Self-contained preview HTML for a sandboxed iframe.
  app.get('/api/design/:name/preview', (req, res) => {
    try {
      const t = design.loadTemplate(req.params.name);
      const theme = req.query.theme === 'dark' ? 'dark' : 'light';
      const width = Math.max(240, Math.min(4000, parseInt(req.query.width, 10) || 1024));
      let body;
      if (req.query.component) {
        const comp = t.components.find(c => c.id === req.query.component);
        if (!comp) return res.status(404).type('html').send('<p>component not found</p>');
        body = comp.html;
      } else if (t.components.length) {
        body = t.components.map(c =>
          `<div class="preview-item"><p class="preview-label">${escapeHtml(c.id)}</p>${c.html}</div>`).join('\n');
      } else {
        body = '<p style="color:var(--ui-text-muted)">No components yet — ask the studio agent to add one.</p>';
      }
      res.type('html').send(renderPreviewDoc(t.tokenTemplate, body, theme, width));
    } catch (err) { res.status(404).type('html').send(`<p>${escapeHtml(err.message)}</p>`); }
  });

  // ── Studio terminal: the selected tool's native TUI (unsafe), host or sandbox ──
  // Reuses the same pty.* socket events as the project terminal, keyed by a
  // `design:<name>` project_id so the existing xterm composable works unchanged.
  // Sandbox mode execs into a shared container that mounts ~/.jonggrang (design
  // store + templates) and the tool config dirs (~/.claude, ~/.opencode, …) plus
  // IS_SANDBOX=1 — mirroring the project sandbox DEFAULT_VOLUMES so the tool's
  // session/harness AND the store carry over.
  const pty = require('node-pty');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const designPtys = new Map(); // key: design:<name>

  const AGENT_IMAGE = process.env.JONGGRANG_AGENT_IMAGE || 'ghcr.io/porcupine-md/jonggrang-agent:dev';
  const DESIGN_CONTAINER = 'jonggrang-design-studio';

  function resolveToolCommand(tool) {
    switch (tool) {
      case 'claude':    return { cmd: 'claude',    args: ['--dangerously-skip-permissions'] };
      case 'opencode':  return { cmd: 'opencode',  args: [] };
      case 'codex':     return { cmd: 'codex',     args: [] };
      case 'jonggrang': return { cmd: 'jonggrang', args: ['agent'] };
      case 'shell':     return { cmd: 'bash',      args: [] };
      default:          return null;
    }
  }

  // Harness/config + design-store mounts (mirror the project sandbox DEFAULT_VOLUMES).
  function designMounts() {
    const home = os.homedir();
    const specs = [];
    const add = (src, dst) => { const s = src.replace(/^~/, home); if (fs.existsSync(s)) specs.push('-v', `${s}:${dst}`); };
    add('~/.jonggrang', '/root/.jonggrang');            // design store + templates
    add('~/.claude', '/root/.claude');
    add('~/.claude.json', '/root/.claude.json');
    add('~/.opencode', '/root/.opencode');
    add('~/.config/opencode', '/root/.config/opencode');
    add('~/.local/share/opencode', '/root/.local/share/opencode');
    add('~/.codex', '/root/.codex');
    return specs;
  }
  function containerRunning() {
    try { return execFileSync('docker', ['ps', '-q', '-f', `name=^${DESIGN_CONTAINER}$`], { encoding: 'utf8' }).trim().length > 0; }
    catch { return false; }
  }
  function ensureDesignContainer() {
    if (containerRunning()) return;
    try { execFileSync('docker', ['rm', '-f', DESIGN_CONTAINER], { stdio: 'ignore' }); } catch { /* not present */ }
    execFileSync('docker', ['run', '-d', '--name', DESIGN_CONTAINER, '--env', 'IS_SANDBOX=1', ...designMounts(), AGENT_IMAGE, 'sleep', 'infinity'], { stdio: 'ignore' });
  }
  function killAllPtys() {
    for (const proc of designPtys.values()) { try { proc.kill(); } catch { /* ignore */ } }
    designPtys.clear();
  }

  function spawnDesign(name, tool, cols, rows, sandbox) {
    const resolved = resolveToolCommand(tool);
    if (!resolved) throw new Error(`unsupported tool: ${tool}`);
    const key = `design:${name}`;
    if (designPtys.has(key)) { try { designPtys.get(key).kill(); } catch { /* ignore */ } designPtys.delete(key); }
    const dims = { cols: Math.max(20, cols | 0), rows: Math.max(6, rows | 0) };
    let proc;
    if (sandbox) {
      ensureDesignContainer();
      const cwd = `/root/.jonggrang/design/${name}`;
      proc = pty.spawn('docker', ['exec', '-it', '--workdir', cwd, DESIGN_CONTAINER, resolved.cmd, ...resolved.args],
        { name: 'xterm-256color', ...dims, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' } });
    } else {
      const dir = path.join(design.designRoot(), name);
      proc = pty.spawn(resolved.cmd, resolved.args,
        { name: 'xterm-256color', ...dims, cwd: dir, env: { ...process.env, TERM: 'xterm-256color' } });
    }
    designPtys.set(key, proc);
    proc.onData(data => { if (io && io.emit) io.emit('pty.data', { project_id: key, session: 'design', data }); });
    proc.onExit(({ exitCode }) => { designPtys.delete(key); if (io && io.emit) io.emit('pty.exit', { project_id: key, session: 'design', exitCode }); });
    return proc;
  }

  app.post('/api/design/:name/terminal/start', (req, res) => {
    try {
      const name = req.params.name;
      if (!fs.existsSync(path.join(design.designRoot(), name))) return res.status(404).json({ error: 'template not found' });
      const { cols = 80, rows = 24, tool = 'shell', sandbox = false } = req.body || {};
      spawnDesign(name, tool, cols, rows, !!sandbox);
      res.json({ ok: true, tool, sandbox: !!sandbox });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/design/:name/terminal/stop', (req, res) => {
    const key = `design:${req.params.name}`;
    const proc = designPtys.get(key);
    if (proc) { try { proc.kill(); } catch { /* ignore */ } designPtys.delete(key); }
    res.json({ ok: true });
  });

  // Sandbox container controls (shared across templates).
  app.get('/api/design/sandbox/status', (req, res) => {
    let running = false; try { running = containerRunning(); } catch { /* ignore */ }
    res.json({ container: DESIGN_CONTAINER, image: AGENT_IMAGE, running });
  });
  app.post('/api/design/sandbox/restart', (req, res) => {
    try { killAllPtys(); execFileSync('docker', ['restart', DESIGN_CONTAINER], { stdio: 'ignore' }); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/design/sandbox/rebuild', (req, res) => {
    try {
      killAllPtys();
      try { execFileSync('docker', ['rm', '-f', DESIGN_CONTAINER], { stdio: 'ignore' }); } catch { /* ignore */ }
      ensureDesignContainer();
      res.json({ ok: true, recreated: true, image: AGENT_IMAGE });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  if (io && io.on) {
    io.on('connection', socket => {
      socket.on('pty.input', ({ project_id, data }) => {
        if (typeof project_id === 'string' && project_id.startsWith('design:')) {
          const proc = designPtys.get(project_id);
          if (proc) proc.write(data);
        }
      });
      socket.on('pty.resize', ({ project_id, cols, rows }) => {
        if (typeof project_id === 'string' && project_id.startsWith('design:')) {
          const proc = designPtys.get(project_id);
          if (proc && cols > 0 && rows > 0) { try { proc.resize(cols, rows); } catch { /* ignore */ } }
        }
      });
    });
  }

  return function cleanup() {
    killAllPtys();
    if (designWatcher) { try { designWatcher.close(); } catch { /* ignore */ } }
  };
};
