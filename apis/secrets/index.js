'use strict';

const { Router } = require('express');

function parseEnvText(text) {
  const vars = {};
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.replace(/^export\s+/, '');
    const eqIdx = withoutExport.indexOf('=');
    if (eqIdx < 1) continue;
    const key = withoutExport.slice(0, eqIdx).trim();
    let val = withoutExport.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) vars[key] = val;
  }
  return vars;
}

module.exports = function(deps) {
  const { webState } = deps;
  const router = Router();

  router.get('/secrets', (req, res) => {
    try {
      const secrets = webState.listSecrets().map(s => ({
        id: s.id,
        name: s.name,
        description: s.description || '',
        created_at: s.created_at,
        var_count: Object.keys(s.vars || {}).length,
      }));
      res.json({ secrets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/secrets/:id', (req, res) => {
    const secret = webState.getSecret(req.params.id);
    if (!secret) return res.status(404).json({ error: { code: 'SECRET_NOT_FOUND', message: 'Secret not found' } });
    res.json(secret);
  });

  router.post('/secrets', (req, res) => {
    const { name, description = '', vars, env_text } = req.body || {};
    if (!name) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    let resolvedVars = { ...(vars || {}) };
    if (env_text) Object.assign(resolvedVars, parseEnvText(env_text));
    const id = webState.generateId('sec');
    const record = { id, name, description, vars: resolvedVars, created_at: new Date().toISOString() };
    webState.createSecret(record);
    res.status(201).json(record);
  });

  router.put('/secrets/:id', (req, res) => {
    const secret = webState.getSecret(req.params.id);
    if (!secret) return res.status(404).json({ error: { code: 'SECRET_NOT_FOUND', message: 'Secret not found' } });
    const { name, description, vars, env_text } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (vars !== undefined) patch.vars = vars;
    if (env_text) patch.vars = { ...(patch.vars || secret.vars || {}), ...parseEnvText(env_text) };
    try {
      res.json(webState.updateSecret(req.params.id, patch));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/secrets/:id', (req, res) => {
    if (!webState.getSecret(req.params.id)) return res.status(404).json({ error: { code: 'SECRET_NOT_FOUND', message: 'Secret not found' } });
    webState.deleteSecret(req.params.id);
    res.status(204).send();
  });

  return router;
};
