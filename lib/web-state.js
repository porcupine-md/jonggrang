'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const WEB_HOME = process.env.JONGGRANG_WEB_HOME || path.join(os.homedir(), '.jonggrang', 'web');
const INDEX_FILE = path.join(WEB_HOME, 'index.json');
const DEFAULT_WORKSPACE = path.join(os.homedir(), '.jonggrang', 'workspace');

function ensureWebHome() {
  fs.mkdirSync(WEB_HOME, { recursive: true });
}

function generateId(prefix = 'proj') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function _loadRaw() {
  ensureWebHome();
  try {
    if (fs.existsSync(INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    }
  } catch {}
  return null;
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

// Derive plan-loop state purely from filesystem — never store this
function deriveState(projectPath) {
  const planPath = path.join(projectPath, '.jonggrang', 'plan.md');
  const tasksPath = path.join(projectPath, '.jonggrang', 'jonggrang-tasks.json');

  if (fs.existsSync(planPath)) {
    const stat = fs.statSync(planPath);
    return { state: 'draft', planMtime: stat.mtimeMs };
  }

  if (!fs.existsSync(tasksPath)) return { state: 'idle' };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
  } catch {
    return { state: 'idle' };
  }

  const tasks = data.tasks || [];
  if (tasks.length === 0) return { state: 'idle' };

  const hasInProgress = tasks.some(t => t.status === 'in_progress');
  if (hasInProgress) return { state: 'working', tasks };

  const allDone = tasks.every(t => ['completed', 'skipped'].includes(t.status));
  if (allDone) return { state: 'done', tasks };

  return { state: 'tasks_pending', tasks };
}

function detectStack(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return { stack: 'nextjs-typescript', type: 'web-app' };
      if (deps.express || deps.fastify || deps.koa) return { stack: 'express-typescript', type: 'api' };
      if (pkg.bin) return { stack: 'node-typescript', type: 'cli' };
      return { stack: 'node-typescript', type: 'library' };
    } catch {}
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
    planFile: path.join(jonggrangDir, 'plan.md'),
    progressFile: path.join(jonggrangDir, 'progress.txt'),
  };
}

module.exports = {
  WEB_HOME,
  generateId,
  loadIndex,
  saveIndex,
  getWorkspacePath,
  setWorkspacePath,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  deriveState,
  detectStack,
  getProjectPaths,
};
