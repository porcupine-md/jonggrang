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
    tasksFile:    path.join(jonggrangDir, 'jonggrang-tasks.json'),
    planFile:     path.join(jonggrangDir, 'plan.md'),
    progressFile: path.join(jonggrangDir, 'progress.txt'),
    agentsFile:   path.join(projectRoot, 'AGENTS.md'),
    skillsDir:    resolveSkillsDir(projectRoot, tool),
  };
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

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked', 'waiting', 'skipped']);

function generateTaskId(tasksFile) {
  const data = getTasks(tasksFile);
  let maxNum = 0;
  for (const task of data.tasks) {
    const match = (task.id || '').match(/^task-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `task-${String(maxNum + 1).padStart(3, '0')}`;
}

function addTask(tasksFile, taskData) {
  const data = getTasks(tasksFile);
  const id = taskData.id || generateTaskId(tasksFile);

  if (data.tasks.some(t => t.id === id)) {
    throw new Error(`Task ${id} already exists`);
  }

  const task = {
    id,
    title: taskData.title || '',
    description: taskData.description || '',
    priority: taskData.priority != null ? taskData.priority : data.tasks.length + 1,
    status: 'pending',
    feature_id: taskData.feature_id || null,
    skill: taskData.skill || null,
    blocked_by: taskData.blocked_by || [],
    passes: false,
    files: taskData.files || [],
    started_at: null,
    completed_at: null,
    error_log: [],
  };

  data.tasks.push(task);
  writeJSON(tasksFile, data);
  return task;
}

function addTasksBulk(tasksFile, taskDataArray) {
  const data = getTasks(tasksFile);
  const created = [];
  for (const taskData of taskDataArray) {
    const id = taskData.id || (() => {
      let maxNum = 0;
      for (const t of data.tasks) {
        const m = (t.id || '').match(/^task-(\d+)$/);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
      }
      return `task-${String(maxNum + 1).padStart(3, '0')}`;
    })();
    if (data.tasks.some(t => t.id === id)) {
      throw new Error(`Task ${id} already exists`);
    }
    const task = {
      id,
      title: taskData.title || '',
      description: taskData.description || '',
      priority: taskData.priority != null ? taskData.priority : data.tasks.length + 1,
      status: 'pending',
      feature_id: taskData.feature_id || null,
      skill: taskData.skill || null,
      blocked_by: taskData.blocked_by || [],
      passes: false,
      files: taskData.files || [],
      started_at: null,
      completed_at: null,
      error_log: [],
    };
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
  const bugCmd = featureId
    ? `jonggrang bug "description" --feature ${featureId}`
    : `jonggrang bug "description"`;

  return `# Jonggrang Work Session${revisionSection}

## Current Task
- ID: ${taskId}
- Title: ${taskTitle}
- Description: ${taskDesc}${featureId ? `\n- Feature: ${featureId}` : ''}

## Mode: ${mode}

## Context Files
Read these files for additional context before starting:
- AGENTS.md (project conventions)
- .jonggrang/progress.txt (learnings from previous sessions)${featureId ? `\n- .jonggrang/.output/features/${featureId}/plan.md (feature plan — archived after approval, do NOT read .jonggrang/plan.md)` : ''}
Note: .jonggrang/plan.md does not exist during execution — the plan was archived to the path above after approval.

## Task CLI — use these commands, do NOT read jonggrang-tasks.json directly
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
8. Append learnings to .jonggrang/progress.txt

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
- If you discover new patterns or gotchas, note them in .jonggrang/progress.txt
- If validation fails and you can't fix it in 2 attempts, stop and report the error
`;
}

// ============================================================
// TWO-PHASE PLANNING — PHASE 1: DRAFT PLAN
// ============================================================

/**
 * Build a prompt for Phase 1: generate a human-readable plan.md draft.
 * The AI writes .jonggrang/plan.md but does NOT touch jonggrang-tasks.json.
 */
function buildDraftPlanPrompt(description, configFile, tasksFile) {
  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  // Only embed completed tasks — to prevent re-doing finished work
  let completedSection = '';
  if (tasksFile && fileExists(tasksFile)) {
    const data = getTasks(tasksFile);
    const done = (data.tasks || []).filter(t => t.status === 'completed');
    if (done.length > 0) {
      completedSection = `## Already Completed Work\nDo NOT plan to redo these:\n${done.map(t => `- ${t.id}: ${t.title}`).join('\n')}\n`;
    }
  }

  const now = new Date().toISOString();

  return `# Jonggrang — Generate Draft Plan

## Feature Description
${description}

## Project Context
${configSection}${completedSection}
- Read AGENTS.md for project conventions
- Check existing code structure with ls/find if needed

## Your Task

Create a high-level plan for this feature. Write it to \`.jonggrang/plan.md\` using EXACTLY this format:

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
- Do NOT write to \`.jonggrang/jonggrang-tasks.json\` — tasks come in Phase 2 after human review
- After writing plan.md, output exactly: "Draft plan written to .jonggrang/plan.md"`;
}

// ============================================================
// TWO-PHASE PLANNING — PHASE 1.5: REVISE PLAN WITH AI
// ============================================================

/**
 * Build a prompt to revise an existing plan.md based on user feedback.
 * The AI rewrites plan.md in-place, preserving frontmatter unless explicitly changed.
 */
function buildRevisePlanPrompt(currentPlanContent, feedback) {
  return `# Jonggrang — Revise Draft Plan

## Current plan.md
\`\`\`markdown
${currentPlanContent}
\`\`\`

## User Feedback
${feedback}

## Your Task

Revise the plan above based on the user feedback.

Rules:
- Preserve the YAML frontmatter (feature, branch, work_type, description, created_at) UNLESS the feedback explicitly asks to change them
- Update the plan body: Approach, Phases, Key Decisions, Out of Scope, Dependencies
- Keep the exact same markdown structure and section headings
- Do NOT change work_type unless the user explicitly asks
- Write the revised plan to \`.jonggrang/plan.md\` (overwrite the file)
- After writing, output exactly: "Revised plan written to .jonggrang/plan.md"`;
}

// ============================================================
// TWO-PHASE PLANNING — PHASE 2: DECOMPOSE PLAN TO TASKS
// ============================================================

/**
 * Build a prompt for Phase 2: convert an approved plan.md into jonggrang-tasks.json.
 * planContent is the raw text of the approved plan.md.
 */
function buildTasksFromPlanPrompt(planContent, configFile, tasksFile, skillsDir) {
  let skillsList = '';
  if (skillsDir && fileExists(skillsDir)) {
    skillsList = findSkills(skillsDir).join(', ');
  }

  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  let currentTasksSection = '';
  let updateNote = '';
  if (tasksFile && fileExists(tasksFile)) {
    const data = getTasks(tasksFile);
    if (data.tasks?.length > 0) {
      currentTasksSection = `## Existing Tasks (jonggrang-tasks.json)\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
      const completedCount = data.tasks.filter(t => t.status === 'completed').length;
      if (completedCount > 0) {
        updateNote = `\n## ⚠️ UPDATE MODE\n${completedCount} tasks already completed — NEVER modify or remove them. Append new tasks after the last existing ID.\n`;
      }
    }
  }

  return `# Jonggrang — Decompose Approved Plan to Tasks

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

**Use the CLI to add tasks — do NOT edit jonggrang-tasks.json directly.**

Run this single command to add all tasks at once:
\`\`\`bash
jonggrang task import --input '<JSON array of task objects>'
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
- Always include "id" (task-001, task-002, ...) so blocked_by references work correctly
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
    currentTasksSection = `## Current Tasks (jonggrang-tasks.json)\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;

    if (updateMode && data.tasks?.length) {
      const completedCount = data.tasks.filter(t => t.status === 'completed').length;
      const pendingCount   = data.tasks.filter(t => t.status === 'pending').length;
      const totalCount     = data.tasks.length;
      updateInstructions = `
## UPDATE MODE
This is a plan UPDATE, not a fresh plan. jonggrang-tasks.json already has ${totalCount} tasks (${completedCount} completed, ${pendingCount} pending).

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
3. Write the tasks directly to .jonggrang/jonggrang-tasks.json using this exact schema:

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

5. After writing .jonggrang/jonggrang-tasks.json, report the plan summary`;
}

function buildReviewPrompt() {
  return `# Jonggrang Review Session

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

  // Validate model/effort flags early (throws on invalid combos, e.g. bare
  // model name for OpenCode) and translate to backend-specific argv fragments.
  const extraFlags = buildAgentArgs({ tool, model, effort });

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
          }
        } else if (obj.type === 'tool_use') {
          const part   = obj.part || {};
          const toolId = part.id || null;
          const toolName = part.tool || '?';
          const state  = part.state || {};
          const input  = state.input || {};

          const hasOutput = state.output !== undefined;
          const hasError  = state.error  !== undefined;

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
        resolve(code || 0);
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
        resolve(streamError ? 1 : (code || 0));
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
              const modelId  = trimmed.substring(slash + 1).trim();
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
            const cfgModelId  = readConfig(path.join(projectRoot, '.jonggrang', 'jonggrang.json'), 'model', '');
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
          try { session?.dispose(); } catch {}
          resolve(0);
        } catch (err) {
          process.stderr.write(`[jonggrang] error: ${err.message}\n`);
          try { session?.dispose(); } catch {}
          resolve(1);
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
              }
            }
          } else if (item.type === 'function_call') {
            const name   = item.name || '?';
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
        resolve(code || 0);
      });

    } else {
      resolve(1);
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
               : tool === 'codex'    ? './.codex/skills'
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

function runInit(options, jonggrangHome, projectRoot) {
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

  // 3. jonggrang-tasks.json
  writeJSON(paths.tasksFile, { feature: '', branch: '', tasks: [] });

  // 4. progress.txt
  const now = new Date().toISOString().split('T')[0];
  fs.writeFileSync(paths.progressFile, `# Jonggrang Progress Log — ${name}\n# Created: ${now}\n`);

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

  return { skillCount };
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
function groupPlans(tasksFile, projectRoot) {
  const data = getTasks(tasksFile);
  const runnable = data.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
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
    if (featureId !== '__default__') {
      const fm = parsePlanFrontmatter(path.join(featuresDir, featureId, 'plan.md'));
      branch = fm.branch || '';
      title = fm.feature || fm.description || '';
    }
    if (!branch) branch = data.branch || `jonggrang/${featureId}`;
    if (!title)  title  = data.feature || featureId;
    const taskIds = orderTaskIds(tasks);
    result.push({ featureId, branch, title, taskIds, tasks });
  }
  // Stable order: by first task priority so the UI is deterministic.
  result.sort((a, b) => (a.tasks[0]?.priority || 0) - (b.tasks[0]?.priority || 0));
  return result;
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

// Push a branch to a remote (creates/updates the remote branch of the same name).
// ASYNC on purpose: pushing is a network op, so we must NOT use execSync — that
// blocks Node's single-threaded event loop and freezes the whole dashboard for
// the duration. GIT_TERMINAL_PROMPT=0 fails fast instead of hanging on a prompt,
// and the timeout bounds a stuck network/auth. Returns a Promise.
function pushBranch(projectRoot, branch, remote = 'origin') {
  return new Promise((resolve, reject) => {
    execFile('git', ['push', '-u', remote, branch], {
      cwd: projectRoot,
      timeout: 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
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
  try { cur = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim(); } catch {}
  if (cur === 'main' || cur === 'master') return cur;
  const has = (b) => {
    try { execSync(`git rev-parse --verify refs/heads/${b}`, { cwd: projectRoot, stdio: 'pipe' }); return true; }
    catch { return false; }
  };
  if (has('main')) return 'main';
  if (has('master')) return 'master';
  return 'main';
}

const BASE_STATE_PATHS = ['.jonggrang/.output', '.jonggrang/jonggrang-tasks.json', '.jonggrang/progress.txt'];

function baseStateDirty(projectRoot) {
  try {
    const args = BASE_STATE_PATHS.map(p => `"${p}"`).join(' ');
    return !!execSync(`git status --porcelain -- ${args}`, { cwd: projectRoot, encoding: 'utf8' }).trim();
  } catch { return false; }
}

const JONGGRANG_GIT_IDENTITY = {
  GIT_AUTHOR_NAME:     process.env.GIT_AUTHOR_NAME     || 'jonggrang',
  GIT_AUTHOR_EMAIL:    process.env.GIT_AUTHOR_EMAIL    || 'jonggrang@local',
  GIT_COMMITTER_NAME:  process.env.GIT_COMMITTER_NAME  || 'jonggrang',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'jonggrang@local',
};

function commitBaseState(projectRoot, message) {
  for (const p of BASE_STATE_PATHS) {
    try { execSync(`git add -- "${p}"`, { cwd: projectRoot, stdio: 'pipe' }); } catch {}
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
function buildBugsToTasksPrompt(openBugs, featureId, configFile, tasksFile) {
  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  let existingSection = '';
  if (tasksFile && fileExists(tasksFile)) {
    const data = getTasks(tasksFile);
    if (data.tasks && data.tasks.length > 0) {
      existingSection = `## Existing Tasks (do NOT duplicate)\n${data.tasks.map(t => `- ${t.id}: [${t.status}] ${t.title}`).join('\n')}\n`;
    }
  }

  const bugList = openBugs.map((b, i) =>
    `### Bug ${i + 1} (${b.id})\n${b.description}`
  ).join('\n\n');

  return `# Jonggrang — Convert Bug Reports to Tasks

## Feature ID
${featureId}

${configSection}${existingSection}
## Bug Reports to Convert

${bugList}

## Your Task

For each bug above, create one BUGFIX task in \`.jonggrang/jonggrang-tasks.json\`.

Each task must follow this schema exactly:
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
- Read the current jonggrang-tasks.json to determine the next task-NNN number
- Append the new tasks (do NOT overwrite existing ones)
- After writing, output one line per bug in the format:
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
function buildDeepPlanDiscoveryPrompt(description, configFile) {
  let configSection = '';
  if (configFile && fileExists(configFile)) {
    const cfg = readJSON(configFile);
    if (cfg) configSection = `## Project Config\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\`\n`;
  }

  return `# Jonggrang Deep Plan — Phase 1: Codebase Discovery

## Feature Request
${description}

## Project Context
${configSection}- Read AGENTS.md for project conventions and patterns
- Explore the codebase to understand existing structure

## Your Task

You are performing codebase discovery for the feature above. Your goal is to understand the existing code so the plan can be precise and realistic.

Investigate:
1. **File structure** — Run \`find . -type f -name "*.ts" -o -name "*.js" | grep -v node_modules | head -50\` (or equivalent for the stack)
2. **Existing patterns** — Read key files relevant to this feature. Look for existing similar implementations.
3. **Dependencies** — Check package.json / Cargo.toml / go.mod / etc. Note libraries already available.
4. **Related code** — Find code that this feature will need to touch or extend.
5. **Potential risks** — Note database schemas, APIs, or contracts that constrain the implementation.
6. **Test patterns** — How are tests currently structured? What test helpers exist?

Write your findings to \`.jonggrang/.ephemeral/deep-plan-discovery.md\` using this EXACT format:

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

After writing the file, output exactly: "Discovery complete: .jonggrang/.ephemeral/deep-plan-discovery.md"`;
}

/**
 * Phase 2 of --deep: Complexity analysis + brainstorm alternatives.
 * The agent reads the discovery report and thinks about approaches before committing to a plan.
 * Writes to .jonggrang/.ephemeral/deep-plan-analysis.md
 */
function buildDeepPlanAnalysisPrompt(description, discoveryContent) {
  return `# Jonggrang Deep Plan — Phase 2: Complexity Analysis & Brainstorm

## Feature Request
${description}

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

Write your analysis to \`.jonggrang/.ephemeral/deep-plan-analysis.md\` using this EXACT format:

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

After writing the file, output exactly: "Analysis complete: .jonggrang/.ephemeral/deep-plan-analysis.md"`;
}

/**
 * Phase 3 of --deep: Condense discovery + analysis into enriched plan.md
 * Reads both ephemeral files and writes a richer plan.md than the standard one.
 */
function buildDeepPlanCondensePrompt(description, discoveryContent, analysisContent, configFile, tasksFile) {
  let completedSection = '';
  if (tasksFile && fileExists(tasksFile)) {
    const data = getTasks(tasksFile);
    const done = (data.tasks || []).filter(t => t.status === 'completed');
    if (done.length > 0) {
      completedSection = `## Already Completed Work\nDo NOT plan to redo these:\n${done.map(t => `- ${t.id}: ${t.title}`).join('\n')}\n`;
    }
  }

  const now = new Date().toISOString();

  return `# Jonggrang Deep Plan — Phase 3: Condense to Plan

## Feature Request
${description}

## Discovery Report
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

Write \`.jonggrang/plan.md\` using EXACTLY this format (enriched version for --deep plans):

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
- Do NOT write to jonggrang-tasks.json
- After writing plan.md, output exactly: "Deep plan written to .jonggrang/plan.md"`;
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
  generateTaskId,
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

  // Prompt builders
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
  parsePlanFrontmatter,
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
  gitHead,
  hasRemote,
  resolveBaseBranch,
  baseStateDirty,
  commitBaseState,

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
