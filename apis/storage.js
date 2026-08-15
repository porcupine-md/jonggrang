'use strict';

// Global object-storage API — S3-compatible uploads for plan mode + design studio.
// Config secrets live in ~/.jonggrang/web/storage.json (see lib/storage.js); the
// GET endpoint never returns the keys. Upload takes a raw body (any content-type)
// so large files skip base64 inflation and the app-level JSON parser.

const express = require('express');
const storage = require('../lib/storage');

module.exports = function register(app, io, _ctx) {
  // Non-secret config for the Settings UI.
  app.get('/api/storage/config', (req, res) => {
    try { res.json(storage.publicConfig()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Save config. undefined = leave as-is; '' = clear a field (mirrors git-tokens).
  app.put('/api/storage/config', (req, res) => {
    const b = req.body || {};
    try {
      const patch = {};
      for (const k of ['provider', 'endpoint', 'bucket', 'region', 'publicUrl', 'accessKeyId', 'secretAccessKey']) {
        if (b[k] !== undefined) patch[k] = String(b[k]);
      }
      if (b.forcePathStyle !== undefined) patch.forcePathStyle = !!b.forcePathStyle;
      storage.saveConfig(patch);
      res.json(storage.publicConfig());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Connectivity check for the Settings "Test" button.
  app.post('/api/storage/test', async (req, res) => {
    try { await storage.testConnection(); res.json({ ok: true }); }
    catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  // Upload a file → { key, url, filename }. Body is the raw file bytes; the name
  // comes from ?filename= (or X-Filename), the mime from Content-Type.
  app.post('/api/storage/upload', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
    try {
      if (!storage.isConfigured()) return res.status(400).json({ error: 'storage is not configured — set it in Settings' });
      const filename = req.query.filename || req.headers['x-filename'] || 'file';
      const contentType = req.headers['content-type'] || 'application/octet-stream';
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty upload body' });
      const result = await storage.upload(buf, String(filename), contentType);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return () => {};
};
