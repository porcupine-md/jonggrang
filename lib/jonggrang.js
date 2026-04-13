//
// JONGGRANG — Shared Library
// Core functions used by both CLI (bin/jonggrang.js) and web server (server.js)
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ============================================================
// CONFIGURATION HELPERS
// ============================================================

function resolveSkillsDir(projectRoot, tool) {
  if (tool === 'claude') return path.join(projectRoot, '.claude', 'skills');
  if (tool === 'opencode') return path.join(projectRoot, '.opencode', 'skills');
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
    tasksFile: path.join(jonggrangDir, 'jonggrang-tasks.json'),
    progressFile: path.join(jonggrangDir, 'progress.txt'),
    agentsFile: path.join(projectRoot, 'AGENTS.md'),
    skillsDir: resolveSkillsDir(projectRoot, tool),
  };
}

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
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
    case 'vitest':  return 'npx vitest run';
    case 'jest':    return 'npx jest';
    case 'go-test': return 'go test ./...';
    case 'pytest':  return 'pytest';
    default:        return "echo 'no test command configured'";
  }
}

// ============================================================
// PROMPT BUILDERS
// ============================================================

function buildWorkPrompt(taskId, tasksFile, mode) {
  const task = getTask(tasksFile, taskId);
  if (!task) return '';

  const taskTitle = task.title || taskId;
  const taskDesc = task.description || task.title;
  const taskSkill = task.skill || '';

  const skillLine = taskSkill
    ? `Read the skill template: skills/${taskSkill}/SKILL.md`
    : 'Plan your implementation approach';

  const revisionFeedback = process.env.JONGGRANG_REVISION_FEEDBACK;
  const revisionSection = revisionFeedback
    ? `\n## Revision Feedback\n${revisionFeedback}\n\nApply these changes before proceeding.\n`
    : '';

  return `# Jonggrang Work Session${revisionSection}

## Context Files
Read these files for context before starting:
- AGENTS.md (project conventions)
- .jonggrang/progress.txt (learnings from previous sessions)
- .jonggrang/jonggrang-tasks.json (current task state)

## Current Task
- ID: ${taskId}
- Title: ${taskTitle}
- Description: ${taskDesc}

## Mode: ${mode}

## Instructions
1. Read the context files listed above
2. Understand the task requirements
3. ${skillLine}
4. Implement the task
5. Run validation: typecheck, tests, lint
6. If all pass, commit with message format: "type(scope): description"
7. Update .jonggrang/jonggrang-tasks.json to mark task as completed (passes: true)
8. Append learnings to .jonggrang/progress.txt

## Important
- Keep changes atomic — only modify files relevant to this task
- Follow conventions in AGENTS.md
- If you discover new patterns or gotchas, note them in .jonggrang/progress.txt
- If validation fails and you can't fix it in 2 attempts, stop and report the error
`;
}

function buildPlanPrompt(description, updateMode, tasksFile, skillsDir) {
  // List available skills
  let skillsList = '';
  if (fileExists(skillsDir)) {
    try {
      skillsList = fs.readdirSync(skillsDir)
        .filter(d => fs.statSync(path.join(skillsDir, d)).isDirectory())
        .join(', ');
    } catch { /* ignore */ }
  }

  let updateInstructions = '';
  if (updateMode && fileExists(tasksFile)) {
    const data = getTasks(tasksFile);
    const completedCount = data.tasks.filter(t => t.status === 'completed').length;
    const pendingCount = data.tasks.filter(t => t.status === 'pending').length;
    const totalCount = data.tasks.length;

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

  return `# Jonggrang Plan — Decompose Feature

## Feature Description
${description}

## Project Context
- Read AGENTS.md for project conventions
- Read .jonggrang/jonggrang.json for project config (type, stack, testing framework)
- Read existing .jonggrang/jonggrang-tasks.json for current state (may have existing tasks)
- Check existing code structure with ls/find

## Available Skills
These skill templates exist in skills/ and can be referenced in tasks: ${skillsList}
${updateInstructions}
## Instructions
1. Analyze the feature description and project context
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

function runAgent(prompt, tool, permMode, projectRoot) {
  return new Promise((resolve) => {
    if (tool === 'opencode') {
      // opencode run --format json <prompt>
      // Permissions are configured via opencode.json (generated during init)
      const child = spawn('opencode', ['run', '--format', 'json', prompt], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let buffer = '';
      let atLineStart = true;
      let totalCost = 0;

      function handleOpenCodeLine(line) {
        if (!line.trim()) return;
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
          const part = obj.part || {};
          const toolName = part.tool || '?';
          const input = part.state?.input || {};
          const detail = input.command || input.file || input.file_path || input.path
            || input.pattern || input.url || input.query || part.state?.title || '';
          if (!atLineStart) process.stdout.write('\n');
          process.stdout.write(`\x1b[90m▸ ${toolName}\x1b[0m`);
          if (detail) {
            const short = detail.length > 80 ? detail.slice(0, 77) + '...' : detail;
            process.stdout.write(` \x1b[2m${short}\x1b[0m`);
          }
          process.stdout.write('\n');
          atLineStart = true;
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
        case 'autonomous':  claudeFlags.push('--dangerously-skip-permissions'); break;
        case 'balanced':    claudeFlags.push('--permission-mode', 'acceptEdits'); break;
        case 'supervised':  claudeFlags.push('--permission-mode', 'default'); break;
      }

      const args = [
        '-p',
        ...claudeFlags,
        '--add-dir', projectRoot,
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
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

      function handleStreamLine(line) {
        if (!line.trim()) return;
        let obj;
        try { obj = JSON.parse(line); } catch { return; }

        if (obj.type === 'stream_event') {
          const ev = obj.event;
          if (!ev) return;

          if (ev.type === 'content_block_start') {
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
        resolve(streamError ? 1 : (code || 0));
      });

    } else {
      resolve(1);
    }
  });
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
      directory: tool === 'opencode' ? './.opencode/skills' : './.claude/skills',
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

  // 1b. opencode.json (OpenCode reads this from project root)
  {
    const opencodeCfg = generateOpenCodeConfig(options);
    const opencodeCfgPath = path.join(projectRoot, 'opencode.json');
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
    // Always install skills for both tools
    const skillTargets = [
      path.join(projectRoot, '.claude', 'skills'),
      path.join(projectRoot, '.opencode', 'skills'),
    ];

    try {
      const skillDirs = fs.readdirSync(jonggrangSkillsDir).filter(d =>
        fs.statSync(path.join(jonggrangSkillsDir, d)).isDirectory()
      );
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

function createWorktree(projectRoot, groupId, baseBranch) {
  const worktreePath = path.join(os.tmpdir(), `jonggrang-${groupId}-${Date.now()}`);
  const branch = `jonggrang/${groupId}`;

  // Clean up stale worktree and branch from previous runs
  try {
    execSync('git worktree prune', { cwd: projectRoot, stdio: 'pipe' });
  } catch { /* ignore */ }
  try {
    execSync(`git branch -D "${branch}"`, { cwd: projectRoot, stdio: 'pipe' });
  } catch { /* branch may not exist */ }

  const baseSha = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
  execSync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, {
    cwd: projectRoot, stdio: 'pipe',
  });
  return { worktreePath, branch, baseSha };
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
  buildWorkPrompt,
  buildPlanPrompt,
  buildReviewPrompt,

  // Agent runner
  runAgent,

  // Init helpers
  generateAgentsMd,
  generateConfig,
  generateOpenCodeConfig,
  runInit,

  // Parallel / worktree
  getTaskGroups,
  createWorktree,
  removeWorktree,
  mergeWorktreeBranch,
  copyToWorktree,

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
  } catch {}

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
