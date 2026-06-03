'use strict';

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const sandbox = require('../../lib/sandbox');

module.exports = function(deps) {
  const { webState } = deps;
  const router = Router();

  // ── SSH key for in-container git push ────────────────────────────
  // GET returns only status (never the private key).
  router.get('/:id/ssh-key', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    res.json(sandbox.sshKeyStatus(project.id));
  });

  // PUT { key } writes a per-project private key (chmod 600). Restart sandbox to apply.
  router.put('/:id/ssh-key', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'key (PEM/OpenSSH private key) required' } });
    }
    try {
      sandbox.writeProjectSshKey(project.id, key);
      res.json({ ok: true, ...sandbox.sshKeyStatus(project.id) });
    } catch (err) {
      res.status(400).json({ error: { code: 'INVALID_KEY', message: err.message } });
    }
  });

  // DELETE removes the per-project key (falls back to global → ~/.ssh/id_rsa).
  router.delete('/:id/ssh-key', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    sandbox.removeProjectSshKey(project.id);
    res.json({ ok: true, ...sandbox.sshKeyStatus(project.id) });
  });

  router.get('/:id/settings', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    const configPath = path.join(project.path, '.jonggrang', 'jonggrang.json');
    let jonggrang_config = {};
    try { jonggrang_config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (err) {
      if (err.code !== 'ENOENT') console.error('Failed to read project config:', err);
    }
    res.json({ jonggrang_config, secrets: project.secrets || [], sandbox: project.sandbox || {} });
  });

  router.put('/:id/settings', (req, res) => {
    const project = webState.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    const { secrets, jonggrang_config, sandbox } = req.body || {};
    if (Array.isArray(secrets)) {
      try { webState.updateProject(req.params.id, { secrets }); } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    if (sandbox && typeof sandbox === 'object') {
      try { webState.updateProject(req.params.id, { sandbox }); } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    if (jonggrang_config && typeof jonggrang_config === 'object') {
      const jonggrangDir = path.join(project.path, '.jonggrang');
      const configPath = path.join(jonggrangDir, 'jonggrang.json');
      try {
        fs.mkdirSync(jonggrangDir, { recursive: true });
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (err) {
          if (err.code !== 'ENOENT') console.error('Failed to read existing project config:', err);
        }
        Object.assign(existing, jonggrang_config);
        fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    res.json({ ok: true });
  });

  return router;
};
