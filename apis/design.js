'use strict';

// Global design-template API (see lib/design.js + docs/plans/2026-08-15-jonggrang-design-studio.md).
// Backs the web "Design" studio: list/read/create/promote/save/delete templates, validate
// (lint on save), and render a self-contained preview document for a sandboxed <iframe>.

const fs = require('fs');
const path = require('path');
const design = require('../lib/design');
const uiContext = require('../lib/ui-context');

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
  const httpServer = _ctx && _ctx.server;
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

  // All selectable UI baselines (built-in packs + personal design templates),
  // as `<id>@<version>` keys. Feeds the New Plan "Design" picker so a baseline
  // can be chosen up front (plan --baseline <key>) instead of being asked for.
  app.get('/api/baselines', (req, res) => {
    try {
      const baselines = uiContext.listAllBaselinePacks()
        .filter(p => p.valid)
        .map(p => ({ key: p.key, id: p.id, version: p.version, intent: p.intent || '', source: p.source }));
      res.json({ baselines });
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

  // `resume` picks up the tool's prior conversation for this template instead of
  // starting fresh (claude --resume, opencode --continue, jonggrang/pi agent -r).
  function resolveToolCommand(tool, resume) {
    switch (tool) {
      case 'claude':    return { cmd: 'claude',    args: resume ? ['--dangerously-skip-permissions', '--resume'] : ['--dangerously-skip-permissions'] };
      case 'opencode':  return { cmd: 'opencode',  args: resume ? ['--continue'] : [] };
      case 'codex':     return { cmd: 'codex',     args: [] };
      case 'jonggrang': return { cmd: 'jonggrang', args: resume ? ['agent', '-r'] : ['agent'] };
      case 'shell':     return { cmd: 'bash',      args: [] };
      default:          return null;
    }
  }

  // Studio session ledger: remembers which (template, tool, mode) combos have had a
  // TUI opened, so the NEXT open resumes instead of starting a new conversation.
  // Kept in ~/.jonggrang/web/ (outside the design store the preview watcher watches).
  // Keyed by mode because sandbox (cwd /root/…) and host (cwd ~/…) sessions are
  // stored under different cwd keys by the tools and are not cross-resumable.
  function designSessionsFile() { return path.join(os.homedir(), '.jonggrang', 'web', 'design-sessions.json'); }
  function readDesignSessions() { try { return JSON.parse(fs.readFileSync(designSessionsFile(), 'utf8')); } catch { return {}; } }
  function designSessionKey(name, tool, sandbox) { return `${name}::${tool}::${sandbox ? 'sandbox' : 'host'}`; }
  function hasDesignSession(name, tool, sandbox) { return Boolean(readDesignSessions()[designSessionKey(name, tool, sandbox)]); }
  function markDesignSession(name, tool, sandbox) {
    try {
      const f = designSessionsFile();
      const s = readDesignSessions();
      s[designSessionKey(name, tool, sandbox)] = true;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    } catch { /* best-effort ledger */ }
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

  // True when the running studio container was created from a different image
  // than AGENT_IMAGE resolves to now. The studio container is long-lived — it
  // outlives image updates — so without this check a container started before a
  // tool landed in the image keeps running without it. That is exactly how the
  // studio agent ended up with no browser: its container predated the browser
  // being added, so the agent found nothing on PATH and installed its own.
  function containerImageDrifted() {
    try {
      const running = execFileSync('docker', ['inspect', '--format', '{{.Image}}', DESIGN_CONTAINER],
        { encoding: 'utf8' }).trim();
      const current = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', AGENT_IMAGE],
        { encoding: 'utf8' }).trim();
      return Boolean(running && current && running !== current);
    } catch {
      return false;   // image not pulled yet, or container gone — nothing to compare
    }
  }

  function ensureDesignContainer() {
    const running = containerRunning();
    if (running && !containerImageDrifted()) return;
    if (running) {
      console.log(`[design] studio container is running an older ${AGENT_IMAGE} — recreating`);
      killAllPtys();                       // its ptys point into the container we are replacing
    }
    try { execFileSync('docker', ['rm', '-f', DESIGN_CONTAINER], { stdio: 'ignore' }); } catch { /* not present */ }
    execFileSync('docker', ['run', '-d', '--name', DESIGN_CONTAINER, '--env', 'IS_SANDBOX=1', ...designMounts(), AGENT_IMAGE, 'sleep', 'infinity'], { stdio: 'ignore' });
  }
  function killAllPtys() {
    for (const proc of designPtys.values()) { try { proc.kill(); } catch { /* ignore */ } }
    designPtys.clear();
  }

  // The studio agent needs a URL it can actually open, which only the running
  // server knows. Resolved from the live bind address rather than an assumed
  // port so a dashboard on a custom port still works.
  //
  // A container cannot reach the host's loopback, so a sandbox session gets the
  // docker bridge gateway instead — which is what a sandbox deployment binds to
  // anyway. When the dashboard is bound to loopback only, nothing inside a
  // container can reach it; say so in the URL rather than handing the agent an
  // address that silently times out.
  const DOCKER_BRIDGE_HOST = '172.17.0.1';
  function designPreviewUrl(name, sandbox) {
    let host = '127.0.0.1';
    let port = 7777;
    try {
      const addr = httpServer && httpServer.address();
      if (addr && typeof addr === 'object') {
        port = addr.port || port;
        if (addr.address && addr.address !== '::' && addr.address !== '0.0.0.0') host = addr.address;
      }
    } catch { /* fall back to the defaults above */ }

    if (sandbox) {
      const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      host = loopback ? DOCKER_BRIDGE_HOST : host;
    }
    return `http://${host}:${port}/api/design/${encodeURIComponent(name)}/preview`;
  }

  function spawnDesign(name, tool, cols, rows, sandbox) {
    // Auto-resume: if this template+tool+mode has been opened before, launch the
    // tool with its resume/continue flag so it continues the prior conversation.
    const canResume = tool !== 'shell';
    const resume = canResume && hasDesignSession(name, tool, !!sandbox);
    const resolved = resolveToolCommand(tool, resume);
    if (!resolved) throw new Error(`unsupported tool: ${tool}`);

    // A template scaffolded before the brief existed would otherwise leave the
    // agent with no instructions at all — write it on first open.
    try {
      const wrote = design.writeStudioInstructions(path.join(design.designRoot(), name), name);
      if (wrote) console.log(`[design] wrote studio instructions into template ${name}`);
    } catch (err) { console.error('[design] could not write studio instructions:', err.message); }

    const previewUrl = designPreviewUrl(name, sandbox);
    const key = `design:${name}`;
    if (designPtys.has(key)) { try { designPtys.get(key).kill(); } catch { /* ignore */ } designPtys.delete(key); }
    const dims = { cols: Math.max(20, cols | 0), rows: Math.max(6, rows | 0) };
    let proc;
    if (sandbox) {
      ensureDesignContainer();
      const cwd = `/root/.jonggrang/design/${name}`;
      proc = pty.spawn('docker', ['exec', '-it', '--workdir', cwd,
        '--env', `JONGGRANG_DESIGN_PREVIEW=${previewUrl}`,
        DESIGN_CONTAINER, resolved.cmd, ...resolved.args],
        { name: 'xterm-256color', ...dims, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' } });
    } else {
      const dir = path.join(design.designRoot(), name);
      proc = pty.spawn(resolved.cmd, resolved.args,
        { name: 'xterm-256color', ...dims, cwd: dir,
          env: { ...process.env, TERM: 'xterm-256color', JONGGRANG_DESIGN_PREVIEW: previewUrl } });
    }
    designPtys.set(key, proc);
    // Record the session so the next open of this template+tool+mode resumes.
    if (canResume) markDesignSession(name, tool, !!sandbox);
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
