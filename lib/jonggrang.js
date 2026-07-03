//
// JONGGRANG — Shared Library
// Core functions used by both CLI (bin/jonggrang.js) and web server (server.js)
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync, execFile } = require('child_process');
const { buildAgentArgs } = require('./backend-args');

// ============================================================
// CONFIGURATION HELPERS
// ============================================================

function resolveSkillsDir(projectRoot, tool) {
  if (tool === 'claude') return path.join(projectRoot, '.claude', 'skills');
  if (tool === 'opencode') return path.join(projectRoot, '.opencode', 'skills');
  if (tool === 'jonggrang') return path.join(projectRoot, '.jonggrang', 'skills');
  if (tool === 'codex') return path.join(projectRoot, '.codex', 'skills');
  // 'both' or unknown — prefer whichever tool-specific dir already exists
  const claudeSkills = path.join(projectRoot, '.claude', 'skills');
  if (fileExists(claudeSkills)) return claudeSkills;
  const opencodeSkills = path.join(projectRoot, '.opencode', 'skills');
  if (fileExists(opencodeSkills)) return opencodeSkills;
  return path.join(projectRoot, 'skills'); // legacy fallback
}

function getProjectPaths(projectRoot) {
  const jonggrangDir = path.join(projectRoot, '.jonggrang');
  const configFile = path.join(jonggrangDir, 'jonggrang.json');
  const tool = (() => { try { return readJSON(configFile)?.tool || null; } catch { return null; } })();
  return {
    configFile,
    tasksFile: path.join(jonggrangDir, 'jonggrang-tasks.json'),       // legacy root location — only used by migration read in cmdInit
    legacyPlanFile: path.join(jonggrangDir, 'plan.md'),                    // legacy pending draft path — migrated to .drafts/<session>/plan.md
    questionsFile: path.join(jonggrangDir, 'plan-questions.json'),        // legacy root sidecar — superseded by per-draft questionsFileFor()
    answersFile: path.join(jonggrangDir, 'plan-answers.json'),          // legacy root sidecar — superseded by per-draft answersFileFor()
    progressFile: path.join(jonggrangDir, 'progress.txt'),               // legacy root location — only used by migration read in cmdInit
    agentsFile: path.join(projectRoot, 'AGENTS.md'),
    skillsDir: resolveSkillsDir(projectRoot, tool),
  };
}

// ============================================================
// PER-FEATURE STATE PATHS
// ============================================================
// Tasks and progress live per-feature, colocated with plan.md / MANIFEST.yaml
// under .jonggrang/.output/features/<feature_id>/. Callers MUST resolve the
// feature id before calling — there is no implicit "active feature".

function featureFileFor(projectRoot, featureId, fileName) {
  if (!featureId) throw new Error(`featureFileFor: featureId is required (${fileName})`);
  return path.join(projectRoot, '.jonggrang', '.output', 'features', featureId, fileName);
}

const tasksFileFor = (projectRoot, featureId) => featureFileFor(projectRoot, featureId, 'jonggrang-tasks.json');
const progressFileFor = (projectRoot, featureId) => featureFileFor(projectRoot, featureId, 'progress.txt');

// Merge every feature's tasks file into one view. Used ONLY by cross-feature
// views (cmdStatus, cmdList, dashboard, task-id auto-lookup). Per-feature
// operations read a single feature file via tasksFileFor().
function getAllTasks(projectRoot) {
  const root = projectRoot || process.cwd();
  const featuresDir = path.join(root, '.jonggrang', '.output', 'features');
  if (!fileExists(featuresDir)) return { feature: '', branch: '', tasks: [] };
  const merged = { tasks: [] };
  for (const name of fs.readdirSync(featuresDir)) {
    const p = tasksFileFor(root, name);
    const data = readJSON(p);
    if (data && Array.isArray(data.tasks)) {
      // Ensure every task carries feature_id (redundant w/ folder, but cheap & stable)
      for (const t of data.tasks) {
        if (!t.feature_id) t.feature_id = name;
      }
      merged.tasks.push(...data.tasks);
    }
  }
  return merged;
}

// Resolve the "most recent incomplete feature" for commands without a task-id
// context (task add / task next default). Mirrors findIncompleteManifest
// ordering: MANIFEST status running|in_progress|paused|failed, newest updated_at.
function resolveActiveFeature(projectRoot) {
  const featuresDir = path.join(projectRoot, '.jonggrang', '.output', 'features');
  if (!fileExists(featuresDir)) return null;
  const yaml = require('js-yaml');
  const candidates = [];
  for (const name of fs.readdirSync(featuresDir)) {
    const manifestPath = path.join(featuresDir, name, 'MANIFEST.yaml');
    let m = null;
    try { m = yaml.load(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
    if (!m || !['running', 'in_progress', 'paused', 'failed'].includes(m.status)) continue;
    candidates.push({ featureId: name, updated_at: m.updated_at || m.created_at || '' });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return candidates[0].featureId;
}

// Locate which feature a task-id lives in, by scanning all feature files.
// Used by task-id commands (show/update/done/block/remove) to resolve the
// correct per-feature file without requiring --feature. Returns the featureId
// or null if the task isn't found anywhere.
function findTaskFeature(projectRoot, taskId) {
  const all = getAllTasks(projectRoot);
  const task = all.tasks.find(t => t.id === taskId);
  return task ? (task.feature_id || null) : null;
}

// ============================================================
// PLAN DRAFTS (pre-approval, per-session)
// ============================================================
// Drafts live under .jonggrang/.drafts/<session-id>/plan.md — gitignored and
// persistent (survive restart, unlike .ephemeral/). A draft is pre-approval
// scaffolding: it has no feature_id yet (that's generated at approve from the
// AI's feature name). Concurrent planning is safe by construction — each
// `jonggrang plan` call gets its own session-id. Approve moves plan.md into
// features/<feature_id>/ and discards the draft folder.

function draftsDir(projectRoot) {
  return path.join(projectRoot, '.jonggrang', '.drafts');
}

function draftFileFor(projectRoot, sessionId) {
  if (!sessionId) throw new Error('draftFileFor: sessionId is required');
  return path.join(draftsDir(projectRoot), sessionId, 'plan.md');
}

function draftDirFor(projectRoot, sessionId) {
  if (!sessionId) throw new Error('draftDirFor: sessionId is required');
  return path.join(draftsDir(projectRoot), sessionId);
}

// Clarifying-questions/answers sidecars live PER-DRAFT, colocated with plan.md
// under .drafts/<session>/. Q&A exists before a feature_id does (that's minted
// at approve), so the draft session-id is the natural key. Per-draft placement
// makes concurrent planning safe — two `plan` runs no longer clobber a shared
// root singleton — and lets `--revise`/delete clean up the Q&A with the draft.
function questionsFileFor(projectRoot, sessionId) {
  if (!sessionId) throw new Error('questionsFileFor: sessionId is required');
  return path.join(draftDirFor(projectRoot, sessionId), 'plan-questions.json');
}

function answersFileFor(projectRoot, sessionId) {
  if (!sessionId) throw new Error('answersFileFor: sessionId is required');
  return path.join(draftDirFor(projectRoot, sessionId), 'plan-answers.json');
}

// Resolve the newest draft session carrying a pending plan-questions.json.
// A draft mid Pass-A has questions but no plan.md yet, so resolveActiveDraft()
// (which requires plan.md) can't see it — this scans by questions-file mtime.
// Used by the web to relay/read questions before the plan itself is generated.
function resolveActiveQuestionDraft(projectRoot) {
  const dir = draftsDir(projectRoot);
  if (!fileExists(dir)) return null;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names) {
    const qf = path.join(dir, name, 'plan-questions.json');
    let st;
    try { st = fs.statSync(qf); } catch { continue; }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtime) best = { sessionId: name, mtime: st.mtimeMs };
  }
  return best ? best.sessionId : null;
}

/**
 * Post-run verification for plan-writing agent calls.
 * Ensures the draft file exists at the session path after the agent runs.
 * If the agent wrote to the legacy root `.jonggrang/plan.md` instead of the
 * session draftPath, auto-move it into place (self-healing) and return 'moved'.
 * Returns: 'ok' (draft already present) | 'moved' (recovered from root) | 'missing' (not found).
 */
function verifyDraftWritten(projectRoot, draftFile) {
  if (fileExists(draftFile)) return 'ok';
  const rootPlan = path.join(projectRoot, '.jonggrang', 'plan.md');
  if (fileExists(rootPlan)) {
    try {
      fs.renameSync(rootPlan, draftFile);
      if (fileExists(draftFile)) return 'moved';
    } catch { }
  }
  return 'missing';
}

// Session-id: draft-<slug>-<ts>. Visually distinct from feature folders so
// drafts vs features are unambiguous in the .drafts/ vs features/ namespaces.
function generateDraftId(description) {
  const slug = (description || 'plan')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
  const ts = Date.now().toString(36);
  return `draft-${slug}-${ts}`;
}

// List all draft sessions, newest-first by folder mtime. Each entry includes
// parsed frontmatter (feature/description) for display.
function getAllDrafts(projectRoot) {
  const dir = draftsDir(projectRoot);
  if (!fileExists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const sessionDir = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(sessionDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const planPath = path.join(sessionDir, 'plan.md');
    if (!fileExists(planPath)) continue;
    // Use plan.md mtime (not folder mtime) — folder mtime gets bumped by
    // unrelated deep-plan intermediate files; plan.md mtime reflects when the
    // plan was last written/revised, which is the right "most recent" signal.
    let planStat;
    try { planStat = fs.statSync(planPath); } catch { continue; }
    let fm = { feature: '', description: '' };
    try {
      const content = fs.readFileSync(planPath, 'utf8');
      const get = (k) => { const m = content.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
      fm = { feature: get('feature'), description: get('description') };
    } catch { }
    out.push({ sessionId: name, planPath, mtime: planStat.mtime, feature: fm.feature, description: fm.description });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Resolve the most-recent draft session-id (for `approve`/`status` default).
// Returns the sessionId or null if no drafts exist.
function resolveActiveDraft(projectRoot) {
  const drafts = getAllDrafts(projectRoot);
  return drafts.length > 0 ? drafts[0].sessionId : null;
}

// Migrate legacy root .jonggrang/jonggrang-tasks.json + progress.txt into
// per-feature files under .output/features/<id>/. Called only from cmdInit.
// Idempotent: no-op if root files don't exist.
//
// - Tasks: grouped by feature_id; null feature_id → synthetic legacy-<ts> folder.
// - progress.txt: copied into every existing feature folder (learnings are
//   global; per-feature split isn't worth the parsing complexity), then root deleted.
// Returns { migratedTasks, migratedProgress, features: [...] } for logging.
function migrateLegacyTaskState(projectRoot) {
  const paths = getProjectPaths(projectRoot);
  const featuresDir = path.join(projectRoot, '.jonggrang', '.output', 'features');
  const legacyStamp = `legacy-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 14)}`;
  const result = { migratedTasks: 0, migratedProgress: false, features: [] };

  // ── Migrate tasks ──
  if (fileExists(paths.tasksFile)) {
    const data = readJSON(paths.tasksFile);
    if (data && Array.isArray(data.tasks) && data.tasks.length > 0) {
      fs.mkdirSync(featuresDir, { recursive: true });
      const groups = new Map();
      for (const task of data.tasks) {
        const fid = task.feature_id || legacyStamp;
        if (!groups.has(fid)) groups.set(fid, []);
        groups.get(fid).push(task);
      }
      for (const [fid, tasks] of groups) {
        const dir = path.join(featuresDir, fid);
        fs.mkdirSync(dir, { recursive: true });
        const tf = tasksFileFor(projectRoot, fid);
        // Merge into any existing feature file (don't clobber)
        const existing = fileExists(tf) ? readJSON(tf) : { tasks: [] };
        existing.tasks = (existing.tasks || []).concat(tasks);
        writeJSON(tf, existing);
        result.migratedTasks += tasks.length;
        result.features.push(fid);
      }
    }
    fs.unlinkSync(paths.tasksFile);
  }

  // ── Migrate progress.txt ──
  if (fileExists(paths.progressFile)) {
    const content = fs.readFileSync(paths.progressFile, 'utf8');
    if (content.trim()) {
      fs.mkdirSync(featuresDir, { recursive: true });
      let copied = false;
      for (const name of fs.readdirSync(featuresDir)) {
        const dir = path.join(featuresDir, name);
        try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
        const pf = progressFileFor(projectRoot, name);
        if (!fileExists(pf)) {
          fs.writeFileSync(pf, content);
          copied = true;
        }
      }
      // If no feature folders existed, create a legacy one to hold progress
      if (!copied) {
        const dir = path.join(featuresDir, legacyStamp);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(progressFileFor(projectRoot, legacyStamp), content);
        if (!result.features.includes(legacyStamp)) result.features.push(legacyStamp);
      }
      result.migratedProgress = true;
    }
    fs.unlinkSync(paths.progressFile);
  }

  return result;
}

// Migrate a legacy root .jonggrang/plan.md (pending draft) into a per-session
// draft folder under .drafts/. Called only from cmdInit. Idempotent: no-op if
// root plan.md doesn't exist. Returns the session-id or null.
function migrateLegacyPlanDraft(projectRoot) {
  const paths = getProjectPaths(projectRoot);
  if (!fileExists(paths.legacyPlanFile)) return null;
  let content = '';
  try { content = fs.readFileSync(paths.legacyPlanFile, 'utf8'); } catch { return null; }
  if (!content.trim()) { try { fs.unlinkSync(paths.legacyPlanFile); } catch { } return null; }

  // Derive a session-id from the plan's feature name if present, else 'plan'
  let featureName = 'plan';
  try {
    const m = content.match(/^feature:\s*(.+)$/m);
    if (m) featureName = m[1].trim();
  } catch { }
  const sid = generateDraftId(featureName);
  const draftDir = draftDirFor(projectRoot, sid);
  fs.mkdirSync(draftDir, { recursive: true });
  fs.copyFileSync(paths.legacyPlanFile, draftFileFor(projectRoot, sid));
  try { fs.unlinkSync(paths.legacyPlanFile); } catch { }
  return sid;
}

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function findSkills(dir, prefix = '') {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(prefix, entry.name);
      if (fileExists(path.join(fullPath, 'SKILL.md'))) {
        results.push(relPath);
      } else {
        results.push(...findSkills(fullPath, relPath));
      }
    }
  } catch { /* ignore */ }
  return results;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Atomic write — write to temp file then rename to prevent corruption
// on concurrent writes or crashes mid-write
function writeJSON(p, data) {
  const tmpFile = p + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmpFile, p);
}

function readConfig(configFile, key, defaultVal = '') {
  try {
    const config = readJSON(configFile);
    const keys = key.replace(/^\./, '').split('.');
    let val = config;
    for (const k of keys) {
      if (val == null) return defaultVal;
      val = val[k];
    }
    return val != null ? String(val) : defaultVal;
  } catch {
    return defaultVal;
  }
}

function checkConfig(configFile) {
  if (!fileExists(configFile)) {
    throw new Error(`.jonggrang/jonggrang.json not found. Run 'jonggrang init' first.`);
  }
}

// ── State validation ─────────────────────────────────────────

function validateConfigFile(configFilePath) {
  if (!fileExists(configFilePath)) return { valid: false, reason: 'missing' };
  const data = readJSON(configFilePath);
  if (!data) return { valid: false, reason: 'corrupt' };
  if (typeof data.name !== 'string' || !data.name) return { valid: false, reason: 'missing_field', field: 'name' };
  if (typeof data.project !== 'object' || !data.project?.stack) return { valid: false, reason: 'missing_field', field: 'project.stack' };
  return { valid: true };
}

function validateProjectState(projectRoot) {
  // Only config is required. Tasks/progress are per-feature and created on
  // demand at approve time — their absence is not an error.
  const paths = getProjectPaths(projectRoot);
  const config = validateConfigFile(paths.configFile);
  return { allValid: config.valid, config };
}

// ============================================================
// TASK MANAGEMENT
// ============================================================

function getTasks(tasksFile) {
  return readJSON(tasksFile) || { tasks: [] };
}

function getNextTask(tasksFile) {
  const data = getTasks(tasksFile);
  const done = data.tasks.filter(t => t.status === 'completed').map(t => t.id);
  const candidates = data.tasks
    .filter(t => t.status === 'pending' || t.status === 'in_progress')
    .filter(t => {
      const blockedBy = t.blocked_by || [];
      return blockedBy.length === 0 || blockedBy.every(id => done.includes(id));
    })
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));
  return candidates.length > 0 ? candidates[0].id : null;
}

function getTask(tasksFile, taskId) {
  const data = getTasks(tasksFile);
  return data.tasks.find(t => t.id === taskId) || null;
}

// Resolve dependency chain for a task — returns ordered list of task IDs
// that need to be completed before (and including) the target task.
function getTaskQueue(tasksFile, targetId) {
  const data = getTasks(tasksFile);
  const taskMap = new Map(data.tasks.map(t => [t.id, t]));
  const queue = [];
  const visited = new Set();

  function collect(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const task = taskMap.get(id);
    if (!task) return;
    for (const dep of (task.blocked_by || [])) {
      collect(dep);
    }
    // Only include tasks that are not yet completed
    if (task.status !== 'completed') {
      queue.push(id);
    }
  }

  collect(targetId);
  return queue;
}

function updateTaskStatus(tasksFile, taskId, status) {
  const data = getTasks(tasksFile);
  const task = data.tasks.find(t => t.id === taskId);
  if (task) {
    task.status = status;
    writeJSON(tasksFile, data);
  }
}

function markTaskDone(tasksFile, taskId) {
  const data = getTasks(tasksFile);
  const task = data.tasks.find(t => t.id === taskId);
  if (task) {
    task.status = 'completed';
    task.passes = true;
    task.completed_at = new Date().toISOString();
    writeJSON(tasksFile, data);
  }
}

function countPending(tasksFile) {
  const data = getTasks(tasksFile);
  return data.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'waiting').length;
}

function revertWaiting(tasksFile) {
  const data = getTasks(tasksFile);
  let changed = false;
  for (const task of data.tasks) {
    if (task.status === 'waiting') {
      task.status = 'pending';
      changed = true;
    }
  }
  if (changed) writeJSON(tasksFile, data);
}

function countCompleted(tasksFile) {
  const data = getTasks(tasksFile);
  return data.tasks.filter(t => t.status === 'completed').length;
}

function countTotal(tasksFile) {
  const data = getTasks(tasksFile);
  return data.tasks.length;
}

// ── Task CRUD ─────────────────────────────────────────────────
//
// Task IDs are GLOBALLY unique across all features (required by the
// auto-lookup UX: `jonggrang task done task-005` must resolve to one task).
// addTask/addTasksBulk therefore scan ALL feature files via getAllTasks to
// continue numbering and detect collisions, even though they write to a single
// feature file. Read/update/remove operate on a single resolved feature file
// (tasksFile) — callers resolve the path first.

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked', 'waiting', 'skipped']);

// Build a task object with the canonical schema. `defaultPriority` is used when
// the caller didn't supply one. Status/timestamps/flags are set here so the
// shape stays consistent across addTask/addTasksBulk/import paths.
function makeTask(taskData, id, featureId, defaultPriority) {
  return {
    id,
    title: taskData.title || '',
    description: taskData.description || '',
    priority: taskData.priority != null ? taskData.priority : defaultPriority,
    status: 'pending',
    feature_id: featureId,
    skill: taskData.skill || null,
    blocked_by: taskData.blocked_by || [],
    passes: false,
    files: taskData.files || [],
    started_at: null,
    completed_at: null,
    error_log: [],
  };
}

// Find the largest task-NNN number across all task objects. Used by both
// generateTaskId (single add) and addTasksBulk (continues numbering inline).
function maxTaskNumber(allTasks) {
  let maxNum = 0;
  for (const t of allTasks) {
    const m = (t.id || '').match(/^task-(\d+)$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  return maxNum;
}

function addTask(projectRoot, featureId, taskData) {
  const tasksFile = tasksFileFor(projectRoot, featureId);
  const data = getTasks(tasksFile);
  const all = getAllTasks(projectRoot);
  const id = taskData.id || `task-${String(maxTaskNumber(all.tasks) + 1).padStart(3, '0')}`;
  if (all.tasks.some(t => t.id === id)) {
    throw new Error(`Task ${id} already exists`);
  }
  const task = makeTask(taskData, id, featureId, data.tasks.length + 1);
  data.tasks.push(task);
  writeJSON(tasksFile, data);
  return task;
}

function addTasksBulk(projectRoot, featureId, taskDataArray) {
  const tasksFile = tasksFileFor(projectRoot, featureId);
  const data = getTasks(tasksFile);
  const all = getAllTasks(projectRoot);
  let nextNum = maxTaskNumber(all.tasks);
  const created = [];
  for (const taskData of taskDataArray) {
    const id = taskData.id || `task-${String(++nextNum).padStart(3, '0')}`;
    if (all.tasks.some(t => t.id === id) || created.some(t => t.id === id)) {
      throw new Error(`Task ${id} already exists`);
    }
    const task = makeTask(taskData, id, featureId, data.tasks.length + 1);
    data.tasks.push(task);
    created.push(task);
  }
  writeJSON(tasksFile, data);
  return created;
}

function updateTask(tasksFile, taskId, updates) {
  const data = getTasks(tasksFile);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  if (updates.status && !VALID_STATUSES.has(updates.status)) {
    throw new Error(`Invalid status: ${updates.status}. Valid: ${[...VALID_STATUSES].join(', ')}`);
  }

  const UPDATABLE = new Set([
    'title', 'description', 'priority', 'status', 'skill',
    'blocked_by', 'files', 'passes', 'error_log',
  ]);

  for (const [key, value] of Object.entries(updates)) {
    if (UPDATABLE.has(key)) task[key] = value;
  }

  if (updates.status === 'in_progress' && !task.started_at) {
    task.started_at = new Date().toISOString();
  }
  if (updates.status === 'completed') {
    task.completed_at = new Date().toISOString();
    if (updates.passes === undefined) task.passes = true;
  }

  writeJSON(tasksFile, data);
  return task;
}

function removeTask(tasksFile, taskId) {
  const data = getTasks(tasksFile);
  const idx = data.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) throw new Error(`Task ${taskId} not found`);

  const removed = data.tasks.splice(idx, 1)[0];

  // Clean up dangling blocked_by references
  for (const task of data.tasks) {
    if (task.blocked_by && task.blocked_by.includes(taskId)) {
      task.blocked_by = task.blocked_by.filter(id => id !== taskId);
    }
  }

  writeJSON(tasksFile, data);
  return removed;
}

// ============================================================
// DETECTION HELPERS
// ============================================================

function detectStack(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (fileExists(pkgPath)) {
    if (fileExists(path.join(dir, 'next.config.js')) ||
      fileExists(path.join(dir, 'next.config.mjs')) ||
      fileExists(path.join(dir, 'next.config.ts'))) {
      return 'nextjs-typescript';
    }
    try {
      const pkg = fs.readFileSync(pkgPath, 'utf8');
      if (pkg.includes('"express"')) return 'express-typescript';
    } catch { /* ignore */ }
    return 'node-typescript';
  }
  if (fileExists(path.join(dir, 'go.mod'))) return 'go';
  if (fileExists(path.join(dir, 'pyproject.toml')) || fileExists(path.join(dir, 'requirements.txt'))) {
    try {
      const reqs = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8');
      if (reqs.includes('fastapi')) return 'python-fastapi';
    } catch { /* ignore */ }
    try {
      const pyproj = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
      if (pyproj.includes('fastapi')) return 'python-fastapi';
    } catch { /* ignore */ }
    return 'python';
  }
  if (fileExists(path.join(dir, 'Cargo.toml'))) return 'rust';
  return 'unknown';
}

function detectTestFramework(dir) {
  if (fileExists(path.join(dir, 'vitest.config.ts')) || fileExists(path.join(dir, 'vitest.config.js'))) return 'vitest';
  if (fileExists(path.join(dir, 'jest.config.js')) || fileExists(path.join(dir, 'jest.config.ts'))) return 'jest';
  if (fileExists(path.join(dir, 'pytest.ini')) || fileExists(path.join(dir, 'conftest.py'))) return 'pytest';
  try {
    const files = fs.readdirSync(dir);
    if (files.some(f => f.endsWith('_test.go'))) return 'go-test';
  } catch { /* ignore */ }
  return 'none';
}

function detectCI(dir) {
  if (fileExists(path.join(dir, '.github', 'workflows'))) return 'github-actions';
  if (fileExists(path.join(dir, '.gitlab-ci.yml'))) return 'gitlab-ci';
  return 'none';
}

function stackToType(stack) {
  if (stack === 'nextjs-typescript') return 'web-app';
  if (stack === 'library-typescript') return 'library';
  if (stack === 'rust') {
    // Rust can be lib or CLI — default to library (most common OSS Rust pattern)
    return 'library';
  }
  // express-typescript, node-typescript, go, python-fastapi, python → api
  return 'api';
}

function getTestCommand(framework) {
  switch (framework) {
    case 'vitest': return 'npx vitest run';
    case 'jest': return 'npx jest --passWithNoTests';
    case 'go-test': return 'go test ./...';
    case 'pytest': return 'pytest';
    default: return "echo 'no test command configured'";
  }
}

// ============================================================
// PROMPT BUILDERS
// ============================================================

/**
 * Derive projectRoot from a config or tasks file path. Falls back to cwd.
 * Used by prompt builders that don't get projectRoot as a direct arg.
 */
function _projectRootFromPath(p) {
  if (!p) return process.cwd();
  try {
    // Resolve to absolute first; then strip .jonggrang/<file> → project root.
    const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    // path.dirname(abs) → ends in .jonggrang → dirname again → project root
    return path.dirname(path.dirname(abs));
  } catch { return process.cwd(); }
}

/**
 * Build the project context block for a prompt. Tries the codemap (LLM-free,
 * cached at .jonggrang/codemap/codemap.json) first and falls back to the
 * legacy "embed config + tell agent to read AGENTS.md" approach when the
 * codemap is unavailable.
 *
 * @param {string} projectRootOrConfigFile path to .jonggrang/jonggrang.json,
 *                                         .jonggrang/jonggrang-tasks.json, or
 *                                         an explicit project root
 * @param {object} [opts]
 * @param {number} [opts.maxChars=4500]    cap for the codemap section
 * @param {string} [opts.configFile]       optional: legacy fallback config
 * @returns {string}                       markdown block
 */
function buildProjectContext(projectRootOrConfigFile, opts = {}) {
  const maxChars = opts.maxChars != null ? opts.maxChars : 4500;
  // If the path looks like a file inside .jonggrang/, strip two dirs; otherwise treat as root.
  let projectRoot = projectRootOrConfigFile;
  if (projectRoot && /\.jonggrang[\\/]/.test(projectRoot)) {
    projectRoot = _projectRootFromPath(projectRoot);
  }
  if (!projectRoot) projectRoot = process.cwd();

  let block = '';

  try {
    const codemap = require('./codemap');
    const { codemap: cm, stale } = codemap.getOrGenerateCodemap(projectRoot);
    if (cm) {
      block = `## Project Context (codemap)\n\n${codemap.formatCodemapMarkdown(cm, { maxChars })}`;
      if (stale) {
        block += `\n\n> ⚠️ Codemap may be outdated (project changed since ${cm.generatedAt}). Run \`jonggrang codemap --refresh\` to update.`;
      }
    }
  } catch { /* fall through to legacy */ }

  if (!block) {
    // Legacy fallback — embed raw config and tell the agent to read AGENTS.md.
    let configSection = '';
    if (opts.configFile && fileExists(opts.configFile)) {
      const cfg = readJSON(opts.configFile);
      if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
    }
    block = `## Project Context\n${configSection}- Read AGENTS.md for project conventions\n- Check existing code structure with ls/find if needed`;
  }

  return block;
}

function buildWorkPrompt(taskId, tasksFile, mode, testFeedback) {
  const task = getTask(tasksFile, taskId);
  if (!task) return '';

  const taskTitle = task.title || taskId;
  const taskDesc = task.description || task.title;
  const taskSkill = task.skill || '';

  const skillLine = taskSkill
    ? `Read the skill template: skills/${taskSkill}/SKILL.md`
    : 'Plan your implementation approach';

  // testFeedback (from test runner) takes priority over env var
  const revisionFeedback = testFeedback || process.env.JONGGRANG_REVISION_FEEDBACK;
  const revisionSection = revisionFeedback
    ? `\n## Test Failure Feedback\nThe previous implementation attempt failed validation. Fix the issues below before marking the task complete.\n\n\`\`\`\n${revisionFeedback}\n\`\`\`\n`
    : '';

  const featureId = task.feature_id || null;
  const progressPath = featureId
    ? `.jonggrang/.output/features/${featureId}/progress.txt`
    : '.jonggrang/progress.txt';
  const bugCmd = featureId
    ? `jonggrang bug "description" --feature ${featureId}`
    : `jonggrang bug "description"`;

  return `# Jonggrang Work Session${revisionSection}

${buildProjectContext(tasksFile, { maxChars: 3000 })}

## Current Task
- ID: ${taskId}
- Title: ${taskTitle}
- Description: ${taskDesc}${featureId ? `\n- Feature: ${featureId}` : ''}

## Mode: ${mode}

## Context Files
Read these files for additional context before starting:
- AGENTS.md (project conventions)
- ${progressPath} (learnings from previous sessions)${featureId ? `\n- .jonggrang/.output/features/${featureId}/plan.md (feature plan — archived after approval, do NOT read .jonggrang/plan.md)` : ''}
Note: .jonggrang/plan.md does not exist during execution — the plan was archived to the path above after approval.

## Task CLI — use these commands, do NOT read the tasks file directly
\`\`\`bash
jonggrang task show ${taskId}          # full detail of current task
jonggrang task list                    # see all tasks and their statuses
jonggrang task list pending            # see only pending tasks
jonggrang task next                    # see next eligible task after this one
jonggrang task update ${taskId} --status in_progress   # mark as started
jonggrang task done ${taskId}          # mark as completed
jonggrang task update ${taskId} --files src/foo.ts,src/bar.ts  # record files touched
\`\`\`

## Instructions
1. Read the context files listed above
2. Mark task as started: \`jonggrang task update ${taskId} --status in_progress\`
3. ${skillLine}
4. Implement the task
5. Run validation: typecheck, tests, lint
6. If all pass, commit with message format: "type(scope): description". Stage ONLY the code/files your task changed — never \`git add\` \`.jonggrang/\` or \`node_modules/\` (jonggrang state and dependencies must stay out of feature branches; prefer \`git add <specific files>\` over \`git add -A\`/\`git add .\`). Always add a trailing blank line then "${COAUTHOR_TRAILER}" as the last line of the commit message.
7. Mark task done: \`jonggrang task done ${taskId}\`
8. Append learnings to ${progressPath}

## Bug Reporting
If you discover a bug that is OUTSIDE the scope of the current task:
\`\`\`bash
${bugCmd}
# When asked "Create a task now?" → enter: n  (don't interrupt current task)
\`\`\`
- Do NOT fix out-of-scope bugs inline — stay focused on this task
- The bug will be logged to bugs.md and can be converted to a task later
- Only report bugs that are real defects, not TODOs or style issues

## Important
- Keep changes atomic — only modify files relevant to this task
- Follow conventions in AGENTS.md
- If you discover new patterns or gotchas, note them in ${progressPath}
- If validation fails and you can't fix it in 2 attempts, stop and report the error
`;
}

// ============================================================
// TWO-PHASE PLANNING — PHASE 1: DRAFT PLAN
// ============================================================

/**
 * Build a prompt for Phase 1: generate a human-readable plan.md draft.
 * The AI writes the draft to `draftPath` but does NOT touch jonggrang-tasks.json.
 */
function buildDraftPlanPrompt(description, configFile, projectRoot, draftPath, srcPath = null, opts = {}) {
  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  // When the user has already answered the agent's clarifying questions, inject
  // them as authoritative context so the plan reflects the real intent.
  const clarSection = opts.clarifications
    ? `## Clarifications from User (authoritative — do NOT ask again)\n${opts.clarifications}\n\n`
    : '';

  // Only embed completed tasks (across all features) — to prevent re-doing finished work
  let completedSection = '';
  const allTasks = getAllTasks(projectRoot);
  const done = allTasks.tasks.filter(t => t.status === 'completed');
  if (done.length > 0) {
    completedSection = `## Already Completed Work\nDo NOT plan to redo these:\n${done.map(t => `- ${t.id}: ${t.title}`).join('\n')}\n`;
  }

  const now = new Date().toISOString();

  return `# Jonggrang — Generate Draft Plan

${buildFeatureSection(description, srcPath)}

${buildProjectContext(configFile, { maxChars: 3000 })}

${completedSection}${clarSection}## Your Task

Create a high-level plan for this feature. Write it to \`${draftPath}\` using EXACTLY this format:

\`\`\`
---
feature: short-kebab-case-name
branch: feat/short-kebab-case-name
work_type: BUGFIX|SMALL|MEDIUM|LARGE
description: one-line summary of the feature
created_at: ${now}
---

# Plan: Feature Name Here

## Approach
2-4 sentences: technical approach, architecture decisions, what changes.

## Phases
1. Phase name — what happens (one focused session)
2. Phase name — what happens
...

## Key Decisions
- Decision: choice + brief rationale
- Decision: choice + brief rationale

## Out of Scope
- What is NOT included in this plan
- Helps avoid scope creep during implementation

## Dependencies
Existing code, services, or patterns this builds on. Write "None" if not applicable.
\`\`\`

## Rules
- work_type: BUGFIX=fix existing behavior, SMALL=1-3 files, MEDIUM=new feature module, LARGE=subsystem/cross-service
- 3-8 phases max — keep them high-level, not detailed task steps
- Do NOT write code or file-level implementation details
- Do NOT write to the tasks file — tasks come in Phase 2 after human review
- After writing the plan, output exactly: "Draft plan written to ${draftPath}"`;
}

// ============================================================
// TWO-PHASE PLANNING — PHASE 1.5: REVISE PLAN WITH AI
// ============================================================

/**
 * Build a prompt to revise an existing draft plan based on user feedback.
 * The AI rewrites the draft at `draftFile` in-place, preserving frontmatter unless explicitly changed.
 */
function buildRevisePlanPrompt(currentPlanContent, feedback, draftFile, opts = {}) {
  const clarSection = opts.clarifications
    ? `\n## Earlier Clarifications from User (still authoritative)\n${opts.clarifications}\n`
    : '';
  return `# Jonggrang — Revise Draft Plan

${buildProjectContext(process.cwd(), { maxChars: 2500 })}

## Current plan.md
\`\`\`markdown
${currentPlanContent}
\`\`\`

## User Feedback
${feedback}
${clarSection}
## Your Task

Revise the plan above based on the user feedback.

Rules:
- Preserve the YAML frontmatter (feature, branch, work_type, description, created_at) UNLESS the feedback explicitly asks to change them
- Update the plan body: Approach, Phases, Key Decisions, Out of Scope, Dependencies
- Keep the exact same markdown structure and section headings
- Do NOT change work_type unless the user explicitly asks
- Write the revised plan to \`${draftFile}\` (overwrite the file)
- After writing, output exactly: "Revised plan written to ${draftFile}"`;
}

// ============================================================
// TWO-PHASE PLANNING — PHASE 2: DECOMPOSE PLAN TO TASKS
// ============================================================

/**
 * Build a prompt for Phase 2: convert an approved plan.md into jonggrang-tasks.json.
 * planContent is the raw text of the approved plan.md.
 */
function buildTasksFromPlanPrompt(planContent, configFile, projectRoot, featureId, skillsDir) {
  let skillsList = '';
  if (skillsDir && fileExists(skillsDir)) {
    skillsList = findSkills(skillsDir).join(', ');
  }

  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  // Show existing tasks across ALL features so the agent continues global ID numbering
  // (task IDs are globally unique) instead of restarting at task-001.
  const tasksFile = featureId ? tasksFileFor(projectRoot, featureId) : null;
  let currentTasksSection = '';
  let updateNote = '';
  const allTasks = getAllTasks(projectRoot);
  if (allTasks.tasks.length > 0) {
    const existingIds = allTasks.tasks.map(t => t.id).join(', ');
    currentTasksSection = `## Existing Task IDs (across all features — continue numbering from here)\n${existingIds}\n`;
    const completedInFeature = featureId
      ? allTasks.tasks.filter(t => t.feature_id === featureId && t.status === 'completed').length
      : 0;
    if (completedInFeature > 0) {
      updateNote = `\n## ⚠️ UPDATE MODE\n${completedInFeature} tasks already completed in this feature — NEVER modify or remove them. Append new tasks after the last existing ID.\n`;
    }
  }

  const featureFlag = featureId ? ` --feature ${featureId}` : '';

  return `# Jonggrang — Decompose Approved Plan to Tasks

${buildProjectContext(configFile, { maxChars: 2500 })}

## Approved Plan
\`\`\`markdown
${planContent.trim()}
\`\`\`

## Project Context
${configSection}${currentTasksSection}${updateNote}
- Read AGENTS.md for project conventions

## Available Skills
${skillsList || '(none configured)'}

## Your Task
Decompose every phase from the approved plan above into detailed implementation tasks.

**Use the CLI to add tasks — do NOT edit the tasks file directly.**

Run this single command to add all tasks at once:
\`\`\`bash
jonggrang task import${featureFlag} --input '<JSON array of task objects>'
\`\`\`

Each task object in the array must follow this schema:
\`\`\`json
{
  "id": "task-001",
  "title": "Clear actionable title",
  "description": "Detailed description with acceptance criteria. Which files? What exact behavior?",
  "priority": 1,
  "skill": "skill-name-or-null",
  "files": ["src/example.ts"],
  "blocked_by": ["task-001"]
}
\`\`\`

## Rules
- Task IDs are GLOBALLY unique across all features. Continue numbering from the existing IDs listed above — do NOT restart at task-001. If the last existing ID is task-007, start at task-008.
- Always include "id" (task-008, task-009, ...) so blocked_by references work correctly
- Each task must be completable in a single AI context window
- Description must be detailed enough to implement without ambiguity
- Use blocked_by to encode phase dependencies using the "id" values you defined
- priority 1 = first to execute, 2 = next, etc.
- Cover ALL phases — do not skip any phase from the plan
- After running the import command, report a brief summary: how many tasks per phase`;
}

function buildPlanPrompt(description, updateMode, tasksFile, skillsDir, configFile) {
  // List available skills
  let skillsList = '';
  if (fileExists(skillsDir)) {
    skillsList = findSkills(skillsDir).join(', ');
  }

  // Embed project config directly — no need for agent to read the file
  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  // Embed current tasks directly — no need for agent to read the file
  let currentTasksSection = '';
  let updateInstructions = '';
  if (fileExists(tasksFile)) {
    const data = getTasks(tasksFile);
    currentTasksSection = `## Current Tasks\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;

    if (updateMode && data.tasks?.length) {
      const completedCount = data.tasks.filter(t => t.status === 'completed').length;
      const pendingCount = data.tasks.filter(t => t.status === 'pending').length;
      const totalCount = data.tasks.length;
      updateInstructions = `
## UPDATE MODE
This is a plan UPDATE, not a fresh plan. The tasks file already has ${totalCount} tasks (${completedCount} completed, ${pendingCount} pending).

Rules for update mode:
- NEVER remove or modify tasks with status "completed" — they are done
- You may modify tasks with status "pending" (update description, reorder, etc.)
- You may add new tasks with new IDs (continue numbering from the last existing task ID)
- You may remove pending tasks that are no longer needed
- Update blocked_by references if dependencies changed
- Keep the existing feature name and branch unless the user explicitly wants to change them
- Re-prioritize remaining pending tasks based on the new description
`;
    }
  }

  return `# Jonggrang Plan — Decompose Feature

${buildProjectContext(configFile, { maxChars: 3000 })}

## Feature Description
${description}

## Project Context
${configSection}
${currentTasksSection}
- Read AGENTS.md for project conventions
- Check existing code structure with ls/find if needed

## Available Skills
These skill templates exist in skills/ and can be referenced in tasks: ${skillsList}
${updateInstructions}
## Instructions
1. Analyze the feature description and project context above
2. Decompose into atomic tasks where each task:
   - Is small enough to complete in one AI context window
   - Has a clear, detailed description with acceptance criteria
   - Specifies which files will be created or modified
   - Has dependency ordering (blocked_by) if it depends on other tasks
3. Write the tasks directly to \`${tasksFile}\` using this exact schema:

\`\`\`json
{
  "feature": "short-feature-name",
  "branch": "feat/short-feature-name",
  "tasks": [
    {
      "id": "task-001",
      "title": "Clear actionable title",
      "description": "Detailed description with acceptance criteria.",
      "priority": 1,
      "status": "pending",
      "owner": null,
      "skill": "skill-name-or-null",
      "skill_inputs": {},
      "files": ["src/file1.ts", "src/file2.ts"],
      "blocked_by": [],
      "passes": false,
      "retry_count": 0,
      "started_at": null,
      "completed_at": null,
      "error_log": []
    }
  ]
}
\`\`\`

4. Important rules:
   - The first task should always set up the project foundation if starting from scratch
   - Include a final task for tests if not covered by earlier tasks
   - Each task description must be detailed enough for an AI agent to implement without ambiguity
   - Use "blocked_by": ["task-001"] when a task depends on another
   - Set "skill" to a matching skill name (e.g. "scaffold-api", "testing", "component") or null
   - priority: 1 = highest (do first), 2 = next, etc.
   - Create as many tasks as needed to fully cover the feature — do not artificially limit the number

5. After writing the tasks file, report the plan summary`;
}

function buildReviewPrompt() {
  return `# Jonggrang Review Session

${buildProjectContext(process.cwd(), { maxChars: 3000 })}

## Instructions
1. Read AGENTS.md for project conventions
2. Run \`git log --oneline -20\` to see recent changes
3. Run \`git diff HEAD~10\` (or appropriate range) to see all changes
4. Analyze the changes for:

### Code Quality
- Consistency with project patterns
- Clean code principles
- No dead code or unused imports
- Proper error handling at boundaries

### Security
- No hardcoded secrets
- Input validation at API boundaries
- No SQL injection / XSS patterns
- Dependency vulnerabilities (check package.json)

### Testing
- Adequate test coverage for new code
- Tests are meaningful (not just coverage padding)
- Edge cases covered

### Performance
- No N+1 queries
- No unnecessary re-renders (React)
- No memory leak patterns
- Reasonable bundle size impact

5. Write a review summary to jonggrang-log/review-{date}.md
6. Note any issues found with severity (HIGH/MEDIUM/LOW)
7. Suggest AGENTS.md updates if new patterns were discovered`;
}

// ============================================================
// AGENT RUNNER
// ============================================================

function runAgent(prompt, tool, permMode, projectRoot, options = {}) {
  const debug = Boolean(options.debug);
  const model = options.model || '';
  const effort = options.effort || '';
  const captureText = Boolean(options.captureText);
  // Accumulated text output when captureText is true; null otherwise.
  const textChunks = captureText ? [] : null;

  // Validate model/effort flags early (throws on invalid combos, e.g. bare
  // model name for OpenCode) and translate to backend-specific argv fragments.
  const extraFlags = buildAgentArgs({ tool, model, effort });

  // When captureText is on, resolve with { code, text } instead of a plain number.
  function finish(code) {
    const c = code || 0;
    return captureText ? { code: c, text: textChunks.join('') } : c;
  }

  function debugLine(line) {
    if (!debug) return;
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    process.stderr.write(`\x1b[36m\x1b[2m[json ${ts}]\x1b[0m \x1b[2m${line}\x1b[0m\n`);
  }

  return new Promise((resolve) => {
    if (tool === 'opencode') {
      // opencode run --format json [--model provider/model] [--variant level] <prompt>
      // Permissions are configured via opencode.json (generated during init)
      const child = spawn('opencode', ['run', '--format', 'json', ...extraFlags, prompt], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let buffer = '';
      let atLineStart = true;
      let totalCost = 0;
      const printedTools = new Set(); // track tool IDs already printed

      function handleOpenCodeLine(line) {
        if (!line.trim()) return;
        debugLine(line);
        let obj;
        try { obj = JSON.parse(line); } catch {
          process.stdout.write(line + '\n');
          atLineStart = true;
          return;
        }

        if (obj.type === 'text') {
          const text = obj.part?.text || '';
          if (text) {
            process.stdout.write(text);
            atLineStart = text.endsWith('\n');
            if (textChunks) textChunks.push(text);
          }
        } else if (obj.type === 'tool_use') {
          const part = obj.part || {};
          const toolId = part.id || null;
          const toolName = part.tool || '?';
          const state = part.state || {};
          const input = state.input || {};

          const hasOutput = state.output !== undefined;
          const hasError = state.error !== undefined;

          // Completion update for a tool we already printed
          if (toolId && printedTools.has(toolId) && (hasOutput || hasError)) {
            if (hasError) {
              const msg = String(state.error).split('\n')[0].slice(0, 120);
              process.stdout.write(`  \x1b[31m✗ ${msg}\x1b[0m\n`);
            } else {
              const out = state.output ? String(state.output).split('\n')[0].trim().slice(0, 120) : '';
              process.stdout.write(`  \x1b[32m✓\x1b[0m${out ? ` \x1b[2m${out}\x1b[0m` : ''}\n`);
            }
            printedTools.delete(toolId);
            return;
          }

          // Already handled — skip duplicate streaming events with no new info
          if (toolId && printedTools.has(toolId)) return;

          // First appearance: print the tool line
          const detail = input.command || input.file || input.file_path || input.path
            || input.pattern || input.url || input.query || state.title || '';
          if (!atLineStart) process.stdout.write('\n');
          process.stdout.write(`\x1b[90m▸ ${toolName}\x1b[0m`);
          if (detail) {
            const short = detail.length > 80 ? detail.slice(0, 77) + '...' : detail;
            process.stdout.write(` \x1b[2m${short}\x1b[0m`);
          }
          process.stdout.write('\n');
          atLineStart = true;

          if (toolId) {
            // If result already arrived in the same event, show it immediately
            if (hasError) {
              const msg = String(state.error).split('\n')[0].slice(0, 120);
              process.stdout.write(`  \x1b[31m✗ ${msg}\x1b[0m\n`);
            } else if (hasOutput) {
              const out = state.output ? String(state.output).split('\n')[0].trim().slice(0, 120) : '';
              process.stdout.write(`  \x1b[32m✓\x1b[0m${out ? ` \x1b[2m${out}\x1b[0m` : ''}\n`);
            } else {
              printedTools.add(toolId); // wait for a completion event
            }
          }

        } else if (obj.type === 'step_finish') {
          totalCost += obj.part?.cost || 0;
        }
      }

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) handleOpenCodeLine(line);
      });

      child.stderr.on('data', (d) => process.stderr.write(d));

      child.on('close', (code) => {
        if (buffer.trim()) handleOpenCodeLine(buffer);
        if (!atLineStart) process.stdout.write('\n');
        if (totalCost > 0) {
          process.stdout.write(`\x1b[2m[cost: $${totalCost.toFixed(4)}]\x1b[0m\n`);
        }
        resolve(finish(code));
      });

    } else if (tool === 'claude') {
      const claudeFlags = [];
      switch (permMode) {
        case 'autonomous': claudeFlags.push('--dangerously-skip-permissions'); break;
        case 'balanced': claudeFlags.push('--permission-mode', 'acceptEdits'); break;
        case 'supervised': claudeFlags.push('--permission-mode', 'default'); break;
      }

      const args = [
        '-p',
        ...claudeFlags,
        '--add-dir', projectRoot,
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        ...extraFlags,
      ];

      const child = spawn('claude', args, {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin.write(prompt);
      child.stdin.end();

      let streamError = false;
      let buffer = '';
      let inToolBlock = false;
      let atLineStart = true;
      let toolInputBuffer = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finalCost = 0;

      function handleStreamLine(line) {
        if (!line.trim()) return;
        debugLine(line);
        let obj;
        try { obj = JSON.parse(line); } catch { return; }

        if (obj.type === 'stream_event') {
          const ev = obj.event;
          if (!ev) return;

          if (ev.type === 'message_start') {
            const usage = ev.message?.usage || {};
            inputTokens += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);

          } else if (ev.type === 'message_delta') {
            outputTokens += ev.usage?.output_tokens || 0;

          } else if (ev.type === 'content_block_start') {
            const block = ev.content_block;
            if (block?.type === 'tool_use') {
              inToolBlock = true;
              toolInputBuffer = '';
              if (!atLineStart) process.stdout.write('\n');
              process.stdout.write(`\x1b[90m▸ ${block.name}\x1b[0m`);
              atLineStart = false;
            }
          } else if (ev.type === 'content_block_delta') {
            const delta = ev.delta;
            if (!delta) return;
            if (delta.type === 'text_delta' && !inToolBlock) {
              process.stdout.write(delta.text);
              atLineStart = delta.text.endsWith('\n');
              if (textChunks) textChunks.push(delta.text);
            } else if (delta.type === 'input_json_delta' && inToolBlock) {
              toolInputBuffer += delta.partial_json || '';
            }
          } else if (ev.type === 'content_block_stop') {
            if (inToolBlock) {
              try {
                const input = JSON.parse(toolInputBuffer);
                const detail = input.file_path || input.command || input.pattern
                  || input.query || input.url || input.description || input.prompt || '';
                if (detail) {
                  const short = detail.length > 80 ? detail.slice(0, 77) + '...' : detail;
                  process.stdout.write(` \x1b[2m${short}\x1b[0m`);
                }
              } catch { /* incomplete JSON, skip */ }
              process.stdout.write('\n');
              atLineStart = true;
              inToolBlock = false;
              toolInputBuffer = '';
            }
          }

        } else if (obj.type === 'system' && obj.subtype === 'api_retry') {
          if (!atLineStart) process.stdout.write('\n');
          process.stdout.write(
            `\x1b[33m[retry ${obj.attempt}/${obj.max_retries}] ${obj.error} — waiting ${obj.retry_delay_ms}ms\x1b[0m\n`
          );
          atLineStart = true;

        } else if (obj.type === 'result') {
          if (!atLineStart) process.stdout.write('\n');
          if (obj.is_error) streamError = true;
          finalCost = obj.cost_usd || 0;
        }
      }

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer
        for (const line of lines) handleStreamLine(line);
      });

      child.stderr.on('data', (d) => process.stderr.write(d));

      child.on('close', (code) => {
        if (buffer.trim()) handleStreamLine(buffer);
        // Summary line
        const parts = [];
        if (finalCost > 0) parts.push(`cost: $${finalCost.toFixed(4)}`);
        if (inputTokens > 0 || outputTokens > 0) parts.push(`tokens: ${inputTokens}↑ ${outputTokens}↓`);
        if (parts.length > 0) process.stdout.write(`\x1b[2m[${parts.join(' · ')}]\x1b[0m\n`);
        resolve(finish(streamError ? 1 : (code || 0)));
      });

    } else if (tool === 'jonggrang') {
      // jonggrang backend — runs via @earendil-works/pi-coding-agent SDK directly.
      // The SDK is ESM-only so dynamic import() is required from this CJS module.
      (async () => {
        let session;
        try {
          const os = require('os');
          const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } = await import('@earendil-works/pi-coding-agent');
          // Inlined from @earendil-works/pi-coding-agent/dist/core/model-resolver.js
          // (that subpath is not listed in the package exports field)
          function findExactModelReferenceMatch(modelReference, availableModels) {
            const trimmed = modelReference.trim();
            if (!trimmed) return undefined;
            const norm = trimmed.toLowerCase();
            const canonical = availableModels.filter(m => `${m.provider}/${m.id}`.toLowerCase() === norm);
            if (canonical.length === 1) return canonical[0];
            if (canonical.length > 1) return undefined;
            const slash = trimmed.indexOf('/');
            if (slash !== -1) {
              const provider = trimmed.substring(0, slash).trim();
              const modelId = trimmed.substring(slash + 1).trim();
              if (provider && modelId) {
                const pm = availableModels.filter(m =>
                  m.provider.toLowerCase() === provider.toLowerCase() &&
                  m.id.toLowerCase() === modelId.toLowerCase());
                if (pm.length === 1) return pm[0];
                if (pm.length > 1) return undefined;
              }
            }
            const idMatches = availableModels.filter(m => m.id.toLowerCase() === norm);
            return idMatches.length === 1 ? idMatches[0] : undefined;
          }

          const agentDir = path.join(os.homedir(), '.jonggrang', 'agent');
          const authStorage = AuthStorage.create(path.join(agentDir, 'auth.json'));
          const modelRegistry = ModelRegistry.create(authStorage);

          // Resolve model: --model flag takes priority over jonggrang.json config
          let resolvedModel;
          if (model) {
            resolvedModel = findExactModelReferenceMatch(model, modelRegistry.getAll());
            if (!resolvedModel) {
              process.stderr.write(`[jonggrang] unknown model: "${model}". Run \`jonggrang model\` to see available models.\n`);
            }
          }
          if (!resolvedModel) {
            const cfgProvider = readConfig(path.join(projectRoot, '.jonggrang', 'jonggrang.json'), 'provider', '');
            const cfgModelId = readConfig(path.join(projectRoot, '.jonggrang', 'jonggrang.json'), 'model', '');
            if (cfgProvider && cfgModelId) resolvedModel = modelRegistry.find(cfgProvider, cfgModelId);
          }

          session = (await createAgentSession({
            cwd: projectRoot,
            agentDir,
            sessionManager: SessionManager.inMemory(),
            authStorage,
            modelRegistry,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(effort ? { thinkingLevel: effort } : {}),
          })).session;

          let atLineStart = true;

          session.subscribe((event) => {
            if (event.type === 'message_update') {
              const ae = event.assistantMessageEvent;
              // Only print text_delta — skip thinking_delta (reasoning) and toolcall_delta (raw JSON)
              if (ae?.type === 'text_delta' && ae.delta) {
                process.stdout.write(ae.delta);
                atLineStart = ae.delta.endsWith('\n');
                if (textChunks) textChunks.push(ae.delta);
              }
            } else if (event.type === 'tool_execution_start') {
              // Pi SDK: event.toolName (string) and event.args (object)
              const toolName = event.toolName || '?';
              const args = event.args || {};
              const detail = args.command || args.file_path || args.path || args.query || args.pattern || args.url || '';
              if (!atLineStart) process.stdout.write('\n');
              process.stdout.write(`\x1b[90m▸ ${toolName}\x1b[0m`);
              if (detail) {
                const short = detail.length > 80 ? detail.slice(0, 77) + '...' : detail;
                process.stdout.write(` \x1b[2m${short}\x1b[0m`);
              }
              process.stdout.write('\n');
              atLineStart = true;
            }
          });

          await session.prompt(prompt);
          if (!atLineStart) process.stdout.write('\n');
          // Release Pi SDK resources (HTTP connections, timers) so this process
          // can call runAgent again — the work loop runs one agent per task.
          // Previously this branch called process.exit(0), which killed the
          // worktree work-loop after a single task (you had to click Run again
          // for each subsequent task). The CLI now exits once in main().
          try { session?.dispose(); } catch { }
          resolve(finish(0));
        } catch (err) {
          process.stderr.write(`[jonggrang] error: ${err.message}\n`);
          try { session?.dispose(); } catch { }
          resolve(finish(1));
        }
      })();

    } else if (tool === 'codex') {
      // codex exec <prompt> [--model <name>] [--config reasoning_effort=<level>]
      //   --sandbox: supervised → read-only, else → workspace-write
      //   autonomous → --dangerously-bypass-approvals-and-sandbox (no approval prompts)
      const sandbox = permMode === 'supervised' ? 'read-only' : 'workspace-write';
      const bypassFlag = permMode === 'autonomous' ? ['--dangerously-bypass-approvals-and-sandbox'] : [];

      const child = spawn(
        'codex',
        ['exec', '--json', '--sandbox', sandbox, ...bypassFlag, ...extraFlags, prompt],
        { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      child.stdin.end();

      let buffer = '';
      let atLineStart = true;

      function handleCodexLine(line) {
        if (!line.trim()) return;
        debugLine(line);
        let obj;
        try { obj = JSON.parse(line); } catch (err) {
          process.stderr.write(`[codex] JSON parse error: ${err.message}\n  line: ${line.slice(0, 200)}\n`);
          process.stdout.write(line + '\n');
          atLineStart = true;
          return;
        }

        const type = obj.type || '';

        if (type === 'item.started' && obj.item?.type === 'message') {
          // assistant message delta — content is streamed via item.completed
        } else if (type === 'item.completed') {
          const item = obj.item || {};
          if (item.type === 'message' && item.role === 'assistant') {
            for (const c of (item.content || [])) {
              if (c.type === 'output_text') {
                process.stdout.write(c.text || '');
                atLineStart = (c.text || '').endsWith('\n');
                if (textChunks && c.text) textChunks.push(c.text);
              }
            }
          } else if (item.type === 'function_call') {
            const name = item.name || '?';
            const args = (() => {
              try { return JSON.parse(item.arguments || '{}'); }
              catch (err) {
                process.stderr.write(`[codex] function_call arguments parse error: ${err.message}\n  arguments: ${(item.arguments || '').slice(0, 200)}\n`);
                return {};
              }
            })();
            const detail = args.command || args.path || args.file_path || args.query || args.url || '';
            if (!atLineStart) process.stdout.write('\n');
            process.stdout.write(`\x1b[90m▸ ${name}\x1b[0m`);
            if (detail) {
              const short = detail.length > 80 ? detail.slice(0, 77) + '...' : detail;
              process.stdout.write(` \x1b[2m${short}\x1b[0m`);
            }
            process.stdout.write('\n');
            atLineStart = true;
          }
        }
      }

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) handleCodexLine(line);
      });

      child.stderr.on('data', (d) => {
        const text = d.toString();
        // Suppress codex's "Reading additional input from stdin..." noise
        const filtered = text.replace(/Reading additional input from stdin\.\.\.\n?/g, '');
        if (filtered) process.stderr.write(filtered);
      });

      child.on('close', (code) => {
        if (buffer.trim()) handleCodexLine(buffer);
        if (!atLineStart) process.stdout.write('\n');
        resolve(finish(code));
      });

    } else {
      resolve(finish(1));
    }
  });
}

// ============================================================
// TEST RUNNER
// ============================================================

/**
 * Run the project test command and return { passed, output }.
 * output = combined stdout+stderr (trimmed), capped at 4000 chars.
 */
function runTestCommand(testCmd, projectRoot) {
  if (!testCmd) return { passed: true, output: '' };
  try {
    const result = require('child_process').spawnSync(testCmd, {
      shell: true,
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const raw = ((result.stdout || '') + (result.stderr || '')).trim();
    const output = raw.length > 4000 ? raw.slice(-4000) : raw;
    return { passed: result.status === 0, output };
  } catch (err) {
    return { passed: false, output: String(err) };
  }
}

// ============================================================
// INIT HELPERS
// ============================================================

function generateAgentsMd(name, type, stack, testFw, testCmd, jonggrangHome) {
  const template = path.join(jonggrangHome, 'templates', 'AGENTS.md.template');
  if (fileExists(template)) {
    return fs.readFileSync(template, 'utf8')
      .replace(/\{\{project_name\}\}/g, name)
      .replace(/\{\{project_type\}\}/g, type)
      .replace(/\{\{stack\}\}/g, stack)
      .replace(/\{\{test_framework\}\}/g, testFw)
      .replace(/\{\{test_command\}\}/g, testCmd);
  }
  return `# AGENTS.md — ${name}

> This file is human-curated project knowledge for AI agents.

## Project Overview
- **Name**: ${name}
- **Type**: ${type}
- **Stack**: ${stack}
- **Test Framework**: ${testFw}

## Conventions
TODO - document your project conventions

## Known Gotchas
TODO - document non-obvious things

## Task Management CLI

Use \`jonggrang task\` to manage tasks instead of editing JSON directly.

\`\`\`bash
jonggrang task list                         # list all tasks (JSON)
jonggrang task list pending                 # filter by status
jonggrang task show <id>                    # show detail
jonggrang task next                         # next eligible task
jonggrang task add --title "..." [--priority N] [--blocked-by id,id]
jonggrang task update <id> --status in_progress
jonggrang task done <id>                    # mark completed
jonggrang task block <id> --reason "..."    # mark blocked
jonggrang task remove <id>                  # remove + clean refs
\`\`\`

Output is JSON by default. Add \`--pretty\` for human-readable format.
`;
}

/**
 * Generate opencode.json config for a project.
 * Sets permissions based on autonomy mode and points to AGENTS.md for instructions.
 */
function generateOpenCodeConfig(options) {
  const { autonomy } = options;

  // Map jonggrang autonomy levels to opencode permission settings.
  // doom_loop:ask is always set to prevent infinite agent loops.
  let permission;
  if (autonomy === 'autonomous') {
    permission = { '*': 'allow' };
  } else if (autonomy === 'balanced') {
    permission = { '*': 'allow', bash: 'ask', doom_loop: 'ask' };
  } else {
    // supervised
    permission = { '*': 'ask' };
  }

  return {
    // AGENTS.md = project conventions; CLAUDE.md = jonggrang operational protocol
    instructions: ['AGENTS.md', 'CLAUDE.md'],
    permission,
  };
}

function generateConfig(options) {
  const { name, type, stack, tool, workMode, teamSize, autonomy, testing, testCmd, ci } = options;
  return {
    name: name,
    version: '1.0.0',
    tool: tool,
    project: {
      type: type,
      stack: stack,
      template: stack,
    },
    mode: {
      work: workMode,
      autonomy: autonomy,
      max_team_size: parseInt(teamSize, 10),
    },
    work: {
      max_iterations: 10,
      retry_limit: 2,
      kill_after_fails: 3,
      branch_prefix: 'feat/',
      commit_prefix: 'feat|fix|refactor|test|docs|chore',
    },
    hooks: {
      pre_implement: [],
      post_implement: [],
      pre_commit: [testCmd],
      post_commit: [],
      task_complete: [],
      session_end: [],
    },
    testing: {
      framework: testing,
      command: testCmd,
      coverage_threshold: 80,
    },
    ci: {
      provider: ci,
      auto_setup: ci !== 'none',
    },
    skills: {
      directory: tool === 'opencode' ? './.opencode/skills'
        : tool === 'codex' ? './.codex/skills'
          : './.claude/skills',
      custom: [],
    },
    review: {
      security: true,
      performance: true,
      coverage: true,
    },
  };
}

function runInit(options, jonggrangHome, projectRoot, opts = {}) {
  const { name, type, stack, tool, testing, ci } = options;
  const paths = getProjectPaths(projectRoot);
  const testCmd = getTestCommand(testing);

  // Ensure .jonggrang/ exists before writing any files into it
  fs.mkdirSync(path.join(projectRoot, '.jonggrang'), { recursive: true });

  // 1. jonggrang.json
  const config = generateConfig({ ...options, testCmd });
  writeJSON(paths.configFile, config);

  // 1b. opencode.json (OpenCode reads this from .opencode/ dir)
  {
    const opencodeCfg = generateOpenCodeConfig(options);
    const opencodeDir = path.join(projectRoot, '.opencode');
    const opencodeCfgPath = path.join(opencodeDir, 'opencode.json');
    if (!fs.existsSync(opencodeDir)) fs.mkdirSync(opencodeDir, { recursive: true });
    // Merge with existing opencode.json if present (preserve user settings)
    let existing = {};
    try {
      if (fileExists(opencodeCfgPath)) existing = JSON.parse(fs.readFileSync(opencodeCfgPath, 'utf8'));
    } catch { /* ignore */ }
    writeJSON(opencodeCfgPath, { ...existing, ...opencodeCfg });
  }

  // 2. AGENTS.md
  fs.writeFileSync(paths.agentsFile, generateAgentsMd(name, type, stack, testing, testCmd, jonggrangHome));

  // 2b. CLAUDE.md (Claude Code reads this from project root)
  {
    const claudeTemplate = path.join(jonggrangHome, 'templates', 'CLAUDE.md.template');
    if (fileExists(claudeTemplate)) {
      const content = fs.readFileSync(claudeTemplate, 'utf8')
        .replace(/\{\{project_name\}\}/g, name)
        .replace(/\{\{project_type\}\}/g, type)
        .replace(/\{\{stack\}\}/g, stack)
        .replace(/\{\{test_command\}\}/g, testCmd);
      fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), content);
    }

    // 2b-ii. Claude sub-agent definitions → .claude/agents/
    const agentsTemplateDir = path.join(jonggrangHome, 'templates', 'agents');
    if (fileExists(agentsTemplateDir)) {
      const claudeAgentsDir = path.join(projectRoot, '.claude', 'agents');
      fs.mkdirSync(claudeAgentsDir, { recursive: true });
      try {
        for (const file of fs.readdirSync(agentsTemplateDir)) {
          if (!file.endsWith('.md')) continue;
          const src = path.join(agentsTemplateDir, file);
          const dest = path.join(claudeAgentsDir, file);
          if (!fileExists(dest)) fs.copyFileSync(src, dest);
        }
      } catch { /* ignore */ }
    }

    // 2b-iii. SKILL.md → .claude/SKILL.md (referenced by CLAUDE.md)
    const skillRoot = path.join(jonggrangHome, 'SKILL.md');
    if (fileExists(skillRoot)) {
      fs.copyFileSync(skillRoot, path.join(projectRoot, '.claude', 'SKILL.md'));
    }
  }

  // 2c. AGENTS.md + agent defs for OpenCode → .opencode/agents/
  // (AGENTS.md already written above; copy agent md files for OpenCode context)
  {
    const agentsTemplateDir = path.join(jonggrangHome, 'templates', 'agents');
    if (fileExists(agentsTemplateDir)) {
      const opencodeAgentsDir = path.join(projectRoot, '.opencode', 'agents');
      fs.mkdirSync(opencodeAgentsDir, { recursive: true });
      try {
        for (const file of fs.readdirSync(agentsTemplateDir)) {
          if (!file.endsWith('.md')) continue;
          const src = path.join(agentsTemplateDir, file);
          const dest = path.join(opencodeAgentsDir, file);
          if (!fileExists(dest)) fs.copyFileSync(src, dest);
        }
      } catch { /* ignore */ }
    }

    // SKILL.md → .opencode/SKILL.md
    const skillRoot = path.join(jonggrangHome, 'SKILL.md');
    if (fileExists(skillRoot)) {
      fs.copyFileSync(skillRoot, path.join(projectRoot, '.opencode', 'SKILL.md'));
    }
  }

  // 3. Task state — per-feature now. Migrate any legacy root file instead of
  // creating a new root tasks.json. On a fresh repo there's nothing to migrate.
  const migration = migrateLegacyTaskState(projectRoot);
  // Migrate any legacy root plan.md (pending draft) → per-session draft folder.
  const migratedDraft = migrateLegacyPlanDraft(projectRoot);
  migration.migratedDraft = migratedDraft;

  // 4. progress.txt — per-feature now. Handled by migrateLegacyTaskState above
  // (copied into each feature folder). Nothing to write on a fresh repo.

  // 5. Copy skills into tool-specific directories
  const jonggrangSkillsDir = path.join(jonggrangHome, 'skills');
  let skillCount = 0;
  if (fileExists(jonggrangSkillsDir)) {
    // Always install skills for all supported tools
    const skillTargets = [
      path.join(projectRoot, '.claude', 'skills'),
      path.join(projectRoot, '.opencode', 'skills'),
      path.join(projectRoot, '.jonggrang', 'skills'),
      path.join(projectRoot, '.codex', 'skills'),
    ];

    try {
      const findSkills = (dir, prefix = '') => {
        let results = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const fullPath = path.join(dir, entry.name);
            const relPath = path.join(prefix, entry.name);
            if (fileExists(path.join(fullPath, 'SKILL.md'))) {
              results.push(relPath);
            } else {
              results.push(...findSkills(fullPath, relPath));
            }
          }
        }
        return results;
      };

      const skillDirs = findSkills(jonggrangSkillsDir);
      for (const skillName of skillDirs) {
        const skillFile = path.join(jonggrangSkillsDir, skillName, 'SKILL.md');
        if (!fileExists(skillFile)) continue;

        const content = fs.readFileSync(skillFile, 'utf8');
        const projectTypes = content.match(/^project_types:(.*)$/m);
        const shouldCopy = !projectTypes || projectTypes[1].includes(type);
        if (!shouldCopy) continue;

        for (const targetBase of skillTargets) {
          const dest = path.join(targetBase, skillName, 'SKILL.md');
          if (fileExists(dest)) continue;
          fs.mkdirSync(path.join(targetBase, skillName), { recursive: true });
          fs.copyFileSync(skillFile, dest);
        }
        skillCount++;
      }
    } catch { /* ignore */ }
  }

  // 6. Copy jonggrang lib → .jonggrang/lib/ so hook scripts work after init.
  // Hook scripts use: JONGGRANG_LIB="${base}/.jonggrang/lib" (falls back to ${base}/lib for source repo).
  {
    const srcLib = path.join(jonggrangHome, 'lib');
    const destLib = path.join(projectRoot, '.jonggrang', 'lib');
    if (fileExists(srcLib) && srcLib !== destLib) {
      try {
        fs.mkdirSync(destLib, { recursive: true });
        for (const file of fs.readdirSync(srcLib)) {
          if (!file.endsWith('.js')) continue;
          fs.copyFileSync(path.join(srcLib, file), path.join(destLib, file));
        }
      } catch { /* ignore */ }
    }
  }

  // 7. Init git if needed
  if (!fileExists(path.join(projectRoot, '.git'))) {
    try {
      execSync('git init', { cwd: projectRoot, stdio: 'ignore' });
    } catch { /* ignore */ }
  }

  // 8. Pre-generate codebase map (LLM-free, deterministic).
  // Gives every fresh-context agent an immediate project orientation
  // without spending tool calls on `ls` / `find`. Mirrors pi-compass.
  let codemapGenerated = false;
  try {
    require('./codemap').getOrGenerateCodemap(projectRoot, { force: true });
    codemapGenerated = true;
  } catch { /* best-effort */ }

  return { skillCount, codemapGenerated };
}

// ============================================================
// TASK GROUP DETECTION (Union-Find)
// ============================================================

function getTaskGroups(tasksFile) {
  const data = getTasks(tasksFile);
  const runnableStatuses = new Set(['pending', 'in_progress']);
  const tasks = data.tasks.filter(t => runnableStatuses.has(t.status));
  if (tasks.length === 0) return [];

  const parent = {};
  function find(x) {
    if (!parent[x]) parent[x] = x;
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (const task of tasks) {
    find(task.id);
    for (const dep of (task.blocked_by || [])) {
      // Union even if dep is completed — they belong to same logical group
      const allTasks = data.tasks;
      if (allTasks.some(t => t.id === dep)) {
        union(task.id, dep);
      }
    }
  }

  const groups = {};
  for (const task of tasks) {
    const root = find(task.id);
    if (!groups[root]) groups[root] = [];
    groups[root].push(task);
  }

  return Object.values(groups).map((groupTasks, idx) => {
    const sorted = groupTasks.sort((a, b) => (a.priority || 0) - (b.priority || 0));
    return {
      id: `group-${idx + 1}`,
      tasks: sorted,
      taskIds: sorted.map(t => t.id),
    };
  });
}

// ============================================================
// WORKTREE HELPERS
// ============================================================

// Create a git worktree for a group/plan.
// opts.dir    — explicit worktree path (default: a temp dir, for back-compat).
// opts.branch — explicit branch name (default: `jonggrang/<groupId>`).
// The worktree is always (re)created from baseBranch at a clean slate so reruns
// are deterministic.
function createWorktree(projectRoot, groupId, baseBranch, opts = {}) {
  const worktreePath = opts.dir || path.join(os.tmpdir(), `jonggrang-${groupId}-${Date.now()}`);
  const branch = opts.branch || `jonggrang/${groupId}`;

  // Clean up stale worktree and branch from previous runs
  try {
    execSync('git worktree prune', { cwd: projectRoot, stdio: 'pipe' });
  } catch { /* ignore */ }
  // Remove an existing worktree checkout at this path so we can recreate it.
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectRoot, stdio: 'pipe' });
  } catch { /* may not exist */ }
  try {
    execSync(`git branch -D "${branch}"`, { cwd: projectRoot, stdio: 'pipe' });
  } catch { /* branch may not exist */ }

  // Ensure the parent directory exists (e.g. .jonggrang/.worktree/).
  try { fs.mkdirSync(path.dirname(worktreePath), { recursive: true }); } catch { /* ignore */ }

  const baseSha = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
  execSync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, {
    cwd: projectRoot, stdio: 'pipe',
  });
  return { worktreePath, branch, baseSha };
}

// Parse the YAML frontmatter (--- … ---) at the top of a plan.md.
// Returns {} when there is no frontmatter or the file is unreadable.
function parsePlanFrontmatter(planPath) {
  try {
    const raw = fs.readFileSync(planPath, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const yaml = require('js-yaml');
    return yaml.load(m[1]) || {};
  } catch {
    return {};
  }
}

// A base branch name we consider safe to interpolate into a shell command
// (`git fetch origin "<base>"`) and into a YAML scalar. Letters, digits, dot,
// slash, dash, underscore only; must not lead with `-` or `.` (option/relative
// ref hazards). Intentionally stricter than git's own ref grammar — the point is
// that a value passing this check carries NO shell metacharacters, quotes, or
// whitespace, so every interpolation downstream (resolveStartRef, setPlanBase)
// is injection-safe regardless of where the value came from (CLI, web API, or
// frontmatter written by the AI / committed plan.md).
function isSafeBranchName(name) {
  return typeof name === 'string'
    && name.length > 0 && name.length <= 200
    && /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(name);
}

// Set (or replace) the `base:` branch field inside a plan.md's YAML frontmatter.
// The base branch (which branch the worktree is cut from) is a deterministic
// user choice, NOT something the AI decides — so we write it after generation.
// Rejects unsafe names (see isSafeBranchName) so a malicious --base / frontmatter
// value can never reach the fetch shell. Returns true only if the file was
// updated; false on invalid input, missing frontmatter, or write error.
function setPlanBase(planPath, base) {
  if (!isSafeBranchName(base)) return false;
  try {
    const raw = fs.readFileSync(planPath, 'utf8');
    const m = raw.match(/^(---\n)([\s\S]*?)(\n---)/);
    if (!m) return false;
    let body = m[2];
    // Quote the scalar so branch names that look like YAML keywords (true, no,
    // 123, 0x1f) survive js-yaml parsing as strings. Safe to embed bare: the
    // value passed isSafeBranchName, so it contains no `"`.
    const line = `base: "${base}"`;
    if (/^base:.*$/m.test(body)) {
      body = body.replace(/^base:.*$/m, line);
    } else if (/^branch:.*$/m.test(body)) {
      body = body.replace(/^(branch:.*)$/m, `$1\n${line}`);
    } else {
      body = `${body}\n${line}`;
    }
    fs.writeFileSync(planPath, m[1] + body + m[3] + raw.slice(m.index + m[0].length), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// List candidate base branches (local heads + origin remote-tracking refs,
// deduped to short names) plus the resolved default. Host-side, read-only — it
// works for sandbox projects too (the .git is bind-mounted) and needs no network
// or container. Worktree creation fetches the chosen base for freshness.
function listBranches(projectRoot) {
  const collect = (ref) => {
    try {
      return execSync(`git for-each-ref --format='%(refname:short)' ${ref}`, { cwd: projectRoot, encoding: 'utf8' })
        .split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  };
  const local = collect('refs/heads');
  const remote = collect('refs/remotes/origin')
    .map(s => s.replace(/^origin\//, ''))
    .filter(s => s && s !== 'HEAD' && s !== 'origin');
  const branches = [...new Set([...local, ...remote])].sort();
  return { branches, default: resolveBaseBranch(projectRoot) };
}

// Order a list of tasks so that dependencies (blocked_by) always come before
// their dependents, breaking ties by priority. Tasks outside `tasks` that
// appear in blocked_by are ignored (cross-group deps are not expected here).
function orderTaskIds(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set();
  const ordered = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    const t = byId.get(id);
    if (!t) return;
    for (const dep of (t.blocked_by || [])) {
      if (byId.has(dep)) visit(dep);
    }
    ordered.push(id);
  };
  for (const t of [...tasks].sort((a, b) => (a.priority || 0) - (b.priority || 0))) {
    visit(t.id);
  }
  return ordered;
}

// Group runnable tasks by plan (feature_id). Each group becomes one worktree +
// one branch. The branch is read from the plan's plan.md frontmatter, falling
// back to the tasks-file top-level branch, then `jonggrang/<featureId>`.
// Returns [{ featureId, branch, title, taskIds, tasks }].
function groupPlansFromData(data, projectRoot) {
  const runnable = (data.tasks || []).filter(t => t.status === 'pending' || t.status === 'in_progress');
  if (runnable.length === 0) return [];

  const featuresDir = path.join(projectRoot, '.jonggrang', '.output', 'features');
  const groups = new Map();
  for (const task of runnable) {
    const fid = task.feature_id || '__default__';
    if (!groups.has(fid)) groups.set(fid, []);
    groups.get(fid).push(task);
  }

  const result = [];
  for (const [featureId, tasks] of groups) {
    let branch = '';
    let title = '';
    let base = '';
    if (featureId !== '__default__') {
      const fm = parsePlanFrontmatter(path.join(featuresDir, featureId, 'plan.md'));
      branch = fm.branch || '';
      title = fm.feature || fm.description || '';
      base = fm.base || '';
    }
    if (!branch) branch = data.branch || `jonggrang/${featureId}`;
    if (!title) title = data.feature || featureId;
    const taskIds = orderTaskIds(tasks);
    result.push({ featureId, branch, base, title, taskIds, tasks });
  }
  // Stable order: by first task priority so the UI is deterministic.
  result.sort((a, b) => (a.tasks[0]?.priority || 0) - (b.tasks[0]?.priority || 0));
  return result;
}

function groupPlans(tasksFile, projectRoot) {
  return groupPlansFromData(getTasks(tasksFile), projectRoot);
}

function groupPlansAll(projectRoot) {
  return groupPlansFromData(getAllTasks(projectRoot), projectRoot);
}

// Co-author trailer added to every commit jonggrang makes on the user's behalf.
const JONGGRANG_COAUTHOR = process.env.JONGGRANG_COAUTHOR || 'jonggrang-dev <koko@jonggrang.dev>';
const COAUTHOR_TRAILER = `Co-authored-by: ${JONGGRANG_COAUTHOR}`;

// Commit all changes in a worktree to its branch. Returns true if a commit was
// made, false if the tree was clean (nothing to commit).
function commitWorktree(worktreePath, message) {
  execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });
  const status = execSync('git status --porcelain', { cwd: worktreePath, encoding: 'utf8' }).trim();
  if (!status) return false;
  const safeMsg = String(message || 'jonggrang: worktree changes').replace(/"/g, '\\"');
  execSync(`git commit -m "${safeMsg}" -m "${COAUTHOR_TRAILER}"`, { cwd: worktreePath, stdio: 'pipe' });
  return true;
}

// List changed files on a worktree branch relative to a base sha.
function worktreeChangedFiles(worktreePath, baseSha) {
  const out = execSync(`git diff --name-status ${baseSha}`, { cwd: worktreePath, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map(line => {
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) return { status: line.trim(), file: '' };
    return { status: line.slice(0, tabIdx), file: line.slice(tabIdx + 1) };
  });
}

// Full unified diff for one file (or the whole branch when file is omitted),
// relative to a base sha.
function worktreeFileDiff(worktreePath, baseSha, file) {
  const fileArg = file ? ` -- "${file}"` : '';
  return execSync(`git diff ${baseSha}${fileArg}`, { cwd: worktreePath, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
}

// Non-interactive git environment — git must NEVER block on a prompt (the
// dashboard runs these unattended). Covers all three prompt sources:
//   • GIT_TERMINAL_PROMPT=0  → no username/password prompt (fail fast instead).
//   • GIT_ASKPASS=echo       → neuter any credential-helper popup.
//   • GIT_SSH_COMMAND        → BatchMode=yes never prompts; accept-new auto-says
//     "yes" to a NEW host key (the classic "Are you sure you want to continue
//     connecting (yes/no)?") while still REJECTING a CHANGED key (MITM-safe);
//     ConnectTimeout bounds a stuck handshake.
// A user-provided GIT_ASKPASS/GIT_SSH_COMMAND is respected (only filled if unset).
// Used on host AND inside sandboxes so behaviour is identical in both modes.
function gitNonInteractiveEnv(extra = {}) {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: process.env.GIT_ASKPASS || 'echo',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND
      || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20',
    ...extra,
  };
}

// Push a branch to a remote (creates/updates the remote branch of the same name).
// ASYNC on purpose: pushing is a network op, so we must NOT use execSync — that
// blocks Node's single-threaded event loop and freezes the whole dashboard for
// the duration. The non-interactive env fails fast instead of hanging on a
// prompt, and the timeout bounds a stuck network/auth. Returns a Promise.
function pushBranch(projectRoot, branch, remote = 'origin') {
  return new Promise((resolve, reject) => {
    execFile('git', ['push', '-u', remote, branch], {
      cwd: projectRoot,
      timeout: 60000,
      env: { ...process.env, ...gitNonInteractiveEnv() },
    }, (err, stdout, stderr) => {
      if (!err) return resolve();
      if (err.killed || err.signal === 'SIGTERM') {
        return reject(new Error('git push timed out (no credentials or network) — push manually or configure a credential helper'));
      }
      reject(new Error((stderr || stdout || err.message).toString().trim()));
    });
  });
}

// Current HEAD sha of a git dir/worktree.
function gitHead(dir) {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

// Resolve the base/integration branch that carries plans + tasks + manifest:
//   current branch if it's main/master → else main if it exists → else master →
//   else 'main' (the default for new repos). Existing repos are respected.
function resolveBaseBranch(projectRoot) {
  let cur = '';
  try { cur = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim(); } catch { }
  if (cur === 'main' || cur === 'master') return cur;
  const has = (b) => {
    try { execSync(`git rev-parse --verify refs/heads/${b}`, { cwd: projectRoot, stdio: 'pipe' }); return true; }
    catch { return false; }
  };
  if (has('main')) return 'main';
  if (has('master')) return 'master';
  return 'main';
}

// Tracked base-state paths. Tasks & progress now live under .output/features/<id>/,
// already covered by the .output glob. Only .output needs explicit tracking.
const BASE_STATE_PATHS = ['.jonggrang/.output'];

function baseStateDirty(projectRoot) {
  try {
    const args = BASE_STATE_PATHS.map(p => `"${p}"`).join(' ');
    return !!execSync(`git status --porcelain -- ${args}`, { cwd: projectRoot, encoding: 'utf8' }).trim();
  } catch { return false; }
}

const JONGGRANG_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'jonggrang',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'jonggrang@local',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'jonggrang',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'jonggrang@local',
};

function commitBaseState(projectRoot, message) {
  for (const p of BASE_STATE_PATHS) {
    try { execSync(`git add -- "${p}"`, { cwd: projectRoot, stdio: 'pipe' }); } catch { }
  }
  if (!baseStateDirty(projectRoot) && !hasStagedBaseState(projectRoot)) return false;
  const safe = String(message || 'chore: update plans & tasks').replace(/"/g, '\\"');
  execSync(`git commit -m "${safe}" -m "${COAUTHOR_TRAILER}"`, {
    cwd: projectRoot, stdio: 'pipe',
    env: { ...process.env, ...JONGGRANG_GIT_IDENTITY },
  });
  return true;
}

// Whether any base-state path is staged (so commit will produce something).
function hasStagedBaseState(projectRoot) {
  try {
    const args = BASE_STATE_PATHS.map(p => `"${p}"`).join(' ');
    return !!execSync(`git diff --cached --name-only -- ${args}`, { cwd: projectRoot, encoding: 'utf8' }).trim();
  } catch { return false; }
}

function hasRemote(projectRoot, remote = 'origin') {
  try {
    const out = execSync('git remote', { cwd: projectRoot, encoding: 'utf8' });
    return out.split(/\r?\n/).map(s => s.trim()).includes(remote);
  } catch {
    return false;
  }
}

function removeWorktree(projectRoot, worktreePath, branch) {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectRoot, stdio: 'pipe' });
  } catch { /* may already be removed */ }
  if (branch) {
    try {
      execSync(`git branch -D "${branch}"`, { cwd: projectRoot, stdio: 'pipe' });
    } catch { /* ignore */ }
  }
}

function mergeWorktreeBranch(projectRoot, branch) {
  execSync(`git merge "${branch}" --no-ff -m "merge: ${branch}"`, {
    cwd: projectRoot, stdio: 'pipe',
  });
}

function copyToWorktree(projectRoot, worktreePath, files) {
  for (const file of files) {
    const src = path.join(projectRoot, file);
    const dst = path.join(worktreePath, file);
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      copyDirSync(src, dst);
    } else {
      const dir = path.dirname(dst);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

function copyDirSync(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ============================================================
// BUG REPORTS — PROMPT BUILDER
// ============================================================

/**
 * Build a prompt to convert open bugs in bugs.md into BUGFIX tasks.
 * openBugs: array of { id, description } objects for [open] bugs.
 * featureId: the feature these bugs belong to.
 */
function buildBugsToTasksPrompt(openBugs, featureId, configFile, projectRoot) {
  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  let existingSection = '';
  const allTasks = getAllTasks(projectRoot);
  if (allTasks.tasks.length > 0) {
    const existingIds = allTasks.tasks.map(t => t.id).join(', ');
    existingSection = `## Existing Task IDs (across all features — continue numbering from here, do NOT duplicate)\n${existingIds}\n`;
  }

  const bugList = openBugs.map((b, i) =>
    `### Bug ${i + 1} (${b.id})\n${b.description}`
  ).join('\n\n');

  return `# Jonggrang — Convert Bug Reports to Tasks

${buildProjectContext(configFile, { maxChars: 3000 })}

## Feature ID
${featureId}

${configSection}${existingSection}
## Bug Reports to Convert

${bugList}

## Your Task

For each bug above, create one BUGFIX task via the CLI (do NOT edit the tasks file directly).

Run this single command to add all tasks at once:
\`\`\`bash
jonggrang task import --feature ${featureId} --input '<JSON array of task objects>'
\`\`\`

Each task object must follow this schema exactly:
\`\`\`json
{
  "id": "task-NNN",
  "title": "Fix: <short description of the bug>",
  "description": "Bug: <what the bug is>\\n\\nSteps to reproduce (if inferable):\\n- ...\\n\\nExpected: ...\\nActual: ...",
  "priority": 1,
  "status": "pending",
  "feature_id": "${featureId}",
  "skill": null,
  "blocked_by": [],
  "passes": false,
  "files": [],
  "started_at": null,
  "completed_at": null,
  "error_log": []
}
\`\`\`

Rules:
- priority 1 for all bugs (highest)
- work_type is BUGFIX — keep tasks small and focused
- Task IDs are GLOBALLY unique. Continue numbering from the existing IDs listed above — do NOT reuse them. Omit "id" to let the CLI auto-assign the next global number, or specify a continuing number.
- Do NOT include feature_id in the task objects — the CLI stamps it from --feature.
- After running the import command, output one line per bug in the format:
  TASK_CREATED bug-001 task-005
  TASK_CREATED bug-002 task-006`;
}

// ============================================================
// DEEP PLANNING — PHASES 3 → 5+6 → 7 CONDENSED
// ============================================================

/**
 * Phase 1 of --deep: Codebase discovery.
 * The agent reads existing code, dependencies, and patterns relevant to the
 * feature, then writes a discovery report to .jonggrang/.ephemeral/deep-plan-discovery.md
 */
function buildDeepPlanDiscoveryPrompt(description, configFile, discoveryPath, srcPath = null, opts = {}) {
  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }
  const clarSection = opts.clarifications
    ? `\n## Clarifications from User (authoritative — let these guide discovery)\n${opts.clarifications}\n`
    : '';

  return `# Jonggrang Deep Plan — Phase 1: Codebase Discovery

${buildFeatureSection(description, srcPath, 'Feature Request')}

${buildProjectContext(configFile, { maxChars: 3500 })}
${clarSection}
## Your Task

You are performing codebase discovery for the feature above. Your goal is to understand the existing code so the plan can be precise and realistic.

Investigate:
1. **File structure** — Run \`find . -type f -name "*.ts" -o -name "*.js" | grep -v node_modules | head -50\` (or equivalent for the stack)
2. **Existing patterns** — Read key files relevant to this feature. Look for existing similar implementations.
3. **Dependencies** — Check package.json / Cargo.toml / go.mod / etc. Note libraries already available.
4. **Related code** — Find code that this feature will need to touch or extend.
5. **Potential risks** — Note database schemas, APIs, or contracts that constrain the implementation.
6. **Test patterns** — How are tests currently structured? What test helpers exist?

Write your findings to \`${discoveryPath}\` using this EXACT format:

\`\`\`markdown
# Discovery Report

## File Structure (relevant paths)
(list key files and directories relevant to this feature)

## Existing Patterns
(what patterns does this codebase use that the feature must follow)

## Available Dependencies
(libraries/packages already installed that are relevant)

## Related Code (files to touch)
(specific files that will need to be modified or referenced)

## Risks & Constraints
(schema constraints, API contracts, breaking changes, backwards-compat requirements)

## Test Infrastructure
(test framework, helpers, how to run tests, co-location pattern)

## Discovery Notes
(anything surprising or non-obvious discovered during exploration)
\`\`\`

After writing the file, output exactly: "Discovery complete: ${discoveryPath}"`;
}

/**
 * Phase 2 of --deep: Complexity analysis + brainstorm alternatives.
 * The agent reads the discovery report and thinks about approaches before committing to a plan.
 * Writes to .jonggrang/.ephemeral/deep-plan-analysis.md
 */
function buildDeepPlanAnalysisPrompt(description, discoveryContent, analysisPath, srcPath = null) {
  return `# Jonggrang Deep Plan — Phase 2: Complexity Analysis & Brainstorm

${buildFeatureSection(description, srcPath, 'Feature Request')}

${buildProjectContext(process.cwd(), { maxChars: 2500 })}

## Discovery Report
\`\`\`markdown
${discoveryContent}
\`\`\`

## Your Task

Based on the discovery report above, analyze the complexity and brainstorm implementation approaches.

Produce:

1. **Complexity Assessment**
   - Effort level: BUGFIX / SMALL / MEDIUM / LARGE (with justification)
   - Key complexity drivers (what makes this hard?)
   - Estimated number of files to create/modify

2. **Approach Options** (2-3 alternatives)
   For each approach:
   - Name + one-line summary
   - Pros (what's good about it)
   - Cons / risks
   - Fits existing patterns? (yes/no + explanation)

3. **Recommended Approach** — Pick one and explain why it's best for this codebase

4. **Phase Breakdown** — For the recommended approach, what are the logical implementation phases?
   (High-level: 3-8 phases, not detailed task steps)

5. **Key Decisions** — Technical decisions that need to be captured in the plan

6. **Out of Scope** — What related things are explicitly NOT part of this feature

Write your analysis to \`${analysisPath}\` using this EXACT format:

\`\`\`markdown
# Analysis Report

## Complexity Assessment
- work_type: BUGFIX|SMALL|MEDIUM|LARGE
- Justification: ...
- Files impacted: ~N

## Approach Options

### Option 1: <name>
**Summary**: ...
**Pros**: ...
**Cons**: ...
**Pattern fit**: yes/no — ...

### Option 2: <name>
...

## Recommended Approach
<name> — <why it's best for this codebase>

## Implementation Phases
1. Phase name — what it covers
2. ...

## Key Decisions
- Decision: choice + rationale

## Out of Scope
- ...
\`\`\`

After writing the file, output exactly: "Analysis complete: ${analysisPath}"`;
}

/**
 * Phase 3 of --deep: Condense discovery + analysis into enriched plan.md
 * Reads both ephemeral files and writes a richer plan.md than the standard one.
 */
function buildDeepPlanCondensePrompt(description, discoveryContent, analysisContent, configFile, projectRoot, draftPath, srcPath = null, opts = {}) {
  let completedSection = '';
  const allTasks = getAllTasks(projectRoot);
  const done = allTasks.tasks.filter(t => t.status === 'completed');
  if (done.length > 0) {
    completedSection = `## Already Completed Work\nDo NOT plan to redo these:\n${done.map(t => `- ${t.id}: ${t.title}`).join('\n')}\n`;
  }

  const clarSection = opts.clarifications
    ? `## Clarifications from User (authoritative — the plan MUST honor these)\n${opts.clarifications}\n\n`
    : '';

  const now = new Date().toISOString();

  return `# Jonggrang Deep Plan — Phase 3: Condense to Plan

${buildFeatureSection(description, srcPath, 'Feature Request')}

${buildProjectContext(configFile, { maxChars: 3000 })}

${clarSection}## Discovery Report
\`\`\`markdown
${discoveryContent}
\`\`\`

## Analysis Report
\`\`\`markdown
${analysisContent}
\`\`\`

${completedSection}

## Your Task

Synthesize the discovery and analysis reports into a final plan.md file.

Write \`${draftPath}\` using EXACTLY this format (enriched version for --deep plans):

\`\`\`
---
feature: short-kebab-case-name
branch: feat/short-kebab-case-name
work_type: BUGFIX|SMALL|MEDIUM|LARGE
description: one-line summary of the feature
created_at: ${now}
depth: deep
---

# Plan: Feature Name Here

## Approach
2-4 sentences: technical approach, architecture decisions, what changes. Use the recommended approach from the analysis.

## Phases
1. Phase name — what happens (one focused session)
2. Phase name — what happens
...

## Key Decisions
- Decision: choice + brief rationale (from analysis)

## Affected Areas
- List files and modules that will be touched (from discovery)

## Risks
- Risk: what could go wrong + mitigation (from discovery + analysis)

## Alternatives Considered
- Option 1 name: why it was not chosen
- Option 2 name: why it was not chosen

## Out of Scope
- What is NOT included in this plan

## Dependencies
Existing code, services, or patterns this builds on. From the discovery report.
\`\`\`

Rules:
- Use EXACTLY the work_type from the analysis report
- The Phases must come from the analysis report's "Implementation Phases"
- The Key Decisions must come from the analysis's "Key Decisions"
- Affected Areas must list real files from the discovery report
- Alternatives Considered must cover options NOT chosen from the analysis
- Do NOT write code or file-level task details
- Do NOT write to the tasks file
- After writing plan.md, output exactly: "Deep plan written to ${draftPath}"`;
}

/**
 * Build the feature section of a prompt, optionally referencing a source document
 * by its canonical path. The agent decides how to read the file.
 * @param {string} description - user-provided description (may be empty if srcPath given)
 * @param {string|null} srcPath - canonical path to a requirements/source document, or null
 * @param {string} heading - section heading (default: 'Feature Description')
 */
function buildFeatureSection(description, srcPath, heading = 'Feature Description') {
  if (!srcPath) return `## ${heading}\n${description}`;
  const descLine = description
    ? `## ${heading}\n${description}`
    : `## ${heading}\n(from source document)`;
  return `${descLine}\n\n## Source Document
There is a requirements/source document at: ${srcPath}
Read it for context before planning.`;
}

// ============================================================
// PLAN CLARIFYING QUESTIONS  (jonggrang plan ask)
// ============================================================
//
// `plan ask` is an AGENT-facing intake command (the sibling of `task import`):
// during planning the agent SUBMITS structured clarifying questions instead of
// guessing. The questions/answers are stored as durable siblings of plan.md
// (NOT under .ephemeral, which --deep wipes) so they survive into plan revision.

const MAX_PLAN_QUESTIONS = 6;
const VALID_QUESTION_TYPES = new Set(['single_choice', 'multi_choice', 'text']);

/**
 * Normalize + validate a questions payload submitted by the agent.
 * Accepts an object { goal_analysis, questions:[...] } or a bare array of
 * question objects. Throws on malformed input (mirrors taskImport strictness).
 */
function normalizePlanQuestions(payload, goalOverride) {
  let goal_analysis = '';
  let questions;
  if (Array.isArray(payload)) {
    questions = payload;
  } else if (payload && typeof payload === 'object') {
    questions = payload.questions;
    goal_analysis = payload.goal_analysis || '';
  } else {
    throw new Error('Input must be a questions object or a JSON array of questions.');
  }
  if (goalOverride) goal_analysis = goalOverride;
  if (!Array.isArray(questions)) throw new Error('Input must contain a "questions" array.');
  if (questions.length === 0) throw new Error('Questions array is empty.');

  const normalized = [];
  for (const q of questions) {
    if (normalized.length >= MAX_PLAN_QUESTIONS) break; // cap — avoid an interrogation
    if (!q || typeof q !== 'object') throw new Error('Each question must be an object.');
    const question = String(q.question || '').trim();
    if (!question) throw new Error('Each question needs a non-empty "question".');

    // Fail fast on an explicit unsupported type — silently coercing a typo like
    // "single-choice" to "text" would change the UX + payload contract without the
    // agent noticing. Omitting "type" still defaults to the valid "text".
    const type = String(q.type || 'text');
    if (!VALID_QUESTION_TYPES.has(type)) {
      throw new Error(`Question "${question}" has unsupported type "${type}". Use one of: ${[...VALID_QUESTION_TYPES].join(', ')} (omit "type" to default to text).`);
    }

    const item = {
      id: q.id || `q${normalized.length + 1}`,
      question,
      rationale: String(q.rationale || ''),
      type,
    };

    if (type === 'single_choice' || type === 'multi_choice') {
      const opts = Array.isArray(q.options) ? q.options : [];
      const options = opts
        .filter(o => o && (o.value != null || o.label != null))
        .map(o => ({
          value: String(o.value != null ? o.value : o.label),
          label: String(o.label != null ? o.label : o.value),
          rationale: String(o.rationale || ''),
        }));
      if (options.length < 2) {
        throw new Error(`Question "${question}" (${type}) needs at least 2 options.`);
      }
      item.options = options;
      item.allow_freetext = q.allow_freetext !== false; // default true
    }
    normalized.push(item);
  }

  return { goal_analysis, questions: normalized };
}

/** Validate + persist questions submitted by the agent. Returns the stored object. */
function savePlanQuestions(questionsFile, payload, goalOverride) {
  const data = normalizePlanQuestions(payload, goalOverride);
  writeJSON(questionsFile, data);
  return data;
}

/** Read the questions store. Returns { goal_analysis, questions:[] } when absent. */
function getPlanQuestions(questionsFile) {
  const data = readJSON(questionsFile);
  if (!data || !Array.isArray(data.questions)) return { goal_analysis: '', questions: [] };
  return data;
}

/** Delete the questions store (called before a fresh question-generation pass). */
function clearPlanQuestions(questionsFile) {
  try { fs.unlinkSync(questionsFile); } catch { /* already gone */ }
}

function clearPlanAnswers(answersFile) {
  try { fs.unlinkSync(answersFile); } catch { /* already gone */ }
}

/** Validate + persist the user's answers. Accepts { goal_analysis, answers:[] } or an array. */
function savePlanAnswers(answersFile, payload) {
  let goal_analysis = '';
  let answers;
  if (Array.isArray(payload)) {
    answers = payload;
  } else if (payload && typeof payload === 'object') {
    answers = payload.answers;
    goal_analysis = payload.goal_analysis || '';
  } else {
    throw new Error('Answers must be an object or array.');
  }
  if (!Array.isArray(answers)) throw new Error('Answers must contain an "answers" array.');
  const data = { goal_analysis, answers };
  writeJSON(answersFile, data);
  return data;
}

/** Read the answers store. Returns null when absent. */
function getPlanAnswers(answersFile) {
  const data = readJSON(answersFile);
  if (!data || !Array.isArray(data.answers)) return null;
  return data;
}

/**
 * Render collected answers into a markdown block for injection into plan prompts
 * and for the human-visible "## Clarifications" section of plan.md. Returns '' when empty.
 */
function formatClarifications(answers) {
  if (!answers || !Array.isArray(answers.answers) || answers.answers.length === 0) return '';
  const lines = [];
  if (answers.goal_analysis) { lines.push(`Goal: ${answers.goal_analysis}`, ''); }
  for (const a of answers.answers) {
    const resolved = (a.freetext != null && a.freetext !== '')
      ? a.freetext
      : (a.label != null && a.label !== '' ? a.label
        : (a.value != null ? String(a.value) : '(no answer)'));
    lines.push(`- **${a.question || a.id}** → ${resolved}`);
  }
  return lines.join('\n');
}

/**
 * Build the "questions-only" Pass-A prompt: the agent analyzes the goal and, if
 * anything is ambiguous, SUBMITS clarifying questions via `jonggrang plan ask`
 * (it never writes plan.md here). If the request is unambiguous it outputs
 * NO_QUESTIONS and stops.
 */
function buildPlanQuestionsPrompt(description, configFile, srcPath = null) {
  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  return `# Jonggrang — Clarify Before Planning

${buildFeatureSection(description, srcPath, 'Feature Request')}

## Project Context
${configSection}- Read AGENTS.md for project conventions
- Skim the codebase (ls/find/read) only as much as needed to judge what is ambiguous

## Your Task
1. **Analyze the goal.** In 1-2 sentences, restate what the user wants to achieve.
2. **Decide if you can plan confidently.** If anything MATERIAL is ambiguous —
   architecture choice, scope boundaries, data model, backwards-compatibility,
   UX, or a decision with real trade-offs — DO NOT guess.
3. **If ambiguous, submit clarifying questions** by running the intake command
   below, then STOP (do not write any plan). The user will answer and you will be
   re-invoked with the answers.
4. **If the request is already unambiguous**, output exactly \`NO_QUESTIONS\` and stop.

## How to submit questions (preferred: write a file, then pass its path)
Write the questions JSON to a temp file (avoids shell-escaping issues), then run:

\`\`\`bash
jonggrang plan ask /tmp/jonggrang-questions.json
\`\`\`

The JSON must match this schema (object with goal_analysis + questions array):

\`\`\`json
{
  "goal_analysis": "one or two sentences restating the user's goal",
  "questions": [
    {
      "question": "Which X do you want?",
      "rationale": "why this matters for the plan",
      "type": "single_choice",
      "options": [
        { "value": "a", "label": "Option A", "rationale": "trade-off of A" },
        { "value": "b", "label": "Option B", "rationale": "trade-off of B" }
      ]
    },
    { "question": "Any open constraints?", "rationale": "affects scope", "type": "text" }
  ]
}
\`\`\`

Rules:
- Ask ONLY what genuinely blocks a correct plan. At most ${MAX_PLAN_QUESTIONS} questions.
- Every option must carry a short \`rationale\` (the trade-off it implies).
- Use \`"type":"text"\` for open-ended questions; \`"single_choice"\`/\`"multi_choice"\` need ≥2 options.
- After the command succeeds, STOP. Do NOT write .jonggrang/plan.md.`;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Configuration helpers
  getProjectPaths,
  fileExists,
  readJSON,
  writeJSON,
  readConfig,
  checkConfig,

  // State validation
  validateConfigFile,

  validateProjectState,

  // Task management
  getTasks,
  getNextTask,
  getTask,
  getTaskQueue,
  revertWaiting,
  updateTaskStatus,
  markTaskDone,
  addTask,
  addTasksBulk,
  updateTask,
  removeTask,

  countPending,
  countCompleted,
  countTotal,

  // Path helpers
  resolveSkillsDir,

  // Detection helpers
  detectStack,
  detectTestFramework,
  detectCI,
  stackToType,
  getTestCommand,

  // Plan clarifying questions (plan ask)
  savePlanQuestions,
  getPlanQuestions,
  clearPlanQuestions,
  clearPlanAnswers,
  savePlanAnswers,
  getPlanAnswers,
  normalizePlanQuestions,
  formatClarifications,
  buildPlanQuestionsPrompt,

  // Prompt builders
  buildFeatureSection,
  buildProjectContext,
  buildDraftPlanPrompt,
  buildRevisePlanPrompt,
  buildTasksFromPlanPrompt,
  buildBugsToTasksPrompt,
  buildDeepPlanDiscoveryPrompt,
  buildDeepPlanAnalysisPrompt,
  buildDeepPlanCondensePrompt,
  buildWorkPrompt,
  buildPlanPrompt,
  buildReviewPrompt,

  // Agent runner
  runAgent,
  runTestCommand,

  // Init helpers
  generateAgentsMd,
  generateConfig,
  generateOpenCodeConfig,
  runInit,

  // Parallel / worktree
  getTaskGroups,
  groupPlans,
  groupPlansAll,
  parsePlanFrontmatter,
  setPlanBase,
  isSafeBranchName,
  listBranches,
  orderTaskIds,
  createWorktree,
  removeWorktree,
  mergeWorktreeBranch,
  copyToWorktree,
  commitWorktree,
  COAUTHOR_TRAILER,
  worktreeChangedFiles,
  worktreeFileDiff,
  pushBranch,
  gitNonInteractiveEnv,
  gitHead,
  hasRemote,
  resolveBaseBranch,
  baseStateDirty,
  commitBaseState,
  BASE_STATE_PATHS,

  // Per-feature state resolvers
  tasksFileFor,
  progressFileFor,
  getAllTasks,
  resolveActiveFeature,
  findTaskFeature,
  migrateLegacyTaskState,
  migrateLegacyPlanDraft,
  // Plan draft resolvers
  draftsDir,
  draftFileFor,
  draftDirFor,
  questionsFileFor,
  answersFileFor,
  generateDraftId,
  getAllDrafts,
  resolveActiveDraft,
  resolveActiveQuestionDraft,
  verifyDraftWritten,

  // Orchestration extensions
  buildWorkPromptForRole,
  resolveSkillTier,
  buildRoleContext,
  updateTaskWithRole,
  getNextUnblockedTaskForRole,
};

// ============================================================
// ORCHESTRATION EXTENSIONS
// ============================================================

const roles = require('./roles');
const gateway = require('./gateway');

/**
 * Build a work prompt tailored to a specific role.
 * Extends buildWorkPrompt() with role context + gateway routing.
 */
function buildWorkPromptForRole(paths, task, config, role) {
  const roleConfig = roles.getRole(role || 'developer');
  const agentDefPath = path.join(__dirname, '..', 'templates', 'agents', `${role || 'developer'}.md`);

  let agentDef = '';
  try {
    if (fileExists(agentDefPath)) {
      agentDef = fs.readFileSync(agentDefPath, 'utf8');
    }
  } catch { }

  // Gateway routing for this task
  const taskText = `${task.title || ''} ${task.description || ''}`;
  const gatewayResponse = gateway.buildGatewayResponse(taskText, paths.skillsDir || path.join(__dirname, '..', 'skills'));

  const basePrompt = buildWorkPrompt(paths, task, config);

  const roleSection = [
    `\n## Agent Role: ${roleConfig ? roleConfig.label : role}`,
    agentDef ? `\n${agentDef}` : '',
    `\n## Domain Context`,
    gatewayResponse.instruction,
    `\n## Skill Files to Load`,
    gatewayResponse.skill_paths.length > 0
      ? gatewayResponse.skill_paths.map(p => `  - ${p}`).join('\n')
      : '  (no specific library skills — use core skills)',
  ].join('\n');

  return basePrompt + roleSection;
}

/**
 * Resolve which skill tier a skill name belongs to.
 * Returns: { tier: 'core'|'library'|'legacy', path: string } or null.
 */
function resolveSkillTier(skillName, skillsBaseDir) {
  if (!skillName || !skillsBaseDir) return null;
  return {
    path: gateway.resolveSkillPath(skillName, skillsBaseDir),
    tier: gateway.resolveSkillPath(skillName, skillsBaseDir)
      ? (gateway.resolveSkillPath(skillName, skillsBaseDir).includes('/core/') ? 'core'
        : gateway.resolveSkillPath(skillName, skillsBaseDir).includes('/library/') ? 'library'
          : 'legacy')
      : null,
  };
}

/**
 * Build role context block for injection into agent prompts.
 */
function buildRoleContext(roleName, featureId, manifestPath) {
  const role = roles.getRole(roleName);
  if (!role) return '';

  const lines = [
    `## Role: ${role.label}`,
    `Tools allowed: ${role.tools.join(', ')}`,
    `Tools forbidden: ${role.forbidden_tools.join(', ')}`,
    `Completion signal: output "${role.completion_signal}" when done`,
    featureId ? `Feature ID: ${featureId}` : '',
    `Output directory: .jonggrang/.output/features/${featureId || '{feature_id}'}/`,
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Update a task's role field.
 */
function updateTaskWithRole(tasksFile, taskId, roleName) {
  const data = getTasks(tasksFile);
  const task = data.tasks.find(t => t.id === taskId);
  if (task) {
    task.role = roleName;
    writeJSON(tasksFile, data);
    return task;
  }
  return null;
}

/**
 * Get the next unblocked task for a specific role.
 * If role is null, falls back to getNextTask() behavior.
 */
function getNextUnblockedTaskForRole(tasksFile, targetRole) {
  if (!targetRole) return getNextTask(tasksFile);

  const data = getTasks(tasksFile);
  const done = data.tasks.filter(t => t.status === 'completed').map(t => t.id);

  const candidates = data.tasks
    .filter(t => (t.status === 'pending' || t.status === 'in_progress'))
    .filter(t => {
      const blockedBy = t.blocked_by || [];
      return blockedBy.length === 0 || blockedBy.every(id => done.includes(id));
    })
    .filter(t => {
      // Match by explicit role field, or infer from title/description
      const taskRole = t.role || roles.inferRoleFromTask(t);
      return taskRole === targetRole;
    })
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));

  return candidates.length > 0 ? candidates[0].id : null;
}
