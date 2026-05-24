'use strict';

// lib/settings.js — Jonggrang two-layer settings
//
// Global:  ~/.jonggrang/settings.json   (user-wide defaults)
// Project: .jonggrang/jonggrang.json    (project overrides, already the main config)
//
// Merge: project wins over global.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const GLOBAL_DIR          = path.join(os.homedir(), '.jonggrang');
const GLOBAL_SETTINGS_FILE = path.join(GLOBAL_DIR, 'settings.json');

// ── Read ──────────────────────────────────────────────────────────────────────

function loadGlobal() {
  try {
    if (fs.existsSync(GLOBAL_SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

function loadProject(projectRoot) {
  const file = path.join(projectRoot, '.jonggrang', 'jonggrang.json');
  try {
    if (fs.existsSync(file))
      return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return {};
}

// Returns merged view: project values override global defaults.
// Keys returned: tool, autonomy (flattened from mode.autonomy), name, etc.
function loadMerged(projectRoot) {
  const g = loadGlobal();
  const p = loadProject(projectRoot);

  const globalFlat = {
    tool:     g.tool     || 'jonggrang',
    autonomy: (g.mode && g.mode.autonomy) || g.autonomy || 'autonomous',
  };
  const projectFlat = {
    tool:     p.tool     || undefined,
    autonomy: (p.mode && p.mode.autonomy) || p.autonomy || undefined,
  };

  return {
    tool:     projectFlat.tool     ?? globalFlat.tool,
    autonomy: projectFlat.autonomy ?? globalFlat.autonomy,
  };
}

// ── Write ─────────────────────────────────────────────────────────────────────

function saveGlobalField(key, value) {
  let settings = loadGlobal();
  if (key === 'autonomy') {
    if (!settings.mode) settings.mode = {};
    settings.mode.autonomy = value;
  } else {
    settings[key] = value;
  }
  if (!fs.existsSync(GLOBAL_DIR)) fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function saveProjectField(projectRoot, key, value) {
  const dir  = path.join(projectRoot, '.jonggrang');
  const file = path.join(dir, 'jonggrang.json');
  let config = {};
  try {
    if (fs.existsSync(file))
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  if (key === 'autonomy') {
    if (!config.mode) config.mode = {};
    config.mode.autonomy = value;
  } else {
    config[key] = value;
  }

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

module.exports = { loadGlobal, loadProject, loadMerged, saveGlobalField, saveProjectField, GLOBAL_SETTINGS_FILE };
