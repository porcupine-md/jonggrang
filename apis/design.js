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

  return function cleanup() {};
};
