#!/usr/bin/env node
//
// JONGGRANG — AI Development Workflow Orchestrator (Node.js CLI)
// Node.js CLI implementation
//

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const readline = require('readline');

const lib = require('../lib/jonggrang');

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
let WEB_PORT = parseInt(process.env.JONGGRANG_WEB_PORT || '3001', 10);
let WEB_OPEN = true;

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

async function runIteration(iteration, taskId) {
  const task = lib.getTask(TASKS_FILE, taskId);
  const taskTitle = task ? task.title : taskId;

  logHeader(`Iteration ${iteration}: ${taskTitle}`);
  lib.updateTaskStatus(TASKS_FILE, taskId, 'in_progress');

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
      return true;
    } else {
      logWarn('Agent finished but did not mark task complete. Reverting to pending.');
      lib.updateTaskStatus(TASKS_FILE, taskId, 'pending');
      return false;
    }
  } else {
    logWarn(`Agent exited with error (code: ${exitCode}). Reverting task to pending.`);
    lib.updateTaskStatus(TASKS_FILE, taskId, 'pending');
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

  logHeader('JONGGRANG Work Loop');
  logInfo(`Tool: ${TOOL}`);
  logInfo(`Mode: ${MODE}`);
  logInfo(MAX_ITERATIONS === 0 ? 'Max iterations: unlimited' : `Max iterations: ${MAX_ITERATIONS}`);
  logInfo(`Tasks: ${lib.countPending(TASKS_FILE)} pending / ${lib.countTotal(TASKS_FILE)} total`);

  if (BRANCH) {
    logInfo(`Branch: ${BRANCH}`);
    try {
      execSync(`git checkout -b ${BRANCH}`, { cwd: PROJECT_ROOT, stdio: 'ignore' });
    } catch {
      execSync(`git checkout ${BRANCH}`, { cwd: PROJECT_ROOT, stdio: 'ignore' });
    }
  }

  let iteration = 0;
  let consecutiveFails = 0;
  let lastFailedTask = '';
  const killAfter = parseInt(lib.readConfig(CONFIG_FILE, 'work.kill_after_fails', '3'), 10);

  while (MAX_ITERATIONS === 0 || iteration < MAX_ITERATIONS) {
    iteration++;

    let taskId;
    if (TASK_ID) {
      taskId = TASK_ID;
      TASK_ID = '';
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
        lib.updateTaskStatus(TASKS_FILE, taskId, 'blocked');
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

  logHeader('JONGGRANG Plan');
  logInfo(`Feature: ${description}`);
  logInfo(`Tool: ${TOOL}`);
  if (updateMode) logInfo('Mode: UPDATE (preserving completed tasks)');

  const planPrompt = lib.buildPlanPrompt(description, updateMode, TASKS_FILE, SKILLS_DIR);

  await lib.runAgent(planPrompt, TOOL, 'autonomous', PROJECT_ROOT);

  console.log('');
  logSuccess('Plan complete. Review the tasks:');
  console.log('');
  cmdStatus();
}

// ============================================================
// INIT
// ============================================================

async function cmdInit() {
  logHeader('JONGGRANG — Project Setup');

  if (lib.fileExists(CONFIG_FILE) && !INIT_FORCE) {
    if (process.stdin.isTTY) {
      const rl = createRL();
      logWarn('jonggrang.json already exists. Overwrite? [y/N]');
      const answer = await new Promise(r => rl.question('', r));
      rl.close();
      if (answer !== 'y' && answer !== 'Y') {
        logInfo('Aborted.');
        return;
      }
    } else {
      logError('jonggrang.json already exists. Use --force to overwrite.');
      process.exit(1);
    }
  }

  console.log('');

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

  if (!lib.fileExists(path.join(PROJECT_ROOT, '.git'))) {
    // git was already initialized by runInit if needed
  }

  console.log('');
  logSuccess('Project ready!');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Edit AGENTS.md with your project conventions');
  console.log('    2. Run: jonggrang plan "your feature description"');
  console.log('    3. Run: jonggrang work');
  console.log('');
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
// HELP
// ============================================================

function cmdHelp() {
  console.log(`Jonggrang — AI Development Workflow Orchestrator (Node.js)

Usage: jonggrang <command> [options]

Commands:
  init                    Setup project (interactive or with flags)
  work                    Start work loop
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
  --port <port>           Dashboard port (default: 3001)
  --no-open               Don't auto-open browser

Examples:
  jonggrang init
  jonggrang init --name my-app --type api --tool opencode --autonomy balanced --force
  jonggrang plan "user authentication with JWT"
  jonggrang work
  jonggrang work --tool claude --mode autonomous
  jonggrang work --max-iterations 5
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
  const command = args[0] || 'help';
  let rest = args.slice(1);
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
    case 'web':
    case 'dashboard':
      cmdWeb();
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
