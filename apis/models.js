'use strict';

const { execSync } = require('child_process');
const { Router } = require('express');
const os = require('os');
const path = require('path');

const STATIC_MODELS = {
  claude: [
    { value: 'default',     label: 'Default (account tier)' },
    { value: 'opus',        label: 'Opus (claude-opus-4-7)' },
    { value: 'sonnet',      label: 'Sonnet (claude-sonnet-4-6)' },
    { value: 'haiku',       label: 'Haiku (fast)' },
    { value: 'opusplan',    label: 'Opus Plan (plan: Opus, exec: Sonnet)' },
    { value: 'opus[1m]',    label: 'Opus 1M context' },
    { value: 'sonnet[1m]',  label: 'Sonnet 1M context' },
    { value: 'best',        label: 'Best (alias for opus)' },
  ],
  codex: [
    { value: 'gpt-5-codex',         label: 'GPT-5 Codex (default)' },
    { value: 'gpt-5.1-codex',       label: 'GPT-5.1 Codex' },
    { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark (fast iteration)' },
    { value: 'gpt-5.2',             label: 'GPT-5.2' },
    { value: 'codex-mini-latest',   label: 'Codex Mini (lower cost)' },
  ],
};

const STATIC_EFFORTS = {
  claude:    ['low', 'medium', 'high', 'xhigh', 'max'],
  codex:     ['low', 'medium', 'high'],
  opencode:  ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  jonggrang: [],
};

function fetchOpencodeModels() {
  try {
    const out = execSync('opencode models', { encoding: 'utf8', timeout: 8000 });
    return out.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(v => ({ value: v, label: v }));
  } catch {
    return [];
  }
}

async function fetchJonggrangModels() {
  try {
    const authPath = path.join(os.homedir(), '.jonggrang', 'agent', 'auth.json');
    const { AuthStorage, ModelRegistry } = await import('@earendil-works/pi-coding-agent');
    const authStorage = AuthStorage.create(authPath);
    const registry = ModelRegistry.create(authStorage);
    let models = registry.getAvailable();
    if (models.length === 0) models = registry.getAll();
    return models.map(m => ({
      value: m.id,
      label: `${m.name || m.id} (${m.provider})`,
    }));
  } catch {
    return [];
  }
}

module.exports = function(deps) {
  const router = Router();

  router.get('/models', async (req, res) => {
    const tool = req.query.tool || '';

    if (tool === 'opencode') {
      const models = fetchOpencodeModels();
      return res.json({ models, efforts: STATIC_EFFORTS.opencode });
    }

    if (tool === 'jonggrang') {
      const models = await fetchJonggrangModels();
      return res.json({ models, efforts: STATIC_EFFORTS.jonggrang });
    }

    const models = STATIC_MODELS[tool] || [];
    const efforts = STATIC_EFFORTS[tool] || [];
    res.json({ models, efforts });
  });

  return router;
};

// Per-tool reasoning-effort levels — the single source of truth shared with the
// plan/work request validators so the API never rejects an effort the UI offers.
module.exports.STATIC_EFFORTS = STATIC_EFFORTS;
