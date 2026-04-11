#!/usr/bin/env node
//
// JONGGRANG — AI Development Workflow Orchestrator (Node.js CLI)
// Node.js CLI implementation
//

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const { intro, outro, select, confirm, text, isCancel, cancel, spinner } = require('@clack/prompts');

const lib = require('../lib/jonggrang');
const orchestration = require('../lib/orchestration');
const hooksLib = require('../lib/hooks');
const compaction = require('../lib/compaction');
const feedback = require('../lib/feedback');

// ============================================================
// CONFIGURATION
// ============================================================

function resolveJonggrangHome() {
  if (process.env.JONGGRANG_HOME) return process.env.JONGGRANG_HOME;

  const candidates = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'templates', 'AGENTS.md.template'))) {
      return candidate;
    }
  }

  return path.resolve(__dirname, '..');
}

const JONGGRANG_HOME = resolveJonggrangHome();
const PROJECT_ROOT = process.cwd();

const paths = lib.getProjectPaths(PROJECT_ROOT);
const CONFIG_FILE = process.env.JONGGRANG_CONFIG || paths.configFile;
const TASKS_FILE = paths.tasksFile;
const PROGRESS_FILE = paths.progressFile;
const AGENTS_FILE = paths.agentsFile;
const SKILLS_DIR = paths.skillsDir;

const JONGGRANG_VERSION = '0.1.0';

// Defaults (can be overridden by flags/env)
let MAX_ITERATIONS = parseInt(process.env.JONGGRANG_MAX_ITERATIONS || '0', 10);
let MODE = process.env.JONGGRANG_MODE || 'autonomous';
let TOOL = process.env.JONGGRANG_TOOL || 'opencode';
let TOOL_SET = false;
let TASK_ID = '';
let BRANCH = '';
let VERBOSE = process.env.JONGGRANG_VERBOSE === 'true';
let DRY_RUN = process.env.JONGGRANG_DRY_RUN === 'false';
let WEB_PORT = parseInt(process.env.JONGGRANG_WEB_PORT || '7777', 10);
let WEB_OPEN = true;
let WORKTREE_MODE = false;
let GROUP_TASK_IDS = [];
let ORCHESTRATE_RESUME = false;
let ORCHESTRATE_ROLE = '';

// Init options
let INIT_NAME = '';
let INIT_TYPE = '';
let INIT_WORK_MODE = '';
let INIT_TEAM_SIZE = '';
let INIT_STATE = '';
let INIT_STACK = '';
let INIT_AUTONOMY = '';
let INIT_CI = '';
let INIT_TESTING = '';
let INIT_TOOL = '';
let INIT_FORCE = false;

// ============================================================
// COLORS
// ============================================================

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[0;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m';
const BOLD = '\x1b[1m';

// ============================================================
// LOGGING HELPERS
// ============================================================

function logInfo(msg) { console.log(`${BLUE}[jonggrang]${NC} ${msg}`); }
function logSuccess(msg) { console.log(`${GREEN}[jonggrang]${NC} ${msg}`); }
function logWarn(msg) { console.log(`${YELLOW}[jonggrang]${NC} ${msg}`); }
function logError(msg) { console.error(`${RED}[jonggrang]${NC} ${msg}`); }
function logHeader(msg) {
  console.log('');
  console.log(`${BOLD}${CYAN}==============================${NC}`);
  console.log(`${BOLD}${CYAN}  ${msg}${NC}`);
  console.log(`${BOLD}${CYAN}==============================${NC}`);
  console.log('');
}

// ============================================================
// CLI HELPERS
// ============================================================

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function checkDeps() {
  const missing = [];
  for (const cmd of ['jq', 'git']) {
    if (!commandExists(cmd)) missing.push(cmd);
  }
  if (!commandExists(TOOL)) missing.push(TOOL);

  if (missing.length > 0) {
    logError(`Missing dependencies: ${missing.join(', ')}`);
    console.log('');
    for (const cmd of missing) {
      switch (cmd) {
        case 'jq':       console.log('  Install jq:       brew install jq'); break;
        case 'git':      console.log('  Install git:      brew install git'); break;
        case 'opencode': console.log('  Install opencode: curl -fsSL https://opencode.ai/install | bash'); break;
        case 'claude':   console.log('  Install claude:   npm install -g @anthropic-ai/claude-code'); break;
        default:         console.log(`  Install ${cmd}`); break;
      }
    }
    console.log('');
    process.exit(1);
  }
}

function safeCheckConfig() {
  try {
    lib.checkConfig(CONFIG_FILE);
  } catch (err) {
    logError(err.message);
    process.exit(1);
  }
}

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, prompt, defaultVal, options) {
  return new Promise((resolve) => {
    const optStr = options ? ` [${options}]` : '';
    const q = `  ${CYAN}?${NC} ${prompt}${optStr} (default: ${defaultVal})\n    > `;
    rl.question(q, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

// ============================================================
// WORK LOOP
// ============================================================

function emitSignal(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

// In worktree mode emit a JSON signal; otherwise write directly to tasks file
function updateTaskMode(taskId, status) {
  if (WORKTREE_MODE) {
    emitSignal('task_status', { taskId, status });
  } else {
    lib.updateTaskStatus(TASKS_FILE, taskId, status);
  }
}

async function runIteration(iteration, taskId) {
  const task = lib.getTask(TASKS_FILE, taskId);
  const taskTitle = task ? task.title : taskId;

  logHeader(`Iteration ${iteration}: ${taskTitle}`);

  updateTaskMode(taskId, 'in_progress');

  const prompt = lib.buildWorkPrompt(taskId, TASKS_FILE, MODE);

  if (DRY_RUN) {
    logWarn(`[DRY RUN] Would execute prompt for task: ${taskId}`);
    console.log(prompt);
    return true;
  }

  logInfo(`Spawning fresh ${TOOL} instance...`);

  const exitCode = await lib.runAgent(prompt, TOOL, MODE, PROJECT_ROOT);

  if (exitCode === 0) {
    const data = lib.getTasks(TASKS_FILE);
    const t = data.tasks.find(t => t.id === taskId);
    if (t && t.status === 'completed') {
      logSuccess(`Task ${taskId} completed successfully`);
      updateTaskMode(taskId, 'completed');
      return true;
    } else {
      logWarn('Agent finished but did not mark task complete. Reverting to pending.');
      updateTaskMode(taskId, 'pending');
      return false;
    }
  } else {
    logWarn(`Agent exited with error (code: ${exitCode}). Reverting task to pending.`);
    updateTaskMode(taskId, 'pending');
    return false;
  }
}

async function cmdWork() {
  safeCheckConfig();

  if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
    TOOL = lib.readConfig(CONFIG_FILE, 'tool', 'opencode');
  }
  if (MODE === 'autonomous') {
    MODE = lib.readConfig(CONFIG_FILE, 'mode.autonomy', 'autonomous');
  }

  const configMax = parseInt(lib.readConfig(CONFIG_FILE, 'work.max_iterations', '0'), 10);
  if (MAX_ITERATIONS === 0) MAX_ITERATIONS = configMax;

  // In worktree mode or with explicit group tasks, don't limit — run until all tasks done
  if (WORKTREE_MODE || GROUP_TASK_IDS.length > 0) MAX_ITERATIONS = 0;

  logHeader('JONGGRANG Work Loop');
  logInfo(`Tool: ${TOOL}`);
  logInfo(`Mode: ${MODE}`);
  if (WORKTREE_MODE) logInfo('Worktree mode: ON');
  logInfo(MAX_ITERATIONS === 0 ? 'Max iterations: unlimited' : `Max iterations: ${MAX_ITERATIONS}`);
  logInfo(`Tasks: ${lib.countPending(TASKS_FILE)} pending / ${lib.countTotal(TASKS_FILE)} total`);

  // Skip branch checkout in worktree mode (worktree already on its own branch)
  if (!WORKTREE_MODE && BRANCH) {
    logInfo(`Branch: ${BRANCH}`);
    try {
      execSync(`git checkout -b ${BRANCH}`, { cwd: PROJECT_ROOT, stdio: 'ignore' });
    } catch {
      execSync(`git checkout ${BRANCH}`, { cwd: PROJECT_ROOT, stdio: 'ignore' });
    }
  }

  // Build task queue
  let taskQueue = [];
  if (GROUP_TASK_IDS.length > 0) {
    // Worktree mode: use the provided group task list
    taskQueue = GROUP_TASK_IDS.filter(id => {
      const t = lib.getTask(TASKS_FILE, id);
      return t && t.status !== 'completed';
    });
    logInfo(`Group tasks: ${taskQueue.join(', ')}`);
  } else if (TASK_ID) {
    taskQueue = lib.getTaskQueue(TASKS_FILE, TASK_ID);
    if (taskQueue.length > 1) {
      logInfo(`Task ${TASK_ID} has ${taskQueue.length - 1} pending dependencies — will process them first`);
    }
    if (!WORKTREE_MODE) {
      taskQueue.forEach((id, i) => {
        const t = lib.getTask(TASKS_FILE, id);
        const label = id === TASK_ID ? '(target)' : `(dep ${i + 1})`;
        lib.updateTaskStatus(TASKS_FILE, id, 'waiting');
        logInfo(`  ${i + 1}. ${id}: ${t ? t.title : '?'} ${label}`);
      });
    }
    TASK_ID = '';
  }

  let iteration = 0;
  let consecutiveFails = 0;
  let lastFailedTask = '';
  const killAfter = parseInt(lib.readConfig(CONFIG_FILE, 'work.kill_after_fails', '3'), 10);

  while (MAX_ITERATIONS === 0 || iteration < MAX_ITERATIONS) {
    iteration++;

    let taskId;
    if (taskQueue.length > 0) {
      taskId = taskQueue.shift();
    } else {
      taskId = lib.getNextTask(TASKS_FILE);
    }

    if (!taskId) {
      logSuccess('All tasks completed!');
      logInfo(`Completed: ${lib.countCompleted(TASKS_FILE)} / ${lib.countTotal(TASKS_FILE)}`);
      console.log('');
      console.log('COMPLETE');
      return;
    }

    const success = await runIteration(iteration, taskId);

    if (success) {
      consecutiveFails = 0;
      lastFailedTask = '';
    } else {
      if (lastFailedTask === taskId) {
        consecutiveFails++;
      } else {
        consecutiveFails = 1;
        lastFailedTask = taskId;
      }

      if (consecutiveFails >= killAfter) {
        logError(`Task ${taskId} failed ${consecutiveFails} times. Marking as blocked.`);
        updateTaskMode(taskId, 'blocked');
        consecutiveFails = 0;
        lastFailedTask = '';
      }
    }

    console.log('');
    if (MAX_ITERATIONS === 0) {
      logInfo(`Progress: ${lib.countCompleted(TASKS_FILE)}/${lib.countTotal(TASKS_FILE)} tasks | Iteration ${iteration}`);
    } else {
      logInfo(`Progress: ${lib.countCompleted(TASKS_FILE)}/${lib.countTotal(TASKS_FILE)} tasks | Iteration ${iteration}/${MAX_ITERATIONS}`);
    }
    console.log('');
  }

  if (!WORKTREE_MODE) lib.revertWaiting(TASKS_FILE);

  logWarn(`Max iterations (${MAX_ITERATIONS}) reached. Run 'jonggrang work' to continue.`);
  logInfo(`Completed: ${lib.countCompleted(TASKS_FILE)} / ${lib.countTotal(TASKS_FILE)}`);
  console.log('');
  console.log('PAUSED');
}

// ============================================================
// STATUS
// ============================================================

function cmdStatus() {
  safeCheckConfig();

  logHeader('JONGGRANG Task Board');

  const projectName = lib.readConfig(CONFIG_FILE, 'name', 'unknown');
  console.log(`Project: ${BOLD}${projectName}${NC}`);
  console.log(`Tasks: ${lib.countCompleted(TASKS_FILE)}/${lib.countTotal(TASKS_FILE)} completed`);
  console.log('');

  console.log(`${BOLD}ID          Status       Owner      Title${NC}`);
  console.log('--------------------------------------------------------------');

  const data = lib.getTasks(TASKS_FILE);
  for (const task of data.tasks) {
    let color;
    switch (task.status) {
      case 'completed':   color = GREEN; break;
      case 'in_progress': color = YELLOW; break;
      case 'blocked':     color = RED; break;
      default:            color = NC; break;
    }
    const id = (task.id || '').padEnd(11);
    const status = (task.status || '').padEnd(12);
    const owner = (task.owner || '-').padEnd(10);
    console.log(`${color}${id} ${status} ${owner} ${task.title || ''}${NC}`);
  }
}

// ============================================================
// REVIEW
// ============================================================

async function cmdReview() {
  safeCheckConfig();

  if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
    TOOL = lib.readConfig(CONFIG_FILE, 'tool', 'opencode');
  }

  logHeader('JONGGRANG Review');

  const reviewPrompt = lib.buildReviewPrompt();

  const logDir = path.join(PROJECT_ROOT, 'jonggrang-log');
  if (!lib.fileExists(logDir)) fs.mkdirSync(logDir, { recursive: true });

  logInfo('Running comprehensive review...');
  await lib.runAgent(reviewPrompt, TOOL, 'autonomous', PROJECT_ROOT);

  logSuccess('Review complete. Check jonggrang-log/ for report.');
}

// ============================================================
// PLAN
// ============================================================

async function cmdPlan(args) {
  let description = '';
  let updateMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--update') {
      updateMode = true;
    } else {
      description = args[i];
    }
  }

  if (!description) {
    logError('Usage: jonggrang plan "<feature-description>"');
    process.exit(1);
  }

  safeCheckConfig();

  // Auto-detect update mode
  if (!updateMode && lib.fileExists(TASKS_FILE)) {
    const data = lib.getTasks(TASKS_FILE);
    if (data.tasks.length > 0) updateMode = true;
  }

  if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
    TOOL = lib.readConfig(CONFIG_FILE, 'tool', 'opencode');
  }

  const isInteractiveTTY = process.stdin.isTTY && process.stdout.isTTY;
  let planSpinner = null;
  let outroShown = false;

  if (isInteractiveTTY) {
    intro('Jonggrang Planner');
    planSpinner = spinner();
    planSpinner.start('Consulting AI agent...');
  }

  try {
    logHeader('JONGGRANG Plan');
    logInfo(`Feature: ${description}`);
    logInfo(`Tool: ${TOOL}`);
    if (updateMode) logInfo('Mode: UPDATE (preserving completed tasks)');
    if (planSpinner) planSpinner.message('Consulting AI agent (this can take ~30s)...');

    const planPrompt = lib.buildPlanPrompt(description, updateMode, TASKS_FILE, SKILLS_DIR);

    await lib.runAgent(planPrompt, TOOL, 'autonomous', PROJECT_ROOT);

    console.log('');
    logSuccess('Plan complete. Review the tasks:');
    console.log('');
    cmdStatus();

    if (planSpinner) {
      planSpinner.stop('Plan ready. Task board updated.');
      outro('Tasks updated — run "jonggrang work" when you are ready.');
      outroShown = true;
    }
  } catch (err) {
    if (planSpinner) {
      planSpinner.stop(`Plan failed: ${err.message || err}`, 1);
    }
    throw err;
  } finally {
    if (planSpinner && !outroShown) {
      planSpinner.stop('Plan finished.');
    }
  }
}

// ============================================================
// INIT
// ============================================================

async function cmdInit() {
  logHeader('JONGGRANG — Project Setup');

  const isInteractiveTTY = process.stdin.isTTY && process.stdout.isTTY;

  if (lib.fileExists(CONFIG_FILE) && !INIT_FORCE) {
    if (isInteractiveTTY) {
      const overwrite = await confirm({
        message: 'jonggrang.json already exists. Overwrite?',
        initialValue: false,
      });
      if (isCancel(overwrite)) {
        cancel('Init cancelled.');
        return;
      }
      if (!overwrite) {
        logInfo('Aborted.');
        return;
      }
    } else {
      logError('jonggrang.json already exists. Use --force to overwrite.');
      process.exit(1);
    }
  }

  console.log('');

  if (isInteractiveTTY) {
    intro('Jonggrang Init Wizard');

    const defaultName = path.basename(PROJECT_ROOT);

    if (!INIT_NAME) {
      const nameAnswer = await text({
        message: 'Project name',
        initialValue: defaultName,
        validate(value) {
          if (!value || !value.trim()) return 'Project name is required.';
        },
      });
      if (isCancel(nameAnswer)) {
        cancel('Init cancelled.');
        return;
      }
      INIT_NAME = nameAnswer.trim();
    }

    if (!INIT_TYPE) {
      const typeAnswer = await select({
        message: 'Project type',
        initialValue: 'api',
        options: [
          { value: 'web-app', label: 'web-app' },
          { value: 'api', label: 'api' },
          { value: 'library', label: 'library' },
          { value: 'cli', label: 'cli' },
          { value: 'tui', label: 'tui' },
        ],
      });
      if (isCancel(typeAnswer)) {
        cancel('Init cancelled.');
        return;
      }
      INIT_TYPE = typeAnswer;
    }

    if (!INIT_WORK_MODE) {
      const workModeAnswer = await select({
        message: 'Work mode',
        initialValue: 'solo',
        options: [
          { value: 'solo', label: 'Solo' },
          { value: 'team', label: 'Team' },
        ],
      });
      if (isCancel(workModeAnswer)) {
        cancel('Init cancelled.');
        return;
      }
      INIT_WORK_MODE = workModeAnswer;
    }

    if (INIT_WORK_MODE === 'team' && !INIT_TEAM_SIZE) {
      const teamSizeAnswer = await select({
        message: 'Team size',
        initialValue: '3',
        options: ['2', '3', '4', '5'].map((value) => ({ value, label: value })),
      });
      if (isCancel(teamSizeAnswer)) {
        cancel('Init cancelled.');
        return;
      }
      INIT_TEAM_SIZE = teamSizeAnswer;
    } else if (!INIT_TEAM_SIZE) {
      INIT_TEAM_SIZE = '1';
    }

    if (!INIT_STATE) {
      const stateAnswer = await select({
        message: 'Project state',
        initialValue: 'existing',
        options: [
          { value: 'new', label: 'New project' },
          { value: 'existing', label: 'Adopt existing codebase' },
        ],
      });
      if (isCancel(stateAnswer)) {
        cancel('Init cancelled.');
        return;
      }
      INIT_STATE = stateAnswer;
    }

    if (!INIT_STACK) {
      if (INIT_STATE === 'existing') {
        const detected = lib.detectStack(PROJECT_ROOT);
        if (detected !== 'unknown') {
          INIT_STACK = detected;
          logInfo(`Detected stack: ${INIT_STACK}`);
        }
      }
      if (!INIT_STACK) {
        const stackOptions = {
          'web-app': 'nextjs-typescript|express-typescript|node-typescript',
          'api': 'express-typescript|go|python-fastapi|node-typescript',
          'library': 'library-typescript|go|python|rust',
          'cli': 'go|rust|node-typescript|python',
          'tui': 'go|rust|python|node-typescript',
        };
        const stackDefaults = {
          'web-app': 'nextjs-typescript',
          'api': 'express-typescript',
          'library': 'library-typescript',
          'cli': 'go',
          'tui': 'go',
        };
        const allowedStacks = (stackOptions[INIT_TYPE] || 'node-typescript').split('|');
        const stackAnswer = await select({
          message: 'Stack',
          initialValue: stackDefaults[INIT_TYPE] || allowedStacks[0],
          options: allowedStacks.map((value) => ({ value, label: value })),
        });
        if (isCancel(stackAnswer)) {
          cancel('Init cancelled.');
          return;
        }
        INIT_STACK = stackAnswer;
      }
    }

    if (!INIT_TOOL) {
      const toolAnswer = await select({
        message: 'AI agent tool',
        initialValue: 'opencode',
        options: [
          { value: 'opencode', label: 'OpenCode' },
          { value: 'claude', label: 'Claude Code' },
        ],
      });
      if (isCancel(toolAnswer)) {
        cancel('Init cancelled.');
        return;
      }
      INIT_TOOL = toolAnswer;
    }

    if (!INIT_AUTONOMY) {
      const autonomyAnswer = await select({
        message: 'Default autonomy mode',
        initialValue: 'autonomous',
        options: [
          { value: 'supervised', label: 'Supervised' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'autonomous', label: 'Autonomous' },
        ],
      });
      if (isCancel(autonomyAnswer)) {
        cancel('Init cancelled.');
        return;
      }
      INIT_AUTONOMY = autonomyAnswer;
    }

    if (!INIT_CI) {
      const detectedCI = lib.detectCI(PROJECT_ROOT) || 'none';
      const ciAnswer = await select({
        message: 'CI/CD provider',
        initialValue: ['github-actions', 'gitlab-ci'].includes(detectedCI) ? detectedCI : 'none',
        options: [
          { value: 'github-actions', label: 'GitHub Actions' },
          { value: 'gitlab-ci', label: 'GitLab CI' },
          { value: 'none', label: 'None' },
        ],
      });
      if (isCancel(ciAnswer)) {
        cancel('Init cancelled.');
        return;
      }
      INIT_CI = ciAnswer;
    }

    if (!INIT_TESTING) {
      const detectedTest = lib.detectTestFramework(PROJECT_ROOT);
      if (detectedTest !== 'none') {
        INIT_TESTING = detectedTest;
        logInfo(`Detected test framework: ${INIT_TESTING}`);
      } else {
        const testingAnswer = await select({
          message: 'Test framework',
          initialValue: 'vitest',
          options: [
            { value: 'vitest', label: 'Vitest' },
            { value: 'jest', label: 'Jest' },
            { value: 'go-test', label: 'Go test' },
            { value: 'pytest', label: 'Pytest' },
            { value: 'none', label: 'None' },
          ],
        });
        if (isCancel(testingAnswer)) {
          cancel('Init cancelled.');
          return;
        }
        INIT_TESTING = testingAnswer;
      }
    }
  } else {
    const rl = createRL();

    if (!INIT_NAME) INIT_NAME = await ask(rl, 'Project name:', path.basename(PROJECT_ROOT));
    if (!INIT_TYPE) INIT_TYPE = await ask(rl, 'Project type:', 'api', 'web-app|api|library|cli|tui');
    if (!INIT_WORK_MODE) INIT_WORK_MODE = await ask(rl, 'Work mode:', 'solo', 'solo|team');

    if (INIT_WORK_MODE === 'team' && !INIT_TEAM_SIZE) {
      INIT_TEAM_SIZE = await ask(rl, 'Team size:', '3', '2-5');
    } else if (!INIT_TEAM_SIZE) {
      INIT_TEAM_SIZE = '1';
    }

    if (!INIT_STATE) INIT_STATE = await ask(rl, 'Project state:', 'existing', 'new|existing');

    if (!INIT_STACK) {
      if (INIT_STATE === 'existing') {
        const detected = lib.detectStack(PROJECT_ROOT);
        if (detected !== 'unknown') {
          INIT_STACK = detected;
          logInfo(`Detected stack: ${INIT_STACK}`);
        }
      }
      if (!INIT_STACK) {
        const stackOptions = {
          'web-app': 'nextjs-typescript|express-typescript|node-typescript',
          'api': 'express-typescript|go|python-fastapi|node-typescript',
          'library': 'library-typescript|go|python|rust',
          'cli': 'go|rust|node-typescript|python',
          'tui': 'go|rust|python|node-typescript',
        };
        const stackDefaults = {
          'web-app': 'nextjs-typescript',
          'api': 'express-typescript',
          'library': 'library-typescript',
          'cli': 'go',
          'tui': 'go',
        };
        INIT_STACK = await ask(rl, 'Stack:', stackDefaults[INIT_TYPE] || 'node-typescript', stackOptions[INIT_TYPE] || 'node-typescript');
      }
    }

    if (!INIT_TOOL) INIT_TOOL = await ask(rl, 'AI agent tool:', 'opencode', 'opencode|claude');
    if (!INIT_AUTONOMY) INIT_AUTONOMY = await ask(rl, 'Autonomy mode:', 'autonomous', 'supervised|balanced|autonomous');
    if (!INIT_CI) INIT_CI = await ask(rl, 'CI/CD provider:', lib.detectCI(PROJECT_ROOT), 'github-actions|gitlab-ci|none');

    if (!INIT_TESTING) {
      const detected = lib.detectTestFramework(PROJECT_ROOT);
      if (detected !== 'none') {
        INIT_TESTING = detected;
        logInfo(`Detected test framework: ${INIT_TESTING}`);
      } else {
        INIT_TESTING = await ask(rl, 'Test framework:', 'vitest', 'vitest|jest|go-test|pytest|none');
      }
    }

    rl.close();
  }

  console.log('');
  logInfo('Generating project files...');

  const result = lib.runInit({
    name: INIT_NAME,
    type: INIT_TYPE,
    stack: INIT_STACK,
    tool: INIT_TOOL,
    workMode: INIT_WORK_MODE,
    teamSize: INIT_TEAM_SIZE,
    autonomy: INIT_AUTONOMY,
    testing: INIT_TESTING,
    ci: INIT_CI,
  }, JONGGRANG_HOME, PROJECT_ROOT);

  logSuccess('Generated jonggrang.json');
  logSuccess('Generated AGENTS.md');

  const claudeTemplate = path.join(JONGGRANG_HOME, 'templates', 'CLAUDE.md.template');
  if (lib.fileExists(claudeTemplate)) {
    logSuccess('Generated CLAUDE.md');
  }

  const skillRoot = path.join(JONGGRANG_HOME, 'SKILL.md');
  if (lib.fileExists(skillRoot)) {
    logSuccess('Generated SKILL.md');
  }

  logSuccess('Generated jonggrang-tasks.json');
  logSuccess('Generated progress.txt');
  logSuccess(`Copied ${result.skillCount} skill templates`);

  // ── Install hooks for the selected tool ──────────────────────
  try {
    const toolForHooks = INIT_TOOL || 'opencode';
    const hookResults = hooksLib.installHooksForTool(PROJECT_ROOT, toolForHooks, JONGGRANG_HOME);

    if (hookResults.claude) {
      logSuccess(`Installed Claude Code hooks → ${path.relative(PROJECT_ROOT, hookResults.claude.path)}`);
    }
    if (hookResults.opencode) {
      logSuccess(`Installed OpenCode plugin → ${path.relative(PROJECT_ROOT, hookResults.opencode.path)}`);
    }
  } catch (err) {
    logWarn(`Hook installation warning: ${err.message}`);
  }

  // ── Create .jonggrang/ directory structure ────────────────────
  const jonggrangDirs = [
    path.join(PROJECT_ROOT, '.jonggrang', '.output', 'features'),
    path.join(PROJECT_ROOT, '.jonggrang', '.ephemeral'),
    path.join(PROJECT_ROOT, '.jonggrang', 'locks'),
  ];
  for (const dir of jonggrangDirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  logSuccess('Created .jonggrang/ workspace directory');

  if (!lib.fileExists(path.join(PROJECT_ROOT, '.git'))) {
    // git was already initialized by runInit if needed
  }

  // Update .gitignore to exclude ephemeral files
  const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
  const jonggrangIgnoreBlock = `\n# Jonggrang ephemeral state\n.jonggrang/.ephemeral/\n.jonggrang/locks/\n`;
  try {
    const existing = lib.fileExists(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!existing.includes('.jonggrang/.ephemeral')) {
      fs.appendFileSync(gitignorePath, jonggrangIgnoreBlock);
    }
  } catch {}

  console.log('');
  logSuccess('Project ready!');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Edit AGENTS.md with your project conventions');
  console.log('    2. jonggrang plan "your feature"  OR  jonggrang orchestrate "your feature"');
  console.log('    3. jonggrang work  OR  jonggrang orchestrate --resume');
  console.log('');
}

// ============================================================
// ORCHESTRATE COMMAND — 16-Phase Deterministic Workflow
// ============================================================

async function cmdOrchestrate(descriptionParts) {
  const description = descriptionParts.join(' ').trim();

  checkDeps();

  // ── Check for resume (must come before empty-description guard) ──
  if (ORCHESTRATE_RESUME) {
    const existing = orchestration.findIncompleteManifest(PROJECT_ROOT);
    if (!existing) {
      logError('No incomplete orchestration found to resume.');
      process.exit(1);
    }
    logInfo(`Resuming orchestration: ${existing.manifest.description}`);
    logInfo(`Feature ID: ${existing.featureId}`);
    logInfo(`Current phase: ${existing.manifest.current_phase}`);
    await runOrchestrationLoop(existing.featureId, existing.manifest, existing.manifestPath);
    return;
  }

  if (!description) {
    logError('Usage: jonggrang orchestrate "feature description"');
    logError('       jonggrang orchestrate --resume');
    process.exit(1);
  }

  // ── Compaction check before starting ─────────────────────────
  if (!DRY_RUN) {
    const gate = compaction.checkCompactionGate(PROJECT_ROOT);
    if (gate.status === 'block') {
      logError(`COMPACTION GATE: ${gate.message}`);
      logError('Run /compact before starting a new orchestration.');
      process.exit(1);
    }
    if (gate.status === 'warn' || gate.status === 'must') {
      logWarn(gate.message);
    }
  }

  // ── Classify work type ────────────────────────────────────────
  const workType = orchestration.classifyWorkType(description);
  const activePhases = orchestration.getActivePhases(workType);

  logHeader(`Orchestrating: ${description}`);
  logInfo(`Work type: ${workType}`);
  logInfo(`Active phases: ${activePhases.join(', ')}`);
  console.log('');

  // ── Create MANIFEST ───────────────────────────────────────────
  const featureId = orchestration.generateFeatureId(description);
  const { manifest, manifestPath } = orchestration.createManifest(
    PROJECT_ROOT, featureId, description, workType
  );

  logInfo(`Feature ID: ${featureId}`);
  logInfo(`MANIFEST: ${manifestPath}`);
  console.log('');

  // ── Run orchestration loop ────────────────────────────────────
  await runOrchestrationLoop(featureId, manifest, manifestPath);
}

async function runOrchestrationLoop(featureId, manifest, manifestPath) {
  const activeTool = TOOL || lib.readConfig(CONFIG_FILE, '.tool', 'opencode');
  const activeMode = MODE || lib.readConfig(CONFIG_FILE, '.mode.autonomy', 'autonomous');

  for (const phaseNum of manifest.active_phases) {
    const phaseState = manifest.phases[phaseNum];
    if (!phaseState || phaseState.status === 'completed' || phaseState.status === 'skipped') {
      continue;
    }

    const phaseDef = orchestration.PHASES[phaseNum];
    logInfo(`\n── Phase ${phaseNum}: ${phaseDef.name} ──`);
    logInfo(phaseDef.description);

    // ── Compaction gate before heavy phases ─────────────────────
    if (orchestration.HEAVY_PHASES.has(phaseNum) && !DRY_RUN) {
      compaction.refreshCompactionState(PROJECT_ROOT);
      const gate = compaction.checkCompactionGate(PROJECT_ROOT);
      if (gate.status === 'block') {
        logError(`COMPACTION GATE blocked phase ${phaseNum}: ${gate.message}`);
        logError('Run /compact then resume with: jonggrang orchestrate --resume');
        orchestration.failPhase(manifestPath, phaseNum, gate.message);
        process.exit(1);
      }
      if (gate.status !== 'ok') logWarn(gate.message);
    }

    orchestration.startPhase(manifestPath, phaseNum);

    // ── Phase-specific logic ─────────────────────────────────────
    if (phaseNum === 1) {
      // Setup — already done (manifest created)
      logSuccess('Setup complete (MANIFEST created)');
      orchestration.completePhase(manifestPath, phaseNum, { manifest_path: manifestPath });
      manifest = orchestration.readManifest(manifestPath);
      continue;
    }

    if (phaseNum === 2) {
      // Triage — already classified
      logSuccess(`Triage: ${manifest.work_type}, active phases: ${manifest.active_phases.join(', ')}`);
      orchestration.completePhase(manifestPath, phaseNum, { work_type: manifest.work_type });
      manifest = orchestration.readManifest(manifestPath);
      continue;
    }

    if (phaseNum === 6 && activeMode !== 'autonomous') {
      // Brainstorming — pause for human input in non-autonomous modes
      logInfo('\n[BRAINSTORMING PHASE — Human Input Required]');
      logInfo(`Feature: ${manifest.description}`);
      logInfo('Review the architecture plan and provide design direction before continuing.');
      logInfo('Resume with: jonggrang orchestrate --resume');
      orchestration.failPhase(manifestPath, phaseNum, 'Awaiting human input (brainstorming)');
      process.exit(0);
    }

    // ── Build phase prompt ────────────────────────────────────────
    const phaseContext = orchestration.buildPhaseContext(manifest, phaseNum);
    const agentsContent = lib.fileExists(paths.agentsFile)
      ? fs.readFileSync(paths.agentsFile, 'utf8') : '';
    const progressContent = lib.fileExists(paths.progressFile)
      ? fs.readFileSync(paths.progressFile, 'utf8').slice(-2000) : '';

    const outputDir = path.join(PROJECT_ROOT, '.jonggrang', '.output', 'features', featureId);
    fs.mkdirSync(outputDir, { recursive: true });

    const prompt = [
      phaseContext,
      agentsContent ? `\n## Project Conventions (AGENTS.md)\n${agentsContent}` : '',
      progressContent ? `\n## Recent Learnings (progress.txt)\n${progressContent}` : '',
      `\n## Output Directory\nWrite all output files to: ${outputDir}/`,
    ].filter(Boolean).join('\n');

    if (DRY_RUN) {
      logInfo(`[DRY RUN] Phase ${phaseNum} prompt (${prompt.length} chars)`);
      orchestration.completePhase(manifestPath, phaseNum, { dry_run: true });
      manifest = orchestration.readManifest(manifestPath);
      continue;
    }

    // ── Run agent ─────────────────────────────────────────────────
    const exitCode = await lib.runAgent(prompt, activeTool, activeMode, PROJECT_ROOT);

    if (exitCode !== 0) {
      logWarn(`Phase ${phaseNum} agent exited with code ${exitCode}`);
      orchestration.failPhase(manifestPath, phaseNum, `Agent exit code: ${exitCode}`);
    } else {
      orchestration.completePhase(manifestPath, phaseNum);
      logSuccess(`Phase ${phaseNum} complete`);
    }

    manifest = orchestration.readManifest(manifestPath);

    // Check if orchestration was failed/paused externally
    if (manifest.status === 'failed' || manifest.status === 'paused') {
      logWarn(`Orchestration ${manifest.status}. Resume with: jonggrang orchestrate --resume`);
      process.exit(exitCode !== 0 ? 1 : 0);
    }
  }

  if (manifest.status === 'completed') {
    logHeader('Orchestration Complete!');
    logSuccess(`Feature: ${manifest.description}`);
    logSuccess(`All ${manifest.active_phases.length} phases completed.`);
    feedback.clearFeedbackState(PROJECT_ROOT);
  }
}

// ============================================================
// WEB DASHBOARD
// ============================================================

function cmdWeb() {
  const WEB_DIR = path.resolve(__dirname, '..');
  const serverFile = path.join(WEB_DIR, 'server.js');

  if (!lib.fileExists(serverFile)) {
    logError(`server.js not found at ${WEB_DIR}`);
    process.exit(1);
  }

  // Check if node_modules exists in web dir
  if (!lib.fileExists(path.join(WEB_DIR, 'node_modules'))) {
    logInfo('Installing web dependencies...');
    execSync('npm install', { cwd: WEB_DIR, stdio: 'inherit' });
  }

  // Check if client build exists
  const distPath = path.join(WEB_DIR, 'client', 'dist', 'index.html');
  if (!lib.fileExists(distPath)) {
    logInfo('Building frontend...');
    execSync('npm run build', { cwd: WEB_DIR, stdio: 'inherit' });
  }

  logHeader('JONGGRANG Web Dashboard');
  logInfo(`Starting dashboard on port ${WEB_PORT}...`);
  logInfo(`Project root: ${PROJECT_ROOT}`);
  console.log('');

  const child = spawn('node', [serverFile], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      JONGGRANG_HOME: JONGGRANG_HOME,
      JONGGRANG_PROJECT_ROOT: PROJECT_ROOT,
      PORT: String(WEB_PORT),
    },
    stdio: 'inherit',
  });

  // Open browser after short delay
  if (WEB_OPEN) {
    setTimeout(() => {
      const url = `http://localhost:${WEB_PORT}`;
      logSuccess(`Dashboard ready at ${url}`);
      try {
        const openCmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open';
        spawn(openCmd, [url], { stdio: 'ignore', detached: true }).unref();
      } catch { /* ignore if browser fails to open */ }
    }, 1000);
  }

  // Forward signals to child
  const cleanup = (signal) => {
    child.kill(signal);
    process.exit(0);
  };
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  child.on('close', (code) => {
    process.exit(code || 0);
  });
}

// ============================================================
// INTERACTIVE MENU
// ============================================================

async function cmdMenu() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    cmdHelp();
    return;
  }

  intro('Jonggrang Interactive CLI');

  let running = true;
  let outroShown = false;

  while (running) {
    const choice = await select({
      message: 'What do you want to do?',
      initialValue: 'init',
      options: [
        { value: 'init', label: 'Initialize project' },
        { value: 'plan', label: 'Plan feature' },
        { value: 'work', label: 'Start work loop' },
        { value: 'status', label: 'Show status board' },
        { value: 'review', label: 'Run review' },
        { value: 'web', label: 'Launch web dashboard' },
        { value: 'exit', label: 'Exit menu' },
      ],
    });

    if (isCancel(choice)) {
      cancel('Exited menu.');
      outroShown = true;
      break;
    }

    let skipContinuePrompt = false;

    try {
      switch (choice) {
        case 'init':
          await cmdInit();
          break;
        case 'plan': {
          const description = await text({
            message: 'Feature description',
            validate(value) {
              if (!value || !value.trim()) return 'Description is required.';
            },
          });
          if (isCancel(description)) {
            logWarn('Plan cancelled.');
            continue;
          }

          const update = await confirm({
            message: 'Update existing plan?',
            initialValue: false,
          });
          if (isCancel(update)) {
            logWarn('Plan cancelled.');
            continue;
          }

          checkDeps();
          {
            const args = update ? ['--update', description.trim()] : [description.trim()];
            await cmdPlan(args);
          }
          break;
        }
        case 'work':
          checkDeps();
          await cmdWork();
          break;
        case 'status':
          cmdStatus();
          break;
        case 'review':
          checkDeps();
          await cmdReview();
          break;
        case 'web': {
          const portAnswer = await text({
            message: `Dashboard port (current: ${WEB_PORT})`,
            initialValue: String(WEB_PORT),
            validate(value) {
              if (!value || !value.trim()) return undefined;
              return /^\d+$/.test(value.trim()) ? undefined : 'Port must be numeric.';
            },
          });
          if (isCancel(portAnswer)) {
            logWarn('Dashboard launch cancelled.');
            continue;
          }

          const autoOpen = await confirm({
            message: 'Open browser automatically?',
            initialValue: WEB_OPEN,
          });
          if (isCancel(autoOpen)) {
            logWarn('Dashboard launch cancelled.');
            continue;
          }

          const prevPort = WEB_PORT;
          const prevOpen = WEB_OPEN;
          if (portAnswer.trim()) {
            const parsed = parseInt(portAnswer.trim(), 10);
            if (!Number.isNaN(parsed)) WEB_PORT = parsed;
          }
          WEB_OPEN = !!autoOpen;
          cmdWeb();
          WEB_PORT = prevPort;
          WEB_OPEN = prevOpen;
          break;
        }
        case 'exit':
          running = false;
          outro('Thanks for using Jonggrang!');
          skipContinuePrompt = true;
          outroShown = true;
          break;
        default:
          logWarn('Unknown option. Showing help instead.');
          cmdHelp();
          running = false;
          skipContinuePrompt = true;
          outroShown = true;
      }
    } catch (err) {
      logError((err && err.message) || String(err));
    }

    if (!running) break;

    if (!skipContinuePrompt) {
      const again = await confirm({
        message: 'Run another command?',
        initialValue: false,
      });

      if (isCancel(again)) {
        cancel('Exited menu.');
        outroShown = true;
        break;
      }

      if (!again) {
        running = false;
        outro('All set. Happy building!');
        outroShown = true;
      }
    }
  }

  if (!outroShown) {
    outro('All set. Happy building!');
  }
}

// ============================================================
// HELP
// ============================================================

function cmdHelp() {
  console.log(`Jonggrang — AI Development Workflow Orchestrator (Node.js)

Usage: jonggrang <command> [options]

Commands:
  menu                    Interactive menu launcher
  init                    Setup project (interactive or with flags)
  work                    Start work loop
  orchestrate <desc>      Full 16-phase deterministic orchestration
  orchestrate --resume    Resume an incomplete orchestration
  review                  Run code review
  status                  Show task board
  plan <description>      Decompose feature into tasks
  plan --update <desc>    Update existing plan (preserves completed tasks)
  web                     Start web dashboard
  version                 Show version

Init options (bypass wizard):
  --name <name>           Project name
  --type <type>           web-app | api | library | cli | tui
  --work-mode <mode>      solo | team
  --team-size <n>         Team size 2-5 (if team)
  --state <state>         new | existing
  --stack <stack>         nextjs-typescript | express-typescript | go | python-fastapi | library-typescript
  --tool <tool>           opencode | claude (default: opencode)
  --autonomy <mode>       supervised | balanced | autonomous
  --ci <provider>         github-actions | gitlab-ci | none
  --testing <framework>   vitest | jest | go-test | pytest | none
  --force                 Overwrite existing jonggrang.json

Work options:
  --mode <mode>           supervised | balanced | autonomous
  --tool <tool>           Override AI tool for this session
  --task <task-id>        Work on specific task
  --max-iterations <n>    Max iterations (default: unlimited)
  --branch <name>         Feature branch name
  --dry-run               Plan only, no execution

Web options:
  --port <port>           Dashboard port (default: 7777-7999 auto)
  --no-open               Don't auto-open browser

Examples:
  jonggrang init
  jonggrang init --name my-app --type api --tool opencode --autonomy balanced --force
  jonggrang plan "user authentication with JWT"
  jonggrang work
  jonggrang work --tool claude --mode autonomous
  jonggrang work --max-iterations 5
  jonggrang orchestrate "user authentication with JWT"
  jonggrang orchestrate --resume
  jonggrang status
  jonggrang review
  jonggrang web
  jonggrang web --port 8080`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const isInteractiveShell = process.stdin.isTTY && process.stdout.isTTY;
  const providedCommand = args[0];
  const command = providedCommand || (isInteractiveShell ? 'menu' : 'help');
  let rest = providedCommand ? args.slice(1) : [];
  const planArgs = [];

  // Parse global options
  let i = 0;
  while (i < rest.length) {
    switch (rest[i]) {
      case '--mode':          MODE = rest[++i]; break;
      case '--task':          TASK_ID = rest[++i]; break;
      case '--max-iterations': MAX_ITERATIONS = parseInt(rest[++i], 10); break;
      case '--branch':        BRANCH = rest[++i]; break;
      case '--tool':          TOOL = rest[++i]; INIT_TOOL = rest[i]; TOOL_SET = true; break;
      case '--verbose':       VERBOSE = true; break;
      case '--dry-run':       DRY_RUN = true; break;
      case '--worktree':     WORKTREE_MODE = true; break;
      case '--group-tasks':  GROUP_TASK_IDS = rest[++i].split(','); break;
      case '--name':          INIT_NAME = rest[++i]; break;
      case '--type':          INIT_TYPE = rest[++i]; break;
      case '--work-mode':     INIT_WORK_MODE = rest[++i]; break;
      case '--team-size':     INIT_TEAM_SIZE = rest[++i]; break;
      case '--state':         INIT_STATE = rest[++i]; break;
      case '--stack':         INIT_STACK = rest[++i]; break;
      case '--autonomy':      INIT_AUTONOMY = rest[++i]; break;
      case '--ci':            INIT_CI = rest[++i]; break;
      case '--testing':       INIT_TESTING = rest[++i]; break;
      case '--force':         INIT_FORCE = true; break;
      case '--port':          WEB_PORT = parseInt(rest[++i], 10); break;
      case '--no-open':       WEB_OPEN = false; break;
      case '--resume':        ORCHESTRATE_RESUME = true; break;
      case '--role':          ORCHESTRATE_ROLE = rest[++i]; break;
      default:                planArgs.push(rest[i]); break;
    }
    i++;
  }

  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'work':
      checkDeps();
      await cmdWork();
      break;
    case 'review':
      checkDeps();
      await cmdReview();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'plan':
      checkDeps();
      await cmdPlan(planArgs);
      break;
    case 'orchestrate':
      await cmdOrchestrate(planArgs);
      break;
    case 'web':
    case 'dashboard':
      cmdWeb();
      break;
    case 'menu':
    case 'interactive':
      await cmdMenu();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(`jonggrang ${JONGGRANG_VERSION}`);
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    default:
      logError(`Unknown command: ${command}`);
      console.log("Run 'jonggrang help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
