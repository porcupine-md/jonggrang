'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DEFAULT_AGENT_IMAGE } = require('./sandbox');

const WEB_HOME = process.env.JONGGRANG_WEB_HOME || path.join(os.homedir(), '.jonggrang', 'web');
const INDEX_FILE = path.join(WEB_HOME, 'index.json');
const SECRETS_FILE = path.join(WEB_HOME, 'secrets.json');
const VOLUMES_FILE = path.join(WEB_HOME, 'volumes.json');
const DEFAULT_WORKSPACE = path.join(os.homedir(), '.jonggrang', 'workspace');

// Default volume mounts — mirrors what was hardcoded in sandbox.js.
// source uses "~" which sandbox.js expands to os.homedir() at runtime.
const DEFAULT_VOLUMES = [
  { id: 'claude',         label: 'Claude config',       source: '~/.claude',                     destination: '/root/.claude',                     type: 'bind', enabled: true },
  { id: 'opencode',       label: 'OpenCode config',     source: '~/.opencode',                   destination: '/root/.opencode',                   type: 'bind', enabled: true },
  { id: 'jonggrang',      label: 'Jonggrang data',      source: '~/.jonggrang',                  destination: '/root/.jonggrang',                  type: 'bind', enabled: true },
  { id: 'opencode-cfg',   label: 'OpenCode config dir', source: '~/.config/opencode',            destination: '/root/.config/opencode',            type: 'bind', enabled: true },
  { id: 'opencode-share', label: 'OpenCode share dir',  source: '~/.local/share/opencode',       destination: '/root/.local/share/opencode',       type: 'bind', enabled: true },
  { id: 'claude-json',    label: 'Claude JSON file',    source: '~/.claude.json',                destination: '/root/.claude.json',                type: 'bind', enabled: true },
  { id: 'codex',          label: 'Codex config',        source: '~/.codex',                      destination: '/root/.codex',                      type: 'bind', enabled: true },
];

function ensureWebHome() {
  fs.mkdirSync(WEB_HOME, { recursive: true });
}

function generateId(prefix = 'proj') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function _loadRaw() {
  ensureWebHome();
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function loadIndex() {
  const raw = _loadRaw();
  if (raw) return raw;
  return {
    version: 1,
    workspace_path: DEFAULT_WORKSPACE,
    projects: {},
  };
}

function saveIndex(index) {
  ensureWebHome();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

function getWorkspacePath() {
  return loadIndex().workspace_path;
}

function setWorkspacePath(p) {
  const index = loadIndex();
  index.workspace_path = path.resolve(p);
  saveIndex(index);
  return index.workspace_path;
}

function listProjects() {
  return Object.values(loadIndex().projects);
}

function getProject(id) {
  return loadIndex().projects[id] || null;
}

function createProject(record) {
  const index = loadIndex();
  index.projects[record.id] = record;
  saveIndex(index);
  return record;
}

function updateProject(id, patch) {
  const index = loadIndex();
  if (!index.projects[id]) throw new Error(`Project ${id} not found`);
  Object.assign(index.projects[id], patch);
  saveIndex(index);
  return index.projects[id];
}

function deleteProject(id) {
  const index = loadIndex();
  delete index.projects[id];
  saveIndex(index);
}

// Remove projects stuck in 'importing' — orphaned by a server crash/restart mid-import.
// Also removes the leftover filesystem directory so git clone won't reject it next time.
function cleanupStaleImports() {
  const index = loadIndex();
  let changed = false;
  for (const [id, p] of Object.entries(index.projects)) {
    if (p.init_status === 'importing') {
      if (p.path && p.source?.type !== 'local') {
        try { fs.rmSync(p.path, { recursive: true, force: true }); } catch {}
      }
      delete index.projects[id];
      changed = true;
    }
  }
  if (changed) saveIndex(index);
}

// ── Secrets ──────────────────────────────────────────────────────────────────

function loadSecrets() {
  ensureWebHome();
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveSecrets(secrets) {
  ensureWebHome();
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), 'utf-8');
}

function listSecrets() {
  return Object.values(loadSecrets());
}

function getSecret(id) {
  return loadSecrets()[id] || null;
}

function createSecret(record) {
  const secrets = loadSecrets();
  secrets[record.id] = record;
  saveSecrets(secrets);
  return record;
}

function updateSecret(id, patch) {
  const secrets = loadSecrets();
  if (!secrets[id]) throw new Error(`Secret ${id} not found`);
  Object.assign(secrets[id], patch);
  saveSecrets(secrets);
  return secrets[id];
}

function deleteSecret(id) {
  const secrets = loadSecrets();
  delete secrets[id];
  saveSecrets(secrets);
}

// Global git-host tokens (GH_TOKEN / GITLAB_TOKEN) for gh & glab CLIs. Stored
// in the web index; injected into every agent/container env via the secret vars.
function getGitTokens() {
  const t = loadIndex().git_tokens || {};
  const out = {};
  if (t.GH_TOKEN) out.GH_TOKEN = t.GH_TOKEN;
  if (t.GITLAB_TOKEN) out.GITLAB_TOKEN = t.GITLAB_TOKEN;
  return out;
}

function setGitTokens(patch) {
  const index = loadIndex();
  const next = Object.assign({}, index.git_tokens || {}, patch);
  // Empty string clears a token.
  for (const k of Object.keys(next)) { if (!next[k]) delete next[k]; }
  index.git_tokens = next;
  saveIndex(index);
  return getGitTokens();
}

// ── Issue sources & pickups (GitHub/GitLab issue import — feature #55) ────────
// `issue_sources`: the repos the user selected to list issues from.
// `issue_pickups`: mapping of an imported issue → the plan/project it seeded.
function getIssueSources() {
  const s = loadIndex().issue_sources || {};
  return {
    github: Array.isArray(s.github) ? s.github : [],
    gitlab: Array.isArray(s.gitlab) ? s.gitlab : [],
  };
}

function setIssueSources(next) {
  const index = loadIndex();
  const clean = (arr) => Array.from(new Set(
    (Array.isArray(arr) ? arr : []).map(v => String(v).trim()).filter(Boolean)
  ));
  index.issue_sources = { github: clean(next && next.github), gitlab: clean(next && next.gitlab) };
  saveIndex(index);
  return getIssueSources();
}

function getIssuePickups() {
  const p = loadIndex().issue_pickups;
  return Array.isArray(p) ? p : [];
}

function addIssuePickup(record) {
  const index = loadIndex();
  if (!Array.isArray(index.issue_pickups)) index.issue_pickups = [];
  index.issue_pickups.push(record);
  saveIndex(index);
  return record;
}

function updateIssuePickup(id, patch) {
  const index = loadIndex();
  const list = Array.isArray(index.issue_pickups) ? index.issue_pickups : [];
  const rec = list.find(r => r.id === id);
  if (!rec) return null;
  Object.assign(rec, patch);
  saveIndex(index);
  return rec;
}

function getProjectSecretVars(projectId) {
  // Global git tokens first, then project secrets (which may override).
  const merged = { ...getGitTokens() };
  const project = getProject(projectId);
  if (project && Array.isArray(project.secrets) && project.secrets.length > 0) {
    const secrets = loadSecrets();
    for (const secretId of project.secrets) {
      const secret = secrets[secretId];
      if (secret && secret.vars) Object.assign(merged, secret.vars);
    }
  }
  return merged;
}

// List draft sessions under .drafts/, newest-first by plan.md mtime.
// Returns [{ name, mtime }] or null if the directory is unreadable / missing.
function listDraftSessions(projectPath) {
  const dir = path.join(projectPath, '.jonggrang', '.drafts');
  if (!fs.existsSync(dir)) return null;
  try {
    return fs.readdirSync(dir)
      .map(name => {
        try { return { name, mtime: fs.statSync(path.join(dir, name, 'plan.md')).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    return { error: err };
  }
}

// Merge tasks across all feature files (per-feature state).
// Returns { tasks, error } — error is set if any feature file is corrupt.
function readAllFeatureTasks(projectPath) {
  const featuresDir = path.join(projectPath, '.jonggrang', '.output', 'features');
  const tasks = [];
  if (!fs.existsSync(featuresDir)) return { tasks, error: null };
  for (const name of fs.readdirSync(featuresDir)) {
    const p = path.join(featuresDir, name, 'jonggrang-tasks.json');
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (Array.isArray(data.tasks)) tasks.push(...data.tasks);
    } catch (err) {
      return { tasks, error: { reason: 'corrupt_tasks_file', message: err.message } };
    }
  }
  return { tasks, error: null };
}

// Derive plan-loop state purely from filesystem — never store this
function deriveState(projectPath) {
  const drafts = listDraftSessions(projectPath);
  if (drafts && drafts.error) {
    return { state: 'error', reason: 'corrupt_draft_dir', message: drafts.error.message };
  }
  if (drafts && drafts.length > 0) {
    return { state: 'draft', planMtime: drafts[0].mtime, draftCount: drafts.length };
  }

  const { tasks, error } = readAllFeatureTasks(projectPath);
  if (error) return { state: 'error', ...error };

  if (tasks.length === 0) return { state: 'idle' };

  if (tasks.some(t => t.status === 'in_progress')) return { state: 'working', tasks };

  if (tasks.every(t => ['completed', 'skipped'].includes(t.status))) {
    return { state: 'done', tasks };
  }

  // If MANIFEST says running but all tasks are still pending, the feature is
  // in orchestration mode (phase 8+ running via runOrchestrationLoop).
  try {
    const featuresDir = path.join(projectPath, '.jonggrang', '.output', 'features');
    if (fs.existsSync(featuresDir)) {
      for (const name of fs.readdirSync(featuresDir)) {
        const mPath = path.join(featuresDir, name, 'MANIFEST.yaml');
        if (!fs.existsSync(mPath)) continue;
        const yaml = require('js-yaml');
        const manifest = yaml.load(fs.readFileSync(mPath, 'utf8'));
        if (manifest?.status === 'running') {
          const featureTasks = tasks.filter(t => t.feature_id === manifest.feature_id);
          if (featureTasks.length > 0 && featureTasks.every(t => t.status === 'pending')) {
            return { state: 'orchestrating', tasks, current_phase: manifest.current_phase };
          }
        }
      }
    }
  } catch {}

  return { state: 'tasks_pending', tasks };
}

function detectStack(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return { stack: 'nextjs-typescript', type: 'web-app' };
    if (deps.express || deps.fastify || deps.koa) return { stack: 'express-typescript', type: 'api' };
    if (pkg.bin) return { stack: 'node-typescript', type: 'cli' };
    return { stack: 'node-typescript', type: 'library' };
  }
  if (fs.existsSync(path.join(projectPath, 'go.mod'))) return { stack: 'go', type: 'api' };
  if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) return { stack: 'rust', type: 'cli' };
  const hasPy = fs.existsSync(path.join(projectPath, 'pyproject.toml'))
    || fs.existsSync(path.join(projectPath, 'requirements.txt'));
  if (hasPy) return { stack: 'python-fastapi', type: 'api' };
  return { stack: 'node-typescript', type: 'library' };
}

function getProjectPaths(projectPath) {
  const jonggrangDir = path.join(projectPath, '.jonggrang');
  return {
    jonggrangDir,
    configFile: path.join(jonggrangDir, 'jonggrang.json'),
    tasksFile: path.join(jonggrangDir, 'jonggrang-tasks.json'),
    legacyPlanFile: path.join(jonggrangDir, 'plan.md'),
    progressFile: path.join(jonggrangDir, 'progress.txt'),
  };
}

function getSandboxConfig() {
  const defaults = { image: DEFAULT_AGENT_IMAGE, shell: '/bin/bash', network: 'jonggrang' };
  return Object.assign(defaults, loadIndex().sandbox_config || {});
}

function setSandboxConfig(patch) {
  const index = loadIndex();
  const defaults = { image: DEFAULT_AGENT_IMAGE, shell: '/bin/bash', network: 'jonggrang' };
  index.sandbox_config = Object.assign(defaults, index.sandbox_config || {}, patch);
  saveIndex(index);
  return index.sandbox_config;
}

// ── Volume mounts (volumes.json) ─────────────────────────────────────────────

function getVolumes() {
  ensureWebHome();
  try {
    const raw = fs.readFileSync(VOLUMES_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return DEFAULT_VOLUMES.map(v => ({ ...v }));
    throw err;
  }
}

function setVolumes(volumes) {
  ensureWebHome();
  fs.writeFileSync(VOLUMES_FILE, JSON.stringify(volumes, null, 2), 'utf-8');
  return volumes;
}

function initVolumes() {
  ensureWebHome();
  try {
    fs.accessSync(VOLUMES_FILE);
  } catch {
    fs.writeFileSync(VOLUMES_FILE, JSON.stringify(DEFAULT_VOLUMES.map(v => ({ ...v })), null, 2), 'utf-8');
  }
}

module.exports = {
  WEB_HOME,
  generateId,
  loadIndex,
  saveIndex,
  getWorkspacePath,
  setWorkspacePath,
  getSandboxConfig,
  setSandboxConfig,
  getVolumes,
  setVolumes,
  initVolumes,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  cleanupStaleImports,
  listSecrets,
  getSecret,
  createSecret,
  updateSecret,
  deleteSecret,
  getProjectSecretVars,
  getGitTokens,
  setGitTokens,
  getIssueSources,
  setIssueSources,
  getIssuePickups,
  addIssuePickup,
  updateIssuePickup,
  readAllFeatureTasks,
  deriveState,
  detectStack,
  getProjectPaths,
};
