#!/usr/bin/env node
//
// JONGGRANG — AI Development Workflow Orchestrator (Node.js CLI)
// Node.js CLI implementation
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');
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
const CONFIG_FILE   = process.env.JONGGRANG_CONFIG || paths.configFile;
const TASKS_FILE    = paths.tasksFile;
const PLAN_FILE     = paths.planFile;
const PROGRESS_FILE = paths.progressFile;
const AGENTS_FILE   = paths.agentsFile;
const SKILLS_DIR    = paths.skillsDir;

const JONGGRANG_VERSION = require('../package.json').version;

const DEFAULT_TOOL = 'jonggrang';

// Defaults (can be overridden by flags/env)
let MAX_ITERATIONS = parseInt(process.env.JONGGRANG_MAX_ITERATIONS || '0', 10);
let MODE = process.env.JONGGRANG_MODE || 'autonomous';
let TOOL = process.env.JONGGRANG_TOOL || DEFAULT_TOOL;
let TOOL_SET = false;
let TASK_ID = '';
let BRANCH = '';
let VERBOSE = process.env.JONGGRANG_VERBOSE === 'true';
let DRY_RUN = process.env.JONGGRANG_DRY_RUN === 'false';
let DEBUG   = process.env.JONGGRANG_DEBUG === 'true';
let WEB_PORT = parseInt(process.env.JONGGRANG_WEB_PORT || '7777', 10);
let WEB_HOST = process.env.JONGGRANG_WEB_HOST || '127.0.0.1';
let WORKTREE_MODE = false;
let GROUP_TASK_IDS = [];
let ORCHESTRATE_RESUME = false;
let ORCHESTRATE_ROLE = '';
let SKIP_GATES = false;
let MODEL = process.env.JONGGRANG_MODEL || '';
let EFFORT = process.env.JONGGRANG_EFFORT || '';

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
const DIM = '\x1b[2m';

// ============================================================
// LOGGING HELPERS
// ============================================================

function logInfo(msg) { console.log(`${BLUE}[jonggrang]${NC} ${msg}`); }
function logSuccess(msg) { console.log(`${GREEN}[jonggrang]${NC} ${msg}`); }
function logWarn(msg) { console.log(`${YELLOW}[jonggrang]${NC} ${msg}`); }
function logError(msg) { console.error(`${RED}[jonggrang]${NC} ${msg}`); }

function gitRevParse(cwd) {
  try { return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim(); } catch { return null; }
}
function logHeader(msg) {
  console.log('');
  console.log(`${BOLD}${CYAN}==============================${NC}`);
  console.log(`${BOLD}${CYAN}  ${msg}${NC}`);
  console.log(`${BOLD}${CYAN}==============================${NC}`);
  console.log('');
}

// ASCII banner for `jonggrang web` — "JONGGRANG" (navy) over ".DEV" (gold)
// figlet-style wordmark with a gold left-bar info panel.
function printWebBanner(host, port) {
  const NAVY = '\x1b[38;5;25m';
  const GOLD = '\x1b[38;5;179m';
  const url = `http://${host}:${port}`;
  const dev = process.env.NODE_ENV === 'development';
  const mode = dev ? 'development · vite middleware (HMR)' : 'production · static client/dist';

  const top = [
    "     _   ___   _   _   ____   ____  ____      _     _   _   ____ ",
    "    | | / _ \\ | \\ | | / ___| / ___||  _ \\    / \\   | \\ | | / ___|",
    " _  | || | | ||  \\| || |  _ | |  _ | |_) |  / _ \\  |  \\| || |  _ ",
    "| |_| || |_| || |\\  || |_| || |_| ||  _ <  / ___ \\ | |\\  || |_| |",
    " \\___/  \\___/ |_| \\_| \\____| \\____||_| \\_\\/_/   \\_\\|_| \\_| \\____|",
  ];
  const bot = [
    "                                           ____   _____ __     __",
    "                                          |  _ \\ | ____|\\ \\   / /",
    "                                          | | | ||  _|   \\ \\ / / ",
    "                                        _ | |_| || |___   \\ V /  ",
    "                                       (_)|____/ |_____|   \\_/   ",
  ];

  console.log('');
  for (const line of top) console.log(`${NAVY}${line}${NC}`);
  for (const line of bot) console.log(`${GOLD}${line}${NC}`);
  console.log('');
  console.log(`  ${GOLD}▌${NC} ${BOLD}${CYAN}Web Dashboard${NC}`);
  console.log(`  ${GOLD}▌${NC} ${GOLD}➜${NC}  ${BOLD}${url}${NC}`);
  console.log(`  ${GOLD}▌${NC} ${DIM}mode${NC}  ${mode}`);
  console.log(`  ${GOLD}▌${NC} ${DIM}stop${NC}  Ctrl+C`);
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
  // Tool-specific checks: opencode & claude need a CLI binary; jonggrang needs the Pi SDK
  if (TOOL === 'jonggrang') {
    let found = false;
    try {
      const { createRequire } = require('module');
      const req     = createRequire(path.join(PROJECT_ROOT, 'package.json'));
      const reqSelf = createRequire(__filename);
      const searchPaths = [
        ...(req.resolve.paths('@earendil-works/pi-coding-agent') || []),
        ...(reqSelf.resolve.paths('@earendil-works/pi-coding-agent') || []),
      ];
      // Also check the global npm root (handles nvm paths like ~/.nvm/versions/node/vX.Y.Z/lib/node_modules)
      try {
        const globalRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 3000 }).trim();
        if (globalRoot) searchPaths.push(globalRoot);
      } catch {}
      for (const p of searchPaths) {
        if (lib.fileExists(path.join(p, '@earendil-works', 'pi-coding-agent', 'package.json'))) {
          found = true;
          break;
        }
      }
    } catch { /* ignore — fall through to not found */ }
    if (!found) missing.push('@earendil-works/pi-coding-agent');
  } else {
    if (!commandExists(TOOL)) missing.push(TOOL);
  }

  if (missing.length > 0) {
    logError(`Missing dependencies: ${missing.join(', ')}`);
    console.log('');
    for (const cmd of missing) {
      switch (cmd) {
        case 'jq':       console.log('  Install jq:       brew install jq'); break;
        case 'git':      console.log('  Install git:      brew install git'); break;
        case 'opencode':  console.log('  Install opencode:  curl -fsSL https://opencode.ai/install | bash'); break;
        case 'claude':    console.log('  Install claude:    npm install -g @anthropic-ai/claude-code'); break;
        case 'codex':     console.log('  Install codex:     npm install -g @openai/codex'); break;
        case '@earendil-works/pi-coding-agent': console.log('  Install Pi SDK:  npm install -g @earendil-works/pi-coding-agent'); break;
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
// MODEL / EFFORT RESOLUTION
// ============================================================

/**
 * Resolve MODEL and EFFORT following the priority order:
 *   1. CLI flag (--model / --effort) — already set in MODULE globals
 *   2. Env var (JONGGRANG_MODEL / JONGGRANG_EFFORT) — already set in MODULE globals
 *   3. Config file: tools.<tool>.model/effort → model/effort (top-level)
 *   4. Backend default — leave empty so no flag is added to the spawn command
 *
 * Must be called after TOOL is resolved from config in each command.
 */
function resolveModelAndEffort() {
  if (!MODEL) {
    const toolModel = lib.readConfig(CONFIG_FILE, `tools.${TOOL}.model`, '');
    MODEL = toolModel || lib.readConfig(CONFIG_FILE, 'model', '');
  }
  if (!EFFORT) {
    const toolEffort = lib.readConfig(CONFIG_FILE, `tools.${TOOL}.effort`, '');
    EFFORT = toolEffort || lib.readConfig(CONFIG_FILE, 'effort', '');
  }
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

const TEST_RETRY_LIMIT = 3;

function askUserFeedback(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function runIteration(iteration, taskId) {
  const task = lib.getTask(TASKS_FILE, taskId);
  const taskTitle = task ? task.title : taskId;

  logHeader(`Iteration ${iteration}: ${taskTitle}`);

  updateTaskMode(taskId, 'in_progress');
  // Brief pause so the file-watcher fires before the agent starts,
  // ensuring the browser sees the in_progress state transition.
  await new Promise(r => setTimeout(r, 200));

  if (DRY_RUN) {
    logWarn(`[DRY RUN] Would execute prompt for task: ${taskId}`);
    console.log(lib.buildWorkPrompt(taskId, TASKS_FILE, MODE));
    return true;
  }

  const testCmd = lib.readConfig(CONFIG_FILE, 'testing.command', '');
  let testFeedback = '';    // injected into prompt on retry
  let testAttempt = 0;

  while (true) {
    // Build prompt — inject test failure feedback on retries
    const prompt = lib.buildWorkPrompt(taskId, TASKS_FILE, MODE, testFeedback || undefined);

    logInfo(`Spawning fresh ${TOOL} instance...${testAttempt > 0 ? ` (test retry ${testAttempt}/${TEST_RETRY_LIMIT})` : ''}`);
    const exitCode = await lib.runAgent(prompt, TOOL, MODE, PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });

    if (exitCode !== 0) {
      logWarn(`Agent exited with error (code: ${exitCode}). Reverting task to pending.`);
      updateTaskMode(taskId, 'pending');
      return false;
    }

    // ── Check task completion ─────────────────────────────────
    const data = lib.getTasks(TASKS_FILE);
    const t = data.tasks.find(t => t.id === taskId);
    if (!t || t.status !== 'completed') {
      logWarn('Agent finished but did not mark task complete. Reverting to pending.');
      updateTaskMode(taskId, 'pending');
      return false;
    }

    // ── Run tests ─────────────────────────────────────────────
    if (!testCmd) {
      logSuccess(`Task ${taskId} completed successfully`);
      updateTaskMode(taskId, 'completed');
      return true;
    }

    logInfo('Running tests...');
    const { passed, output } = lib.runTestCommand(testCmd, PROJECT_ROOT);

    if (passed) {
      logSuccess(`Task ${taskId} completed — tests passed`);
      updateTaskMode(taskId, 'completed');
      return true;
    }

    testAttempt++;
    logWarn(`Tests failed (attempt ${testAttempt}/${TEST_RETRY_LIMIT})`);

    if (testAttempt < TEST_RETRY_LIMIT) {
      // Auto-retry: inject test output as feedback, reset task to pending
      testFeedback = output;
      lib.updateTaskStatus(TASKS_FILE, taskId, 'pending');
      logInfo('Retrying with test failure output...');
      continue;
    }

    // ── Max retries hit — ask user ────────────────────────────
    logError(`Tests still failing after ${TEST_RETRY_LIMIT} attempts.`);
    console.log('\n--- Test output ---\n' + output + '\n---\n');
    const userInput = await askUserFeedback(
      'Provide feedback for the agent (or press Enter to mark task blocked): '
    );

    if (!userInput) {
      logError(`Task ${taskId} marked as blocked after ${TEST_RETRY_LIMIT} failed test retries.`);
      updateTaskMode(taskId, 'blocked');
      return false;
    }

    // User gave feedback — inject it and reset counter for another round
    testFeedback = `User feedback: ${userInput}\n\nLast test output:\n${output}`;
    testAttempt = 0;
    lib.updateTaskStatus(TASKS_FILE, taskId, 'pending');
    logInfo('Retrying with user feedback...');
  }
}

// ============================================================
// WORK TYPE RESOLUTION
// ============================================================

function resolveWorkType(description) {
  // 1. Active MANIFEST takes priority
  const existing = orchestration.findIncompleteManifest(PROJECT_ROOT);
  if (existing) return existing.manifest.work_type;

  // 2. Classify from description if given
  if (description) return orchestration.classifyWorkType(description);

  // 3. Infer from total task count (task titles are too noisy for text classification)
  const data = lib.getTasks(TASKS_FILE);
  if (!data.tasks || data.tasks.length === 0) return 'SMALL';
  const total = data.tasks.length;
  if (total >= 6) return 'LARGE';
  if (total >= 3) return 'MEDIUM';
  return 'SMALL';
}

// ============================================================
// POST-WORK QUALITY GATES
// ============================================================

async function runPostWorkPhases(description, workType, featureId, manifest, manifestPath) {
  if (workType === 'BUGFIX') {
    logInfo(`Work type: BUGFIX — no quality gates needed`);
    // Mark all remaining active phases as skipped so the phase grid shows complete
    if (manifestPath && manifest) {
      try {
        const current = orchestration.readManifest(manifestPath);
        if (current) {
          const remaining = current.active_phases.filter(n => {
            const s = current.phases[n]?.status;
            return !s || (s !== 'completed' && s !== 'skipped');
          });
          for (const n of remaining) {
            if (current.phases[n]) current.phases[n].status = 'skipped';
          }
          current.status = 'completed';
          current.current_phase = null;
          current.updated_at = new Date().toISOString();
          orchestration.writeManifest(manifestPath, current);
        }
      } catch { /* ignore */ }
    }
    return;
  }

  logHeader(`Quality Gates (${workType})`);

  // Use the manifest already created by cmdWork, or find/create one as fallback
  if (!featureId || !manifest || !manifestPath) {
    const existing = orchestration.findIncompleteManifest(PROJECT_ROOT);
    if (existing) {
      featureId    = existing.featureId;
      manifest     = existing.manifest;
      manifestPath = existing.manifestPath;
      logInfo(`Resuming MANIFEST: ${featureId}`);
    } else {
      featureId = orchestration.generateFeatureId(description || 'work-session');
      const created = orchestration.createManifest(PROJECT_ROOT, featureId, description || 'work session', workType);
      manifest     = created.manifest;
      manifestPath = created.manifestPath;
      logInfo(`Created MANIFEST: ${featureId}`);
      // Mark phases 1-8 as already done (work loop covered them)
      [1, 2, 3, 4, 5, 6, 7, 8].forEach(n => {
        if (manifest.active_phases.includes(n))
          orchestration.completePhase(manifestPath, n, { source: 'work-loop' });
      });
      manifest = orchestration.readManifest(manifestPath);
    }
  }

  logInfo(`Running phases: ${manifest.active_phases.filter(n => n >= 9).join(', ')}`);
  console.log('');

  await runOrchestrationLoop(featureId, manifest, manifestPath);
}

// ============================================================
// WORK LOOP
// ============================================================

async function cmdWork(descriptionParts = []) {
  // --resume: skip work loop, go straight to orchestration resume
  if (ORCHESTRATE_RESUME) {
    if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
      TOOL = lib.readConfig(CONFIG_FILE, 'tool', DEFAULT_TOOL);
    }
    resolveModelAndEffort();
    if (MODE === 'autonomous') {
      MODE = lib.readConfig(CONFIG_FILE, 'mode.autonomy', 'autonomous');
    }
    const existing = orchestration.findIncompleteManifest(PROJECT_ROOT);
    if (!existing) {
      logError('No incomplete orchestration found to resume.');
      process.exit(1);
    }
    logInfo(`Resuming: ${existing.manifest.description}`);
    logInfo(`Feature ID: ${existing.featureId}`);
    logInfo(`Current phase: ${existing.manifest.current_phase}`);
    await runOrchestrationLoop(existing.featureId, existing.manifest, existing.manifestPath);
    return;
  }

  // If a description was passed, go through plan → approve → execute
  const autoApprove = descriptionParts.includes('--yes') || descriptionParts.includes('-y');
  const deepMode    = descriptionParts.includes('--deep');
  const description = descriptionParts.filter(a => !a.startsWith('-')).join(' ').trim();

  if (description) {
    logInfo(`One-shot mode: plan + execute "${description}"`);
    const planArgs = [description];
    if (autoApprove) planArgs.push('--yes');
    if (deepMode)    planArgs.push('--deep');
    await cmdPlan(planArgs, { fromWork: true });
    // Continue only if tasks were actually created (user approved or --yes)
    if (lib.fileExists(PLAN_FILE)) {
      // plan.md still exists → user chose "save draft" or "abort"
      logWarn('Plan not approved — nothing to execute. Run "jonggrang approve" then "jonggrang work".');
      return;
    }
    if (!lib.fileExists(TASKS_FILE) || lib.countPending(TASKS_FILE) === 0) {
      logWarn('No pending tasks to execute.');
      return;
    }
    console.log('');
  } else if (lib.fileExists(PLAN_FILE) && !descriptionParts.includes('--ignore-plan')) {
    // No description given but there is an unapproved plan — warn and stop
    logWarn('There is a pending plan at .jonggrang/plan.md that has not been approved yet.');
    logInfo('Run "jonggrang approve" to decompose it into tasks, then "jonggrang work".');
    logInfo('Or run "jonggrang work --ignore-plan" to skip the plan and run existing tasks.');
    process.exit(1);
  }

  safeCheckConfig();

  if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
    TOOL = lib.readConfig(CONFIG_FILE, 'tool', DEFAULT_TOOL);
  }
  resolveModelAndEffort();
  if (MODE === 'autonomous') {
    MODE = lib.readConfig(CONFIG_FILE, 'mode.autonomy', 'autonomous');
  }

  const configMax = parseInt(lib.readConfig(CONFIG_FILE, 'work.max_iterations', '0'), 10);
  if (MAX_ITERATIONS === 0) MAX_ITERATIONS = configMax;

  // In worktree mode or with explicit group tasks, don't limit — run until all tasks done
  if (WORKTREE_MODE || GROUP_TASK_IDS.length > 0) MAX_ITERATIONS = 0;

  const workType = resolveWorkType(description);

  // Create / resume manifest at start of work so phase grid updates in real-time
  let workFeatureId = null, workManifest = null, workManifestPath = null;
  if (WORKTREE_MODE && GROUP_TASK_IDS.length > 0) {
    // A worktree run executes exactly one plan (group). Resolve THAT plan's
    // manifest by its tasks' feature_id — never findIncompleteManifest, which
    // would pick an arbitrary seeded manifest and run another plan's phases in
    // this worktree. Tracking the manifest here is what lets the post-work
    // phases (Simplify → … → Complete) run in worktree mode instead of the
    // pipeline stalling at Implement.
    const firstTask = GROUP_TASK_IDS.map(id => lib.getTask(TASKS_FILE, id)).find(Boolean);
    const fid = firstTask && firstTask.feature_id;
    if (fid) {
      const mPath = orchestration.getManifestPath(PROJECT_ROOT, fid);
      const m = orchestration.readManifest(mPath);
      if (m) {
        workFeatureId = fid;
        workManifestPath = mPath;
        // Planning phases 1-7 are covered by plan + approve (run before work).
        [1, 2, 3, 4, 5, 6, 7].forEach(n => {
          const s = m.phases[n]?.status;
          if (m.active_phases.includes(n) && s !== 'completed' && s !== 'skipped')
            orchestration.completePhase(mPath, n, { source: 'plan' });
        });
        // Phase 8 = Implement — running for the duration of the work loop.
        if (m.active_phases.includes(8)) orchestration.startPhase(mPath, 8);
        workManifest = orchestration.readManifest(mPath);
      }
    }
  } else if (!WORKTREE_MODE) {
    const existing = orchestration.findIncompleteManifest(PROJECT_ROOT);
    if (existing) {
      workFeatureId  = existing.featureId;
      workManifest   = existing.manifest;
      workManifestPath = existing.manifestPath;
    } else {
      workFeatureId = orchestration.generateFeatureId(description || 'work-session');
      const created = orchestration.createManifest(
        PROJECT_ROOT, workFeatureId, description || 'work session', workType
      );
      workManifest     = created.manifest;
      workManifestPath = created.manifestPath;
      // Planning phases 1-4 already done (cmdPlan ran above)
      [1, 2, 3, 4].forEach(n => {
        if (workManifest.active_phases.includes(n))
          orchestration.completePhase(workManifestPath, n, { source: 'plan' });
      });
      // Mark complexity + brainstorm + architect as done (embedded in planning)
      [5, 6, 7].forEach(n => {
        if (workManifest.active_phases.includes(n))
          orchestration.completePhase(workManifestPath, n, { source: 'plan' });
      });
    }
    // Phase 8 = Implement — mark as running for the duration of the work loop
    if (workManifest.active_phases.includes(8))
      orchestration.startPhase(workManifestPath, 8);
    workManifest = orchestration.readManifest(workManifestPath);
  }

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
    } else if (GROUP_TASK_IDS.length > 0) {
      // Group/worktree mode: only ever run the assigned tasks. Do NOT fall back
      // to getNextTask, which would pick up other plans' tasks from this
      // worktree's tasks.json copy and break per-plan isolation.
      taskId = null;
    } else {
      taskId = lib.getNextTask(TASKS_FILE);
    }

    if (!taskId) {
      logSuccess('All tasks completed!');
      logInfo(`Completed: ${lib.countCompleted(TASKS_FILE)} / ${lib.countTotal(TASKS_FILE)}`);
      console.log('');

      // Complete phase 8 (Implement) now that all tasks are done
      if (workManifestPath && workManifest?.active_phases?.includes(8)) {
        orchestration.completePhase(workManifestPath, 8, { source: 'work-loop' });
        workManifest = orchestration.readManifest(workManifestPath);
      }

      // Run post-work quality gates (Simplify → … → Complete) based on work type.
      // Runs in both normal and worktree mode. In worktree mode we require a
      // manifest we resolved by feature_id above, so runPostWorkPhases never
      // falls back to findIncompleteManifest (which would target another plan).
      if (!SKIP_GATES && (!WORKTREE_MODE || workManifestPath)) {
        const gateWorkType = workManifest?.work_type || workType;
        await runPostWorkPhases(description, gateWorkType, workFeatureId, workManifest, workManifestPath);
      }

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
      } else if (GROUP_TASK_IDS.length > 0) {
        // Group/worktree mode never falls back to getNextTask, so a task that
        // got reverted to pending would be dropped from the queue and the run
        // would falsely report "All tasks completed". Re-queue it to retry
        // within this run (bounded by kill_after_fails above) — keep going
        // until every group task is genuinely completed or blocked.
        logWarn(`Re-queuing ${taskId} for retry (attempt ${consecutiveFails}/${killAfter}).`);
        taskQueue.push(taskId);
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

  logHeader('JONGGRANG Status');

  const projectName = lib.readConfig(CONFIG_FILE, 'name', 'unknown');
  console.log(`Project: ${BOLD}${projectName}${NC}`);

  // ── Pipeline state from MANIFEST ─────────────────────────────
  const allManifests = orchestration.listManifests(PROJECT_ROOT);
  const activeManifest = allManifests.find(m =>
    ['running', 'in_progress', 'paused'].includes(m.manifest.status)
  ) || allManifests[0];

  if (activeManifest) {
    const m = activeManifest.manifest;
    const phaseLabel = m.current_phase
      ? `Phase ${m.current_phase} (${orchestration.PHASES[m.current_phase]?.name || '?'})`
      : 'complete';

    console.log(`Work Type: ${BOLD}${m.work_type}${NC}  |  Pipeline: ${m.status}  |  ${phaseLabel}`);
    console.log('');

    // Phase grid — 4 per row
    const phaseNums = Object.keys(orchestration.PHASES).map(Number);
    for (let i = 0; i < phaseNums.length; i++) {
      const n = phaseNums[i];
      const phaseDef = orchestration.PHASES[n];
      const isActive = m.active_phases.includes(n);
      const phaseState = m.phases[n];
      const status = phaseState?.status || 'pending';

      let icon, color;
      if (!isActive)                  { icon = '–'; color = NC; }
      else if (status === 'completed') { icon = '✓'; color = GREEN; }
      else if (status === 'running')   { icon = '⟳'; color = YELLOW; }
      else if (status === 'failed')    { icon = '✗'; color = RED; }
      else                             { icon = '·'; color = NC; }

      const cell = `${color}${icon}${NC} ${String(n).padEnd(2)} ${phaseDef.name.padEnd(14)}`;
      process.stdout.write(cell);
      if ((i + 1) % 4 === 0) console.log('');
    }
    console.log('');

    // Quality gates
    const v = m.validation || {};
    const gate = (flag, label) => flag ? `${GREEN}✓${NC} ${label}` : `· ${label}`;
    console.log(`Quality Gates:  ${gate(v.review_passed, 'Review')}   ${gate(v.tests_passed, 'Tests')}   ${gate(v.coverage_met, 'Coverage')}`);
    console.log('');
  }

  // ── Task board ────────────────────────────────────────────────
  console.log(`Tasks: ${lib.countCompleted(TASKS_FILE)}/${lib.countTotal(TASKS_FILE)} completed`);
  console.log('');

  const data = lib.getTasks(TASKS_FILE);
  if (!data.tasks || data.tasks.length === 0) {
    const hasPlan = lib.fileExists(PLAN_FILE);
    console.log(`${BOLD}ID          Status       Title${NC}`);
    console.log('--------------------------------------------------------------');
    if (hasPlan) {
      console.log(`${NC}  (pending plan.md — run: jonggrang approve  to decompose into tasks)${NC}`);
    } else {
      console.log(`${NC}  (no tasks yet — run: jonggrang plan "feature"  then  jonggrang approve)${NC}`);
    }
    return;
  }

  // Group tasks by feature_id (null = legacy/no feature link)
  const groups = new Map();
  for (const task of data.tasks) {
    const key = task.feature_id || '__legacy__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  const printTask = (task) => {
    let color;
    switch (task.status) {
      case 'completed':   color = GREEN; break;
      case 'in_progress': color = YELLOW; break;
      case 'blocked':     color = RED; break;
      default:            color = NC; break;
    }
    const id = (task.id || '').padEnd(11);
    const status = (task.status || '').padEnd(12);
    console.log(`${color}${id} ${status} ${task.title || ''}${NC}`);
  };

  if (groups.size === 1) {
    // Single feature — simple flat list (original layout)
    const [key, tasks] = [...groups][0];
    if (key !== '__legacy__') {
      const archivePlan = path.join(PROJECT_ROOT, '.jonggrang', '.output', 'features', key, 'plan.md');
      const label = lib.fileExists(archivePlan) ? parsePlanFrontmatter(fs.readFileSync(archivePlan, 'utf8')).feature || key : key;
      console.log(`${BOLD}ID          Status       Title${NC}   ${DIM}[${label}]${NC}`);
    } else {
      console.log(`${BOLD}ID          Status       Title${NC}`);
    }
    console.log('--------------------------------------------------------------');
    for (const task of tasks) printTask(task);
  } else {
    // Multiple features — group by feature
    for (const [key, tasks] of groups) {
      let groupLabel = key;
      if (key !== '__legacy__') {
        const archivePlan = path.join(PROJECT_ROOT, '.jonggrang', '.output', 'features', key, 'plan.md');
        if (lib.fileExists(archivePlan)) {
          const fm = parsePlanFrontmatter(fs.readFileSync(archivePlan, 'utf8'));
          groupLabel = `${fm.feature || key}${fm.description ? ' — ' + fm.description : ''}`;
        }
      }
      const done = tasks.filter(t => t.status === 'completed').length;
      console.log(`${BOLD}${CYAN}▸ ${groupLabel}${NC}  ${DIM}(${done}/${tasks.length})${NC}`);
      console.log(`${BOLD}  ID          Status       Title${NC}`);
      console.log('  ------------------------------------------------------------');
      for (const task of tasks) {
        let color;
        switch (task.status) {
          case 'completed':   color = GREEN; break;
          case 'in_progress': color = YELLOW; break;
          case 'blocked':     color = RED; break;
          default:            color = NC; break;
        }
        const id = (task.id || '').padEnd(11);
        const status = (task.status || '').padEnd(12);
        console.log(`${color}  ${id} ${status} ${task.title || ''}${NC}`);
      }
      console.log('');
    }
  }
}

// ============================================================
// REVIEW
// ============================================================

async function cmdReview() {
  safeCheckConfig();

  if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
    TOOL = lib.readConfig(CONFIG_FILE, 'tool', DEFAULT_TOOL);
  }
  resolveModelAndEffort();

  logHeader('JONGGRANG Review');

  const reviewPrompt = lib.buildReviewPrompt();

  const logDir = path.join(PROJECT_ROOT, 'jonggrang-log');
  if (!lib.fileExists(logDir)) fs.mkdirSync(logDir, { recursive: true });

  logInfo('Running comprehensive review...');
  await lib.runAgent(reviewPrompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });

  logSuccess('Review complete. Check jonggrang-log/ for report.');
}

// ============================================================
// PLAN
// ============================================================

/** Parse key: value pairs from YAML frontmatter of a plan.md */
function parsePlanFrontmatter(content) {
  const get = (key) => { const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
  return {
    feature:     get('feature'),
    branch:      get('branch'),
    work_type:   get('work_type'),
    description: get('description'),
    created_at:  get('created_at'),
  };
}

/** Collect pending plan.md + all archived feature plan.mds, sorted newest first */
function listAvailablePlans(jonggrangDir) {
  const plans = [];

  // Pending plan
  const pendingPath = path.join(jonggrangDir, 'plan.md');
  if (lib.fileExists(pendingPath)) {
    const content = fs.readFileSync(pendingPath, 'utf8');
    const fm = parsePlanFrontmatter(content);
    plans.push({
      value:     pendingPath,
      label:     `[pending]  ${fm.feature || 'unnamed'}${fm.description ? ' — ' + fm.description : ''}`,
      isPending: true,
    });
  }

  // Archived plans (newest first by dir mtime)
  const featuresDir = path.join(jonggrangDir, '.output', 'features');
  if (lib.fileExists(featuresDir)) {
    const entries = fs.readdirSync(featuresDir)
      .map(e => ({ name: e, mtime: fs.statSync(path.join(featuresDir, e)).mtime }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(e => e.name);

    for (const entry of entries) {
      const planPath = path.join(featuresDir, entry, 'plan.md');
      if (lib.fileExists(planPath)) {
        const content = fs.readFileSync(planPath, 'utf8');
        const fm = parsePlanFrontmatter(content);
        plans.push({
          value:     planPath,
          label:     `[archived] ${fm.feature || entry}${fm.description ? ' — ' + fm.description : ''}`,
          isPending: false,
          featureId: entry,
        });
      }
    }
  }

  return plans;
}

/** Display plan.md content in a bordered box */
function displayPlanBox(planFile) {
  if (!lib.fileExists(planFile)) return;
  console.log('');
  console.log(`${BOLD}${CYAN}┌─── .jonggrang/plan.md ─────────────────────────────────────${NC}`);
  const planText = fs.readFileSync(planFile, 'utf8');
  planText.split('\n').forEach(line => console.log(`${CYAN}│${NC} ${line}`));
  console.log(`${BOLD}${CYAN}└────────────────────────────────────────────────────────────${NC}`);
  console.log('');
}

// Ensure the project is initialized. Offers to run `jonggrang init` if not.
// Returns true if we can proceed, false if the user declined or init failed.
async function ensureInit() {
  const validation = lib.validateProjectState(PROJECT_ROOT);

  // All 3 files valid — ready to go
  if (validation.allValid) return true;

  // Config is valid but tasks/progress are missing/corrupt — auto-regenerate them
  if (validation.config.valid) {
    const existingConfig = lib.readJSON(CONFIG_FILE);
    const name = existingConfig?.name || path.basename(PROJECT_ROOT);

    if (!validation.tasks.valid) {
      lib.writeJSON(TASKS_FILE, { feature: '', branch: '', tasks: [] });
      logWarn(`Regenerated jonggrang-tasks.json (was ${validation.tasks.reason}).`);
    }
    if (!validation.progress.valid) {
      const now = new Date().toISOString().split('T')[0];
      fs.writeFileSync(PROGRESS_FILE, `# Jonggrang Progress Log — ${name}\n# Created: ${now}\n`);
      logWarn(`Regenerated progress.txt (was ${validation.progress.reason}).`);
    }
    return true;
  }

  // Config itself is invalid — need full init
  const isInteractiveTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!isInteractiveTTY) {
    logError('Project not initialized. Run "jonggrang init" first.');
    return false;
  }

  logWarn('Project not initialized (.jonggrang/jonggrang.json not found or invalid).');
  const doInit = await confirm({
    message: 'Initialize project now?',
    initialValue: true,
  });
  if (isCancel(doInit) || !doInit) {
    cancel('Run "jonggrang init" first to set up the project.');
    return false;
  }

  await cmdInit();

  if (!lib.fileExists(CONFIG_FILE)) {
    logError('Init did not complete successfully. Please run "jonggrang init" manually.');
    return false;
  }
  return true;
}

// ── PHASE 1: Generate draft plan.md ───────────────────────────
// opts.fromWork = true → suppress "run jonggrang work" tail (cmdWork will continue itself)
async function cmdPlan(args, opts = {}) {
  let description = '';
  let autoApprove = false;
  let deepMode = false;
  let reviseMode = false;
  let baseBranch = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yes' || arg === '-y') autoApprove = true;
    else if (arg === '--deep') deepMode = true;
    else if (arg === '--revise') reviseMode = true;
    else if (arg === '--base') baseBranch = args[++i] || '';
    else if (!arg.startsWith('--')) description = arg;
  }

  // Validate --base up front: it ends up interpolated into `git fetch` at
  // worktree creation, so reject anything that isn't a plain branch name before
  // we spend a plan generation on it.
  if (baseBranch && !lib.isSafeBranchName(baseBranch)) {
    logError(`Invalid --base "${baseBranch}": must be a plain branch name (letters, digits, . _ / -).`);
    process.exit(1);
  }

  if (!await ensureInit()) return;

  // ── Revise mode: AI rewrites existing plan.md ────────────────
  if (reviseMode) {
    if (!lib.fileExists(PLAN_FILE)) {
      logError('No plan.md found to revise. Generate a plan first.');
      process.exit(1);
    }
    if (!description) {
      logError('Revision instruction required. Usage: jonggrang plan --revise "instruction"');
      process.exit(1);
    }
    if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
      TOOL = lib.readConfig(CONFIG_FILE, 'tool', DEFAULT_TOOL);
    }
    logHeader('JONGGRANG Plan — Revise with AI');
    logInfo(`Instruction: ${description}`);
    const currentPlan = fs.readFileSync(PLAN_FILE, 'utf8');
    const revisePrompt = lib.buildRevisePlanPrompt(currentPlan, description);
    await lib.runAgent(revisePrompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG });
    logSuccess('Plan revised. Run "jonggrang approve" to decompose into tasks.');
    return;
  }

  if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
    TOOL = lib.readConfig(CONFIG_FILE, 'tool', DEFAULT_TOOL);
  }
  resolveModelAndEffort();

  const isInteractiveTTY = process.stdin.isTTY && process.stdout.isTTY;

  // Ask about deep mode when user hasn't specified --deep and a description was given
  if (description && !deepMode && !autoApprove && isInteractiveTTY) {
    const useDeep = await confirm({
      message: 'Use deep mode? (3-phase analysis — richer plan for complex features)',
      initialValue: false,
    });
    if (!isCancel(useDeep)) deepMode = !!useDeep;
  }

  // ── No description → pick from available plans ──────────────
  if (!description) {
    const available = listAvailablePlans(path.dirname(PLAN_FILE));
    if (available.length === 0) {
      logError('No plans found.');
      logInfo('Run "jonggrang plan <description>" to generate a new plan.');
      process.exit(1);
    }

    if (!isInteractiveTTY) {
      logError('Usage: jonggrang plan "<feature-description>" [--yes]');
      process.exit(1);
    }

    logHeader('JONGGRANG Plan — Pick');
    const picked = await select({
      message: 'Which plan would you like to work with?',
      options: available,
    });
    if (isCancel(picked)) { cancel('Aborted.'); return; }

    // If archived → copy back to plan.md so the rest of the flow works normally
    if (picked !== PLAN_FILE) {
      if (lib.fileExists(PLAN_FILE)) {
        const overwrite = await confirm({
          message: 'A pending plan already exists. Replace it with the selected plan?',
          initialValue: false,
        });
        if (isCancel(overwrite) || !overwrite) { cancel('Cancelled.'); return; }
      }
      fs.copyFileSync(picked, PLAN_FILE);
      logInfo('Plan loaded from archive.');
    }

    // Fall through to the interactive options loop below (skip generation)
    await showPlanOptions(isInteractiveTTY, autoApprove, opts);
    return;
  }

  // ── Description given → generate new plan ───────────────────

  // If there is already a pending plan, ask what to do
  if (lib.fileExists(PLAN_FILE)) {
    if (isInteractiveTTY) {
      const overwrite = await confirm({
        message: 'A pending plan.md already exists. Overwrite it with a new plan?',
        initialValue: false,
      });
      if (isCancel(overwrite) || !overwrite) {
        logInfo('Keeping existing plan. Run "jonggrang approve" to continue with it.');
        return;
      }
    } else {
      logWarn('Overwriting existing .jonggrang/plan.md...');
    }
  }

  if (deepMode) {
    // ── Deep mode: 3 sequential AI phases ──────────────────────
    const jonggrangDir = path.dirname(PLAN_FILE);
    const ephemeralDir = path.join(jonggrangDir, '.ephemeral');
    const discoveryFile = path.join(ephemeralDir, 'deep-plan-discovery.md');
    const analysisFile = path.join(ephemeralDir, 'deep-plan-analysis.md');

    fs.mkdirSync(ephemeralDir, { recursive: true });

    // Clear any stale feedback-loop state from previous work sessions.
    // Deep-plan phases are read-only discovery/planning — they must not be blocked
    // by a prior run's active feedback loop.
    feedback.clearFeedbackState(PROJECT_ROOT);

    logHeader('JONGGRANG Plan — Deep Mode (3 phases)');
    logInfo(`Feature: ${description}`);
    logInfo(`Tool:    ${TOOL}`);

    // Phase 1: Discovery
    logInfo(`${BOLD}[1/3]${NC} Codebase discovery...`);
    const discoveryPrompt = lib.buildDeepPlanDiscoveryPrompt(description, CONFIG_FILE);
    await lib.runAgent(discoveryPrompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });

    if (!lib.fileExists(discoveryFile)) {
      logError('Discovery agent did not write .jonggrang/.ephemeral/deep-plan-discovery.md');
      logInfo('Falling back to standard plan generation...');
      const fallbackPrompt = lib.buildDraftPlanPrompt(description, CONFIG_FILE, TASKS_FILE);
      await lib.runAgent(fallbackPrompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });
    } else {
      // Phase 2: Analysis
      logInfo(`${BOLD}[2/3]${NC} Complexity analysis & brainstorm...`);
      const discoveryContent = fs.readFileSync(discoveryFile, 'utf8');
      const analysisPrompt = lib.buildDeepPlanAnalysisPrompt(description, discoveryContent);
      await lib.runAgent(analysisPrompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });

      if (!lib.fileExists(analysisFile)) {
        logError('Analysis agent did not write .jonggrang/.ephemeral/deep-plan-analysis.md');
        logInfo('Falling back to standard plan generation using discovery only...');
        const fallbackPrompt = lib.buildDraftPlanPrompt(description, CONFIG_FILE, TASKS_FILE);
        await lib.runAgent(fallbackPrompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });
      } else {
        // Phase 3: Condense
        logInfo(`${BOLD}[3/3]${NC} Condensing into enriched plan.md...`);
        const analysisContent = fs.readFileSync(analysisFile, 'utf8');
        const condensePrompt = lib.buildDeepPlanCondensePrompt(
          description, discoveryContent, analysisContent, CONFIG_FILE, TASKS_FILE
        );
        await lib.runAgent(condensePrompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });

        // Clean up ephemeral files
        try {
          fs.unlinkSync(discoveryFile);
          fs.unlinkSync(analysisFile);
          fs.rmdirSync(ephemeralDir);
        } catch { /* ignore if already gone */ }

        logSuccess('Deep plan complete.');
      }
    }
  } else {
    // ── Standard mode ─────────────────────────────────────────
    logHeader('JONGGRANG Plan — Phase 1');
    logInfo(`Feature: ${description}`);
    logInfo(`Tool:    ${TOOL}`);
    logInfo('Generating draft plan...');

    // Clear stale feedback-loop state — planning is read-only, must not be blocked.
    feedback.clearFeedbackState(PROJECT_ROOT);

    const prompt = lib.buildDraftPlanPrompt(description, CONFIG_FILE, TASKS_FILE);
    await lib.runAgent(prompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });
  }

  // The base branch (worktree start-point) is a deterministic user choice, so
  // write it into the generated plan.md frontmatter (overriding anything the AI
  // may have put there). Covers both deep + standard generation paths above.
  // Warn if it didn't take — otherwise the worktree silently cuts from HEAD.
  if (baseBranch && lib.fileExists(PLAN_FILE) && !lib.setPlanBase(PLAN_FILE, baseBranch)) {
    logWarn(`Could not write base "${baseBranch}" to the plan frontmatter — the worktree will start from HEAD unless you set it manually.`);
  }

  if (autoApprove) {
    logInfo('Auto-approving plan (--yes)...');
    await cmdApprove([], { quiet: true });
    if (!opts.fromWork) logSuccess('Tasks ready. Run "jonggrang work" to execute.');
    return;
  }

  await showPlanOptions(isInteractiveTTY, false, opts);
}

/**
 * Display the current plan.md and loop through options until the user
 * approves, aborts, or saves the plan for later.
 */
async function showPlanOptions(isInteractiveTTY, autoApprove, opts = {}) {
  const doApprove = async () => {
    await cmdApprove([], { quiet: true });
    if (!opts.fromWork) logSuccess('Tasks ready. Run "jonggrang work" to execute.');
  };

  if (!lib.fileExists(PLAN_FILE)) {
    logError('No plan.md found. Run "jonggrang plan <description>" first.');
    return;
  }

  if (autoApprove) {
    displayPlanBox(PLAN_FILE);
    logInfo('Auto-approving plan (--yes)...');
    await doApprove();
    return;
  }

  if (!isInteractiveTTY) {
    logSuccess('Draft plan written to .jonggrang/plan.md');
    logInfo('Review / edit it, then run "jonggrang approve" to decompose into tasks.');
    return;
  }

  // Interactive options loop
  let done = false;
  while (!done) {
    displayPlanBox(PLAN_FILE);

    const choice = await select({
      message: 'What would you like to do?',
      options: [
        { value: 'approve',  label: 'Approve — decompose to tasks now' },
        { value: 'edit-ai',  label: 'Edit with AI — describe what to change' },
        { value: 'edit',     label: `Edit in $EDITOR (${process.env.EDITOR || 'vi'})` },
        { value: 'later',    label: 'Save draft — approve later with "jonggrang approve"' },
        { value: 'delete',   label: 'Delete — permanently remove this plan' },
        { value: 'cancel',   label: 'Cancel — exit without changes' },
      ],
    });
    if (isCancel(choice)) { cancel('Cancelled.'); return; }

    if (choice === 'approve') {
      await doApprove();
      done = true;

    } else if (choice === 'edit-ai') {
      const feedback = await text({
        message: 'What changes do you want? (describe freely)',
        placeholder: 'e.g. "add a caching phase" or "use Passport.js instead of custom JWT"',
      });
      if (isCancel(feedback) || !feedback.trim()) {
        logInfo('No feedback entered — plan unchanged.');
        continue;
      }
      logInfo('Revising plan with AI...');
      const currentPlan = fs.readFileSync(PLAN_FILE, 'utf8');
      const revisePrompt = lib.buildRevisePlanPrompt(currentPlan, feedback.trim());
      await lib.runAgent(revisePrompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });
      // loop back → display updated plan + options again

    } else if (choice === 'edit') {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      execSync(`${editor} "${PLAN_FILE}"`, { stdio: 'inherit' });
      // loop back → display edited plan + options again

    } else if (choice === 'delete') {
      const confirm_ = await confirm({ message: 'Delete this plan permanently?', initialValue: false });
      if (!isCancel(confirm_) && confirm_) {
        fs.unlinkSync(PLAN_FILE);
        logWarn('Plan deleted.');
        done = true;
      }
      // if user cancels/says no → loop back

    } else if (choice === 'cancel') {
      logInfo('Exited. Plan saved at .jonggrang/plan.md');
      done = true;

    } else { // 'later'
      logSuccess('Draft plan saved to .jonggrang/plan.md');
      logInfo('Edit it freely, then run "jonggrang approve" to decompose into tasks.');
      done = true;
    }
  }
}

// ── PHASE 2: Approve plan → decompose to tasks + archive ──────
// opts.quiet = true  → skip "Run jonggrang work" tail (used when called from within cmdWork/cmdPlan)
async function cmdApprove(args, opts = {}) {
  if (!lib.fileExists(PLAN_FILE)) {
    logError('No pending plan found at .jonggrang/plan.md');
    logInfo('Run "jonggrang plan <description>" first.');
    process.exit(1);
  }

  safeCheckConfig();

  if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
    TOOL = lib.readConfig(CONFIG_FILE, 'tool', DEFAULT_TOOL);
  }
  resolveModelAndEffort();

  const planContent = fs.readFileSync(PLAN_FILE, 'utf8');

  // Parse YAML frontmatter fields
  const fm = parsePlanFrontmatter(planContent);
  const featureName = fm.feature || 'work-session';
  const workType    = fm.work_type || 'MEDIUM';

  // Generate featureId BEFORE running the agent so we can stamp new tasks
  const featureId = orchestration.generateFeatureId(featureName);

  // Snapshot existing task IDs (only those committed to a completed feature).
  // Orphan tasks (feature_id: null) are leftovers from a previous partial approve
  // that never reached the archive step — purge them now so the agent gets a
  // clean slate and won't hit "task already exists" errors.
  const tasksBeforeClean = lib.getTasks(TASKS_FILE);
  if (tasksBeforeClean?.tasks?.some(t => t.feature_id == null)) {
    const cleaned = { ...tasksBeforeClean, tasks: tasksBeforeClean.tasks.filter(t => t.feature_id != null) };
    lib.writeJSON(TASKS_FILE, cleaned);
  }
  const existingTaskIds = new Set(
    (lib.getTasks(TASKS_FILE)?.tasks || []).map(t => t.id)
  );

  logHeader('JONGGRANG Approve — Phase 2');
  logInfo(`Feature:    ${featureName}`);
  logInfo(`Feature ID: ${featureId}`);
  logInfo(`Work type:  ${workType}`);
  logInfo('Decomposing plan into tasks...');

  const prompt = lib.buildTasksFromPlanPrompt(planContent, CONFIG_FILE, TASKS_FILE, SKILLS_DIR);
  await lib.runAgent(prompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG, model: MODEL, effort: EFFORT });

  // Stamp every newly created task with the authoritative feature_id.
  // Always overwrite: the decomposition agent may have set feature_id to the bare slug
  // (e.g. "frontend-backend-integration") from the plan frontmatter, which lacks the
  // unique suffix (e.g. "-mo35rirj"). That wrong ID breaks plan.md path lookups.
  const tasksData = lib.getTasks(TASKS_FILE);
  if (tasksData && tasksData.tasks) {
    let modified = false;
    for (const task of tasksData.tasks) {
      if (!existingTaskIds.has(task.id) && task.feature_id !== featureId) {
        task.feature_id = featureId;
        modified = true;
      }
    }
    if (modified) lib.writeJSON(TASKS_FILE, tasksData);
  }

  // Only archive if the agent actually created new tasks
  const refreshedTasks = lib.getTasks(TASKS_FILE);
  const newTasks = (refreshedTasks?.tasks || []).filter(t => !existingTaskIds.has(t.id));
  if (newTasks.length === 0) {
    logError('Agent did not create any tasks. plan.md has been preserved — re-run "jonggrang approve" after fixing the issue.');
    process.exit(1);
  }

  // Archive the approved plan
  const outputDir = path.join(PROJECT_ROOT, '.jonggrang', '.output', 'features', featureId);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(PLAN_FILE, path.join(outputDir, 'plan.md'));
  fs.unlinkSync(PLAN_FILE);

  // Create a MANIFEST for this feature so cmdWork can resume under the correct feature ID.
  // Without this, cmdWork creates a generic work-session-xxx MANIFEST disconnected from the plan.
  const manifestPath = path.join(outputDir, 'MANIFEST.yaml');
  if (!fs.existsSync(manifestPath)) {
    const created = orchestration.createManifest(PROJECT_ROOT, featureId, featureName, workType);
    // Mark all planning phases as done — they were completed by plan+approve
    const mPath = created.manifestPath;
    [1, 2, 3, 4, 5, 6, 7].forEach(n => {
      if (created.manifest.active_phases.includes(n))
        orchestration.completePhase(mPath, n, { source: 'approve' });
    });
  }

  logSuccess('Plan approved.');
  logInfo(`Feature ID:    ${featureId}`);
  logInfo(`Plan archived: .jonggrang/.output/features/${featureId}/plan.md`);

  if (!opts.quiet) {
    console.log('');
    cmdStatus();
    console.log('');
    logSuccess('Run "jonggrang work" to start executing tasks.');
  }
}

// ============================================================
// BUG REPORTS
// ============================================================

const BUGS_FILE_NAME = 'bugs.md';

/** Parse bugs.md → array of { bugId, status, taskId|null, timestamp, description } */
function parseBugsFile(content) {
  const bugs = [];
  // Split on ## headers
  const sections = content.split(/^## /m).slice(1); // drop title section
  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0]; // e.g. "[open] bug-001 · 2026-04-16T10:00:00Z"
    const description = lines.slice(1).join('\n').trim();

    const openMatch  = header.match(/^\[open\]\s+(bug-\d+)\s+·\s+(.+)$/);
    const taskMatch  = header.match(/^\[task:([^\]]+)\]\s+(bug-\d+)\s+·\s+(.+)$/);

    if (openMatch) {
      bugs.push({ bugId: openMatch[1], status: 'open', taskId: null, timestamp: openMatch[2].trim(), description });
    } else if (taskMatch) {
      bugs.push({ bugId: taskMatch[2], status: 'converted', taskId: taskMatch[1], timestamp: taskMatch[3].trim(), description });
    }
  }
  return bugs;
}

/** Append a new bug entry to bugs.md. Returns the new bugId. */
function appendBug(bugsPath, featureName, description) {
  let content = '';
  let nextNum = 1;

  if (lib.fileExists(bugsPath)) {
    content = fs.readFileSync(bugsPath, 'utf8');
    const existing = parseBugsFile(content);
    nextNum = existing.length + 1;
  } else {
    content = `# Bug Reports — ${featureName}\n`;
  }

  const bugId = `bug-${String(nextNum).padStart(3, '0')}`;
  const timestamp = new Date().toISOString();
  content += `\n## [open] ${bugId} · ${timestamp}\n${description}\n`;
  fs.writeFileSync(bugsPath, content, 'utf8');
  return bugId;
}

/** Update bugs.md: change [open] bug-001 → [task:task-005] bug-001 */
function markBugConverted(bugsPath, bugId, taskId) {
  if (!lib.fileExists(bugsPath)) return;
  let content = fs.readFileSync(bugsPath, 'utf8');
  content = content.replace(
    new RegExp(`^## \\[open\\] (${bugId} · .+)$`, 'm'),
    `## [task:${taskId}] $1`
  );
  fs.writeFileSync(bugsPath, content, 'utf8');
}

/** List all features that have a plan.md (to pick a feature for bug reports) */
function listFeatures(jonggrangDir) {
  const features = [];
  const featuresDir = path.join(jonggrangDir, '.output', 'features');
  if (!lib.fileExists(featuresDir)) return features;

  const entries = fs.readdirSync(featuresDir)
    .map(e => ({ name: e, mtime: fs.statSync(path.join(featuresDir, e)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(e => e.name);

  for (const entry of entries) {
    const planPath = path.join(featuresDir, entry, 'plan.md');
    if (lib.fileExists(planPath)) {
      const fm = parsePlanFrontmatter(fs.readFileSync(planPath, 'utf8'));
      features.push({
        featureId:   entry,
        featureName: fm.feature || entry,
        description: fm.description || '',
        bugsPath:    path.join(featuresDir, entry, BUGS_FILE_NAME),
        planPath,
      });
    }
  }
  return features;
}

async function cmdBug(args) {
  safeCheckConfig();

  if (!TOOL_SET && !process.env.JONGGRANG_TOOL) {
    TOOL = lib.readConfig(CONFIG_FILE, 'tool', DEFAULT_TOOL);
  }
  resolveModelAndEffort();

  const isInteractiveTTY = process.stdin.isTTY && process.stdout.isTTY;
  const jonggrangDir = path.join(PROJECT_ROOT, '.jonggrang');

  // Parse subcommand
  const subArgs = [...args];
  let sub = 'add';
  if (['list', 'convert'].includes(subArgs[0])) sub = subArgs.shift();

  // --feature <featureId> override
  let forcedFeatureId = null;
  const featureIdx = subArgs.indexOf('--feature');
  if (featureIdx !== -1) {
    forcedFeatureId = subArgs[featureIdx + 1];
    subArgs.splice(featureIdx, 2);
  }

  const features = listFeatures(jonggrangDir);
  if (features.length === 0) {
    logError('No features found. Run "jonggrang plan" and "jonggrang approve" first.');
    process.exit(1);
  }

  // ── LIST ─────────────────────────────────────────────────────
  if (sub === 'list') {
    const targets = forcedFeatureId
      ? features.filter(f => f.featureId === forcedFeatureId || f.featureName === forcedFeatureId)
      : features;

    for (const feat of targets) {
      console.log(`\n${BOLD}${CYAN}▸ ${feat.featureName}${NC}  ${DIM}(${feat.featureId})${NC}`);
      if (!lib.fileExists(feat.bugsPath)) {
        console.log(`  ${DIM}(no bugs reported)${NC}`);
        continue;
      }
      const bugs = parseBugsFile(fs.readFileSync(feat.bugsPath, 'utf8'));
      if (bugs.length === 0) {
        console.log(`  ${DIM}(no bugs reported)${NC}`);
        continue;
      }
      console.log(`  ${BOLD}${'ID'.padEnd(9)} ${'Status'.padEnd(18)} Description${NC}`);
      console.log('  ' + '-'.repeat(70));
      for (const bug of bugs) {
        const statusLabel = bug.status === 'open'
          ? `${YELLOW}open${NC}`
          : `${GREEN}task:${bug.taskId}${NC}`;
        const desc = bug.description.split('\n')[0].slice(0, 50);
        console.log(`  ${(bug.bugId).padEnd(9)} ${statusLabel.padEnd(26)} ${desc}`);
      }
    }
    return;
  }

  // ── CONVERT ──────────────────────────────────────────────────
  if (sub === 'convert') {
    let feat;
    if (forcedFeatureId) {
      feat = features.find(f => f.featureId === forcedFeatureId || f.featureName === forcedFeatureId);
      if (!feat) { logError(`Feature "${forcedFeatureId}" not found.`); process.exit(1); }
    } else if (features.length === 1) {
      feat = features[0];
    } else if (isInteractiveTTY) {
      const picked = await select({
        message: 'Which feature to convert bugs for?',
        options: features.map(f => ({
          value: f.featureId,
          label: `${f.featureName}${f.description ? ' — ' + f.description : ''}`,
        })),
      });
      if (isCancel(picked)) { cancel('Aborted.'); return; }
      feat = features.find(f => f.featureId === picked);
    } else {
      logError('Multiple features found. Use --feature <featureId>.');
      process.exit(1);
    }

    if (!lib.fileExists(feat.bugsPath)) {
      logWarn(`No bugs.md found for ${feat.featureName}.`);
      return;
    }

    const bugs = parseBugsFile(fs.readFileSync(feat.bugsPath, 'utf8'));
    const openBugs = bugs.filter(b => b.status === 'open');
    if (openBugs.length === 0) {
      logSuccess(`No open bugs in ${feat.featureName} — all already converted.`);
      return;
    }

    logHeader('JONGGRANG Bug Convert');
    logInfo(`Feature: ${feat.featureName}`);
    logInfo(`Open bugs: ${openBugs.length}`);

    // Snapshot existing task IDs before agent runs
    const existingTaskIds = new Set((lib.getTasks(TASKS_FILE)?.tasks || []).map(t => t.id));

    const prompt = lib.buildBugsToTasksPrompt(openBugs, feat.featureId, CONFIG_FILE, TASKS_FILE);
    await lib.runAgent(prompt, TOOL, 'autonomous', PROJECT_ROOT, { debug: DEBUG });

    // Find new tasks and correlate with bugs via TASK_CREATED output lines
    // Also update bugs.md for any open bugs → converted
    const newTasks = (lib.getTasks(TASKS_FILE)?.tasks || []).filter(t => !existingTaskIds.has(t.id));
    if (newTasks.length > 0) {
      // Assign bugs to tasks in order (AI creates one task per bug in order)
      for (let i = 0; i < Math.min(openBugs.length, newTasks.length); i++) {
        markBugConverted(feat.bugsPath, openBugs[i].bugId, newTasks[i].id);
        logSuccess(`${openBugs[i].bugId} → ${newTasks[i].id}: ${newTasks[i].title}`);
      }
    } else {
      logWarn('No new tasks were created by the agent. Check agent output above.');
    }
    return;
  }

  // ── ADD (default) ─────────────────────────────────────────────
  let description = subArgs.filter(a => !a.startsWith('--')).join(' ').trim();

  // Pick feature
  let feat;
  if (forcedFeatureId) {
    feat = features.find(f => f.featureId === forcedFeatureId || f.featureName === forcedFeatureId);
    if (!feat) { logError(`Feature "${forcedFeatureId}" not found.`); process.exit(1); }
  } else if (features.length === 1) {
    feat = features[0];
  } else if (isInteractiveTTY) {
    const picked = await select({
      message: 'Which feature does this bug belong to?',
      options: features.map(f => ({
        value: f.featureId,
        label: `${f.featureName}${f.description ? ' — ' + f.description : ''}`,
      })),
    });
    if (isCancel(picked)) { cancel('Aborted.'); return; }
    feat = features.find(f => f.featureId === picked);
  } else {
    logError('Multiple features found. Use --feature <featureId>.');
    process.exit(1);
  }

  // Get bug description interactively if not provided
  if (!description && isInteractiveTTY) {
    const input = await text({
      message: 'Describe the bug',
      placeholder: 'e.g. "Handler crashes when Content-Type header is missing"',
    });
    if (isCancel(input) || !input.trim()) { cancel('Aborted.'); return; }
    description = input.trim();
  }
  if (!description) {
    logError('Bug description required. Usage: jonggrang bug "description"');
    process.exit(1);
  }

  // Append to bugs.md
  const bugId = appendBug(feat.bugsPath, feat.featureName, description);
  logSuccess(`Reported ${bugId} in ${feat.featureName}`);
  logInfo(`Saved to: .jonggrang/.output/features/${feat.featureId}/${BUGS_FILE_NAME}`);

  // Ask: create task now?
  let createTask = false;
  if (isInteractiveTTY) {
    const ok = await confirm({ message: 'Create a task for this bug now?', initialValue: true });
    if (!isCancel(ok)) createTask = ok;
  }

  if (createTask) {
    const title = `Fix: ${description.split('\n')[0].slice(0, 80)}`;
    const task = lib.addTask(TASKS_FILE, {
      title,
      description: `Bug ${bugId}: ${description}`,
      priority: 1,
      feature_id: feat.featureId,
      skill: null,
      blocked_by: [],
      files: [],
    });
    // Mark bug as converted in bugs.md
    markBugConverted(feat.bugsPath, bugId, task.id);
    logSuccess(`Created ${task.id}: ${task.title}`);
    logInfo('Run "jonggrang work" to execute it.');
  } else {
    logInfo(`Run "jonggrang bug convert --feature ${feat.featureId}" to batch-convert later.`);
  }
}

// ============================================================
// INIT
// ============================================================

async function cmdInit() {
  logHeader('JONGGRANG — Project Setup');

  const isInteractiveTTY = process.stdin.isTTY && process.stdout.isTTY;

  // ── Validate existing project state ───────────────────────────
  const validation = lib.validateProjectState(PROJECT_ROOT);

  if (validation.allValid && !INIT_FORCE) {
    // All 3 files exist and are valid — skip re-initialization
    const existingConfig = lib.readJSON(CONFIG_FILE);
    const existingTasks = lib.getTasks(TASKS_FILE);
    const taskCount = existingTasks.tasks?.length || 0;
    const completedCount = existingTasks.tasks?.filter(t => t.status === 'completed').length || 0;
    logSuccess(`Project "${existingConfig.name}" is already initialized.`);
    logInfo(`  jonggrang.json       ✓ valid`);
    logInfo(`  jonggrang-tasks.json ✓ valid (${taskCount} tasks, ${completedCount} completed)`);
    logInfo(`  progress.txt         ✓ valid`);
    logInfo('Use --force to re-initialize from scratch.');
    return;
  }

  if (!validation.allValid && !INIT_FORCE) {
    // Some files exist — warn user before overwriting
    const hasAny = validation.config.valid || validation.tasks.valid || validation.progress.valid;
    if (hasAny) {
      const statusLabel = (v) => v.valid ? '✓ valid' : `✗ ${v.reason}`;
      logWarn('Existing project state detected:');
      logInfo(`  jonggrang.json       ${statusLabel(validation.config)}`);
      logInfo(`  jonggrang-tasks.json ${statusLabel(validation.tasks)}`);
      logInfo(`  progress.txt         ${statusLabel(validation.progress)}`);

      if (isInteractiveTTY) {
        const overwrite = await confirm({
          message: 'Re-initialize? Valid files will be preserved where possible.',
          initialValue: false,
        });
        if (isCancel(overwrite) || !overwrite) {
          cancel('Init cancelled.');
          return;
        }
      } else {
        logError('Project partially initialized. Use --force to overwrite.');
        process.exit(1);
      }
    }
  }

  // Auto-detect stack, type, testing, ci — no user input needed
  if (!INIT_STACK) {
    const detected = lib.detectStack(PROJECT_ROOT);
    INIT_STACK = detected !== 'unknown' ? detected : 'node-typescript';
    if (detected !== 'unknown') logInfo(`Detected stack: ${INIT_STACK}`);
  }
  if (!INIT_TYPE) INIT_TYPE = lib.stackToType(INIT_STACK);
  if (!INIT_TESTING) {
    const detected = lib.detectTestFramework(PROJECT_ROOT);
    INIT_TESTING = detected !== 'none' ? detected : 'none';
    if (INIT_TESTING !== 'none') logInfo(`Detected test framework: ${INIT_TESTING}`);
  }
  if (!INIT_CI) {
    INIT_CI = lib.detectCI(PROJECT_ROOT) || 'none';
    if (INIT_CI !== 'none') logInfo(`Detected CI: ${INIT_CI}`);
  }
  if (!INIT_WORK_MODE) INIT_WORK_MODE = 'solo';
  if (!INIT_TEAM_SIZE) INIT_TEAM_SIZE = '1';

  console.log('');

  // Only 3 questions: name, tool, autonomy
  if (isInteractiveTTY) {
    intro('Jonggrang Init');

    if (!INIT_NAME) {
      const nameAnswer = await text({
        message: 'Project name',
        initialValue: path.basename(PROJECT_ROOT),
        validate(v) { if (!v?.trim()) return 'Required.'; },
      });
      if (isCancel(nameAnswer)) { cancel('Cancelled.'); return; }
      INIT_NAME = nameAnswer.trim();
    }

    if (!INIT_TOOL) {
      const toolAnswer = await select({
        message: 'Primary AI agent tool',
        initialValue: 'jonggrang',
        options: [
          { value: 'jonggrang', label: 'Jonggrang   — primary tool (Recommended)' },
          { value: 'claude',    label: 'Claude Code — primary tool' },
          { value: 'opencode',  label: 'OpenCode    — primary tool' },
          { value: 'codex',     label: 'Codex       — OpenAI Codex CLI' },
        ],
      });
      if (isCancel(toolAnswer)) { cancel('Cancelled.'); return; }
      INIT_TOOL = toolAnswer;
    }

    if (!INIT_AUTONOMY) {
      const autonomyAnswer = await select({
        message: 'Autonomy mode',
        initialValue: 'autonomous',
        options: [
          { value: 'autonomous',  label: 'Autonomous  — agent acts freely' },
          { value: 'balanced',    label: 'Balanced    — agent asks for edits' },
          { value: 'supervised',  label: 'Supervised  — agent asks every step' },
        ],
      });
      if (isCancel(autonomyAnswer)) { cancel('Cancelled.'); return; }
      INIT_AUTONOMY = autonomyAnswer;
    }

  } else {
    const rl = createRL();
    if (!INIT_NAME)     INIT_NAME     = await ask(rl, 'Project name:',  path.basename(PROJECT_ROOT));
    if (!INIT_TOOL)     INIT_TOOL     = await ask(rl, 'Primary AI tool:', 'jonggrang', 'jonggrang|claude|opencode|codex');
    if (!INIT_AUTONOMY) INIT_AUTONOMY = await ask(rl, 'Autonomy mode:',  'autonomous', 'supervised|balanced|autonomous');
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
  }, JONGGRANG_HOME, PROJECT_ROOT, { force: !!INIT_FORCE });

  logSuccess('Generated .jonggrang/jonggrang.json');
  logSuccess('Generated opencode.json');
  logSuccess('Generated AGENTS.md');
  logSuccess('Generated CLAUDE.md');
  logSuccess('Installed .claude/agents/ (lead, developer, reviewer, test-lead, tester)');
  logSuccess('Installed .claude/SKILL.md');
  logSuccess('Installed .opencode/agents/ (lead, developer, reviewer, test-lead, tester)');
  logSuccess('Installed .opencode/SKILL.md');

  logSuccess('Generated .jonggrang/jonggrang-tasks.json');
  logSuccess('Generated .jonggrang/progress.txt');
  logSuccess(`Copied ${result.skillCount} skill templates → .claude/skills, .opencode/skills, .jonggrang/skills`);

  // ── Install hooks for the selected tool ──────────────────────
  try {
    const hookResults = hooksLib.installHooksForTool(PROJECT_ROOT, 'both', JONGGRANG_HOME);

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

  // Update .gitignore to exclude ephemeral state and parallel worktrees.
  // NOTE: .jonggrang/.output/ stays TRACKED on purpose — plans + manifests are
  // committed and travel with each plan's branch on push.
  const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
  const jonggrangIgnoreBlock = `\n# Jonggrang ephemeral state\n.jonggrang/.ephemeral/\n.jonggrang/locks/\n.jonggrang/.worktree/\n`;
  try {
    let existing = lib.fileExists(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!existing.includes('.jonggrang/.ephemeral')) {
      fs.appendFileSync(gitignorePath, jonggrangIgnoreBlock);
    } else if (!existing.includes('.jonggrang/.worktree')) {
      // Block already present from an older init — append just the worktree line.
      fs.appendFileSync(gitignorePath, `.jonggrang/.worktree/\n`);
    }
  } catch {}

  // Ensure the repo has at least one commit so parallel worktrees can branch
  // from HEAD. A fresh clone of an empty remote (or `git init`) has no commit;
  // repos that already have history are left untouched.
  try {
    execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, stdio: 'pipe' });
  } catch {
    try {
      execSync('git add -A', { cwd: PROJECT_ROOT, stdio: 'pipe' });
      execSync(`git commit -m "chore: initial jonggrang scaffolding" -m "${lib.COAUTHOR_TRAILER}"`, {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME:     process.env.GIT_AUTHOR_NAME     || 'jonggrang',
          GIT_AUTHOR_EMAIL:    process.env.GIT_AUTHOR_EMAIL    || 'jonggrang@local',
          GIT_COMMITTER_NAME:  process.env.GIT_COMMITTER_NAME  || 'jonggrang',
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'jonggrang@local',
        },
      });
      // Normalize the base branch to `main` (git's default is often `master`).
      // Safe here: we only reach this branch when the repo had no commit.
      try { execSync('git branch -M main', { cwd: PROJECT_ROOT, stdio: 'pipe' }); } catch {}
      logSuccess('Created initial commit on main (empty repository)');
    } catch (err) {
      logWarn(`Could not create initial commit: ${err.message}`);
    }
  }

  console.log('');
  logSuccess('Project ready!');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Edit AGENTS.md with your project conventions');
  console.log('    2. jonggrang plan "your feature"    # generate draft plan.md for review');
  console.log('       jonggrang approve                # approve plan → decompose to tasks');
  console.log('       jonggrang work                   # execute tasks');
  console.log('       — or —');
  console.log('       jonggrang plan "feature" --yes   # plan + approve + tasks in one shot');
  console.log('       jonggrang plan "feature" --deep  # deep mode: 3-phase analysis before plan');
  console.log('');
}

// ============================================================
// ORCHESTRATE COMMAND — 16-Phase Deterministic Workflow
// ============================================================

async function cmdOrchestrate(descriptionParts) {
  const description = descriptionParts.join(' ').trim();

  checkDeps();
  resolveModelAndEffort();

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
  const activeTool = TOOL || lib.readConfig(CONFIG_FILE, '.tool', DEFAULT_TOOL);
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
        logError('Run /compact then resume with: jonggrang work --resume');
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
      logInfo('Resume with: jonggrang work --resume');
      orchestration.failPhase(manifestPath, phaseNum, 'Awaiting human input (brainstorming)');
      process.exit(0);
    }

    // ── Build phase prompt(s) ─────────────────────────────────────
    // Most phases run a single agent. The simplify phase may split into
    // one fresh agent per changed file when the total diff is large
    // (see orchestration.planSimplify) — each unit is a separate run.
    let phaseUnits;
    if (phaseNum === orchestration.SIMPLIFY_PHASE) {
      const plan = orchestration.planSimplify(manifest, PROJECT_ROOT);
      if (plan.mode === 'per-file') {
        logInfo(`Simplify: total diff ~${plan.totalTokens} tokens > budget — splitting into ${plan.units.length} per-file agents`);
        phaseUnits = plan.units.map(u => ({ core: u.prompt, label: u.file }));
      } else {
        phaseUnits = [{ core: plan.prompt, label: null }];
      }
    } else {
      phaseUnits = [{ core: orchestration.buildPhaseContext(manifest, phaseNum), label: null }];
    }

    const agentsContent = lib.fileExists(paths.agentsFile)
      ? fs.readFileSync(paths.agentsFile, 'utf8') : '';
    const progressContent = lib.fileExists(paths.progressFile)
      ? fs.readFileSync(paths.progressFile, 'utf8').slice(-2000) : '';

    const outputDir = path.join(PROJECT_ROOT, '.jonggrang', '.output', 'features', featureId);
    fs.mkdirSync(outputDir, { recursive: true });

    const buildPrompt = (core) => [
      core,
      agentsContent ? `\n## Project Conventions (AGENTS.md)\n${agentsContent}` : '',
      progressContent ? `\n## Recent Learnings (progress.txt)\n${progressContent}` : '',
      `\n## Output Directory\nWrite all output files to: ${outputDir}/`,
    ].filter(Boolean).join('\n');

    if (DRY_RUN) {
      logInfo(`[DRY RUN] Phase ${phaseNum}: ${phaseUnits.length} agent run(s)`);
      orchestration.completePhase(manifestPath, phaseNum, { dry_run: true });
      manifest = orchestration.readManifest(manifestPath);
      continue;
    }

    // ── Run agent(s) ──────────────────────────────────────────────
    const trackOutputFiles = orchestration.OUTPUT_TRACKING_PHASES.has(phaseNum);
    const beforeSha = trackOutputFiles ? gitRevParse(PROJECT_ROOT) : null;

    let exitCode = 0;
    for (const unit of phaseUnits) {
      if (unit.label) logInfo(`  → simplify: ${unit.label}`);
      const result = await lib.runAgent(buildPrompt(unit.core), activeTool, activeMode, PROJECT_ROOT,
        { debug: DEBUG, model: MODEL, effort: EFFORT });
      exitCode = typeof result === 'object' ? (result.code || 0) : (result || 0);
      if (exitCode !== 0) break;
    }

    if (exitCode !== 0) {
      logWarn(`Phase ${phaseNum} agent exited with code ${exitCode}`);
      orchestration.failPhase(manifestPath, phaseNum, `Agent exit code: ${exitCode}`);
    } else {
      // Track output files via git diff (ground truth — not agent self-reporting)
      if (trackOutputFiles && beforeSha) {
        try {
          const files = orchestration.getChangedFiles(PROJECT_ROOT, beforeSha);
          if (files.length > 0) {
            orchestration.addOutputFiles(manifestPath, phaseNum, files);
            logInfo(`  tracked ${files.length} output file(s)`);
          }
        } catch (e) {
          logWarn(`output file tracking: ${e.message}`);
        }
      }
      orchestration.completePhase(manifestPath, phaseNum);
      logSuccess(`Phase ${phaseNum} complete`);
    }

    manifest = orchestration.readManifest(manifestPath);

    // Check if orchestration was failed/paused externally
    if (manifest.status === 'failed' || manifest.status === 'paused') {
      logWarn(`Orchestration ${manifest.status}. Resume with: jonggrang work --resume`);
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

function cmdWebTunnel(args) {
  const { spawnSync } = require('child_process');

  // SSH flags that consume the next argument
  const SSH_VALUE_FLAGS = new Set([
    '-b', '-D', '-E', '-e', '-F', '-I', '-i', '-J',
    '-l', '-m', '-o', '-p', '-Q', '-R', '-S', '-w', '-W',
  ]);

  let destination = null;
  let connectSpecs = null;
  const sshPassthrough = [];

  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx];
    if (arg === '-c') {
      // -c is our flag: comma-separated host:port specs
      connectSpecs = args[++idx];
    } else if (!arg.startsWith('-') && destination === null) {
      destination = arg;
    } else {
      sshPassthrough.push(arg);
      if (SSH_VALUE_FLAGS.has(arg) && idx + 1 < args.length) {
        sshPassthrough.push(args[++idx]);
      }
    }
    idx++;
  }

  if (!destination) {
    logError('Usage: jonggrang web tunnel [user@]host -c host:port,... [ssh-opts]');
    logError('  -c   comma-separated list of host:port to forward (local port = remote port)');
    logError('  All other ssh flags (e.g. -i, -p) are passed through unchanged.');
    process.exit(1);
  }

  // always forward jonggrang web dashboard port
  const forwardFlags = ['-L', '7777:host.docker.internal:7777'];
  if (connectSpecs) {
    for (const spec of connectSpecs.split(',')) {
      const s = spec.trim();
      const lastColon = s.lastIndexOf(':');
      if (lastColon === -1) {
        logError(`Invalid tunnel spec "${s}" — expected host:port`);
        process.exit(1);
      }
      const host = s.slice(0, lastColon);
      const port = s.slice(lastColon + 1);
      if (!port || isNaN(Number(port))) {
        logError(`Invalid port in tunnel spec "${s}"`);
        process.exit(1);
      }
      forwardFlags.push('-L', `${port}:${host}:${port}`);
    }
  }

  // default to tunnel container port unless -p already provided
  if (!sshPassthrough.includes('-p')) sshPassthrough.unshift('-p', '2222');

  const sshArgs = ['-N', ...forwardFlags, ...sshPassthrough, destination];
  logInfo(`ssh ${sshArgs.join(' ')}`);

  const result = spawnSync('ssh', sshArgs, { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

function cmdWeb() {
  const WEB_DIR = path.resolve(__dirname, '..');
  const serverFile = path.join(WEB_DIR, 'server.js');

  if (!lib.fileExists(serverFile)) {
    logError(`server.js not found at ${WEB_DIR}`);
    process.exit(1);
  }

  // Check if server dependencies are installed.
  // We check for express as the canonical indicator — if it's missing, run npm install.
  // Prefer fs.existsSync over require.resolve: the latter can fail spuriously under
  // global installs with symlinks, custom prefixes, or cached resolution failures.
  const expressIndex = path.join(WEB_DIR, 'node_modules', 'express', 'index.js');
  if (!lib.fileExists(expressIndex)) {
    logInfo('Installing web dependencies...');
    try {
      execSync('npm install --production', { cwd: WEB_DIR, stdio: 'inherit' });
    } catch {
      logError('npm install failed. Try running manually: cd "' + WEB_DIR + '" && npm install');
      process.exit(1);
    }
    // Verify after install
    if (!lib.fileExists(expressIndex)) {
      logError('express still missing after npm install. Check: ' + WEB_DIR);
      process.exit(1);
    }
  }

  // Check if client build exists
  const clientDir = path.join(WEB_DIR, 'client');
  const clientPackageJson = path.join(clientDir, 'package.json');
  const distPath = path.join(clientDir, 'dist', 'index.html');
  if (!lib.fileExists(distPath)) {
    if (!lib.fileExists(clientPackageJson)) {
      logError('client/package.json not found. Frontend cannot be built.');
      logInfo('Reinstall with: npm install -g jonggrang@latest');
      process.exit(1);
    }

    // Ensure client dependencies are installed before building
    const clientModules = path.join(clientDir, 'node_modules', '.package-lock.json');
    if (!lib.fileExists(clientModules)) {
      logInfo('Installing client dependencies...');
      try {
        execSync('npm install', { cwd: clientDir, stdio: 'inherit' });
      } catch {
        logError('npm install failed in client/. Try running manually.');
        process.exit(1);
      }
    }
    logInfo('Building frontend...');
    try {
      execSync('npm run build', { cwd: clientDir, stdio: 'inherit' });
    } catch {
      logError('Frontend build failed. Check client/ for errors.');
      process.exit(1);
    }
  }

  printWebBanner(WEB_HOST, WEB_PORT);

  // Run server.js in the foreground, exactly like `node server.js`:
  // stdio is inherited (logs stream to this terminal) and Ctrl+C stops it.
  const result = spawnSync('node', [serverFile], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      JONGGRANG_HOME: JONGGRANG_HOME,
      JONGGRANG_PROJECT_ROOT: PROJECT_ROOT,
      PORT: String(WEB_PORT),
      HOST: WEB_HOST,
    },
    stdio: 'inherit',
  });
  process.exit(result.status || 0);
}

// ============================================================
// INTERACTIVE MENU
// ============================================================

// Fallback menu using @clack/prompts (used when pi-tui is unavailable)
async function cmdMenuClack() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    cmdHelp();
    return;
  }

  intro('Jonggrang Interactive CLI');

  let running = true;
  let outroShown = false;

  while (running) {
    const hasPendingPlan = lib.fileExists(PLAN_FILE);
    const hasArchivedPlans = listAvailablePlans(path.dirname(PLAN_FILE)).length > 0;
    const choice = await select({
      message: 'What do you want to do?',
      initialValue: hasPendingPlan ? 'approve' : 'plan',
      options: [
        { value: 'init',      label: 'Initialize project' },
        { value: 'plan',      label: 'Plan feature             — Phase 1: generate draft plan.md' },
        ...(hasArchivedPlans ? [{ value: 'pick-plan', label: 'Pick existing plan        — view/edit/approve a saved plan' }] : []),
        { value: 'approve',   label: `Approve plan             — Phase 2: decompose to tasks${hasPendingPlan ? ' ◀ pending plan!' : ''}` },
        { value: 'work',      label: 'Start work loop          — execute tasks' },
        { value: 'status',    label: 'Show status board' },
        { value: 'manifest',  label: 'Inspect output manifest   — list files tracked per phase' },
        { value: 'review',    label: 'Run code review' },
        { value: 'web',       label: 'Launch web dashboard' },
        { value: 'exit',      label: 'Exit menu' },
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
            message: 'Feature description (Phase 1 — generates plan.md for review)',
            validate(value) {
              if (!value || !value.trim()) return 'Description is required.';
            },
          });
          if (isCancel(description)) { logWarn('Plan cancelled.'); continue; }
          checkDeps();
          await cmdPlan([description.trim()]);
          break;
        }
        case 'pick-plan': {
          checkDeps();
          await cmdPlan([]); // no description → triggers list picker
          break;
        }
        case 'approve': {
          checkDeps();
          await cmdApprove([]);
          break;
        }
        case 'work':
          checkDeps();
          await cmdWork();
          break;
        case 'status':
          cmdStatus();
          break;
        case 'manifest':
          cmdManifest([]);
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

          const prevPort = WEB_PORT;
          if (portAnswer.trim()) {
            const parsed = parseInt(portAnswer.trim(), 10);
            if (!Number.isNaN(parsed)) WEB_PORT = parsed;
          }
          cmdWeb();
          WEB_PORT = prevPort;
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

// Pi TUI menu loop — rich keyboard-navigable interface
async function cmdMenuTUI(runJonggrangTUI) {
  while (true) {
    const hasPendingPlan = lib.fileExists(PLAN_FILE);
    const hasArchivedPlans = listAvailablePlans(path.dirname(PLAN_FILE)).length > 0;

    const items = [
      { value: 'init',     label: 'init',      description: 'Initialize project' },
      { value: 'plan',     label: 'plan',       description: 'Plan a new feature (Phase 1)' },
      ...(hasArchivedPlans ? [{ value: 'pick-plan', label: 'pick-plan', description: 'Resume an archived plan' }] : []),
      { value: 'approve',  label: 'approve',    description: `Approve plan — Phase 2${hasPendingPlan ? ' ◀ pending!' : ''}` },
      { value: 'work',     label: 'work',        description: 'Execute tasks' },
      { value: 'status',   label: 'status',      description: 'Show project status board' },
      { value: 'review',   label: 'review',      description: 'Run code review' },
      { value: 'web',      label: 'web',          description: 'Launch web dashboard' },
      { value: 'exit',     label: 'exit',         description: 'Exit Jonggrang' },
    ];

    const choice = await runJonggrangTUI(items);
    if (!choice || choice === 'exit') break;

    try {
      switch (choice) {
        case 'init':
          await cmdInit();
          break;
        case 'plan': {
          const description = await text({
            message: 'Feature description (Phase 1 — generates plan.md for review)',
            validate(value) {
              if (!value || !value.trim()) return 'Description is required.';
            },
          });
          if (isCancel(description)) { logWarn('Plan cancelled.'); continue; }
          checkDeps();
          await cmdPlan([description.trim()]);
          break;
        }
        case 'pick-plan':
          checkDeps();
          await cmdPlan([]);
          break;
        case 'approve':
          checkDeps();
          await cmdApprove([]);
          break;
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
          if (isCancel(portAnswer)) { logWarn('Dashboard launch cancelled.'); continue; }
          const prevPort = WEB_PORT;
          if (portAnswer.trim()) {
            const parsed = parseInt(portAnswer.trim(), 10);
            if (!Number.isNaN(parsed)) WEB_PORT = parsed;
          }
          cmdWeb();
          WEB_PORT = prevPort;
          break;
        }
        default:
          logWarn('Unknown option.');
      }
    } catch (err) {
      logError((err && err.message) || String(err));
    }
  }
}

// Full-screen TUI menu — persistent session, plan input handled inline
async function cmdMenuFull(runJonggrangApp) {
  while (true) {
    const hasPendingPlan = lib.fileExists(PLAN_FILE);
    const hasArchivedPlans = listAvailablePlans(path.dirname(PLAN_FILE)).length > 0;

    const items = [
      { value: 'init',     label: 'init',    description: 'Initialize project' },
      { value: 'plan',     label: 'plan',    description: 'Plan a new feature (Phase 1)' },
      ...(hasArchivedPlans ? [{ value: 'pick-plan', label: 'pick-plan', description: 'Resume archived plan' }] : []),
      { value: 'approve',  label: 'approve', description: `Approve plan — Phase 2${hasPendingPlan ? ' ◀ pending!' : ''}` },
      { value: 'work',     label: 'work',    description: 'Execute tasks' },
      { value: 'status',   label: 'status',  description: 'Show project status' },
      { value: 'review',   label: 'review',  description: 'Run code review' },
      { value: 'agent',    label: 'agent',   description: 'Chat with AI agent (Pi)' },
      { value: 'web',      label: 'web',     description: 'Launch web dashboard' },
      { value: 'exit',     label: 'exit',    description: 'Exit Jonggrang' },
    ];

    const result = await runJonggrangApp({ items, planFile: PLAN_FILE, tasksFile: TASKS_FILE });
    if (!result || !result.choice || result.choice === 'exit') break;

    try {
      switch (result.choice) {
        case 'init':
          await cmdInit();
          break;
        case 'plan': {
          const description = result.planDescription;
          if (!description) { logWarn('Plan cancelled.'); continue; }
          checkDeps();
          await cmdPlan([description]);
          break;
        }
        case 'pick-plan':
          checkDeps();
          await cmdPlan([]);
          break;
        case 'approve':
          checkDeps();
          await cmdApprove([]);
          break;
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
        case 'agent':
          await cmdAgent();
          break;
        case 'web':
          cmdWeb();
          break;
        default:
          logWarn('Unknown option.');
      }
    } catch (err) {
      logError((err && err.message) || String(err));
    }
  }
}

// Entry point: try full Pi TUI, fall back to legacy TUI loop, then @clack/prompts
async function cmdMenu() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    cmdHelp();
    return;
  }
  try {
    const { runJonggrangApp, runJonggrangTUI } = require('../lib/tui');
    if (runJonggrangApp) {
      await cmdMenuFull(runJonggrangApp);
    } else {
      await cmdMenuTUI(runJonggrangTUI);
    }
  } catch {
    await cmdMenuClack();
  }
}

// ============================================================
// AGENT CHAT (jonggrang agent)
// ============================================================

// Descriptions shown in Pi's /help for each registered slash command
const AGENT_COMMAND_DESCRIPTIONS = {
  plan:    'Generate a plan  — usage: /plan <description>',
  approve: 'Approve plan → decompose into tasks',
  work:    'Execute tasks   — usage: /work [description]',
  status:  'Show project task board',
  review:  'Run code review',
};

// Spawn jonggrang CLI as a subprocess (inherits terminal so output is visible)
function spawnJonggrang(args) {
  return spawnSync(process.execPath, [process.argv[1], ...args], { stdio: 'inherit' });
}

async function cmdAgent() {
  // Must set BEFORE import + initTheme() — initTheme() calls getCustomThemesDir()
  // → getAgentDir() which reads the env var. Setting it after would fall back to ~/.pi/agent.
  applyAgentDirEnv();

  const { main, initTheme } = await import('@earendil-works/pi-coding-agent');
  initTheme();

  // Suspend Pi TUI, run a jonggrang subprocess, then resume Pi TUI.
  // Uses ctx.ui.custom() to obtain the live TUI instance so we can call
  // tui.stop() (exits raw mode, removes stdin listeners) before handing the
  // terminal to the subprocess, and tui.start() (re-enters raw mode, redraws)
  // after the subprocess exits.  Ctrl+C during the subprocess exits normally;
  // once tui.start() fires, Pi resumes as if nothing happened.
  function suspendTUIAndRun(ctx, spawnArgs) {
    return ctx.ui.custom((tui, _theme, _keybindings, done) => {
      // Schedule work AFTER this factory returns so Pi can register the overlay
      // first — calling done() before returning the component causes Pi to leave
      // the overlay stack in an inconsistent state.
      setImmediate(() => {
        tui.stop();
        try {
          spawnJonggrang(spawnArgs);
        } finally {
          tui.start();
        }
        done(undefined);
      });
      return { render: () => [], invalidate: () => {} };
    });
  }

  // Extension factory — registers /plan, /approve, /work, /status, /review
  const jonggrangExtension = (pi) => {
    pi.registerCommand('plan', {
      description: AGENT_COMMAND_DESCRIPTIONS.plan,
      handler: async (args, ctx) => {
        if (!args.trim()) {
          ctx.ui.notify('Usage: /plan <description>', 'warning');
          return;
        }
        await ctx.waitForIdle();
        await suspendTUIAndRun(ctx, ['plan', args.trim()]);
      },
    });

    pi.registerCommand('approve', {
      description: AGENT_COMMAND_DESCRIPTIONS.approve,
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        await suspendTUIAndRun(ctx, ['approve']);
      },
    });

    pi.registerCommand('work', {
      description: AGENT_COMMAND_DESCRIPTIONS.work,
      handler: async (args, ctx) => {
        await ctx.waitForIdle();
        await suspendTUIAndRun(ctx, ['work', ...(args.trim() ? [args.trim()] : [])]);
      },
    });

    pi.registerCommand('status', {
      description: AGENT_COMMAND_DESCRIPTIONS.status,
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        await suspendTUIAndRun(ctx, ['status']);
      },
    });

    pi.registerCommand('review', {
      description: AGENT_COMMAND_DESCRIPTIONS.review,
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        await suspendTUIAndRun(ctx, ['review']);
      },
    });

    // /config — Jonggrang settings TUI
    // Reads: ~/.jonggrang/settings.json (global) merged with .jonggrang/jonggrang.json (project)
    // Saves: project fields → .jonggrang/jonggrang.json, global fields → ~/.jonggrang/settings.json
    pi.registerCommand('config', {
      description: 'Configure Jonggrang settings (global ▸ ~/.jonggrang/settings.json, project ▸ .jonggrang/jonggrang.json)',
      handler: async (_args, ctx) => {
        const { SettingsList } = await import('@earendil-works/pi-tui');
        const { getSettingsListTheme } = await import('@earendil-works/pi-coding-agent');
        const jonggrangSettings = require('../lib/settings');

        const cwd = ctx.cwd || process.cwd();
        const merged = jonggrangSettings.loadMerged(cwd);

        const items = [
          {
            id: 'tool',
            label: 'Agent tool',
            description: 'AI agent used to execute tasks (project scope)',
            currentValue: merged.tool,
            values: ['jonggrang', 'claude', 'opencode'],
          },
          {
            id: 'autonomy',
            label: 'Autonomy mode',
            description: 'How much the agent asks before acting (project scope)',
            currentValue: merged.autonomy,
            values: ['autonomous', 'balanced', 'supervised'],
          },
        ];

        await ctx.ui.custom((_tui, _theme, _kb, done) => {
          const settingsList = new SettingsList(
            items,
            Math.min(items.length + 3, 12),
            getSettingsListTheme(),
            (id, newValue) => {
              jonggrangSettings.saveProjectField(cwd, id, newValue);
              ctx.ui.notify(`${id} = ${newValue}  (saved → .jonggrang/jonggrang.json)`, 'info');
            },
            () => done(undefined),
          );

          return {
            render:      (w) => settingsList.render(w),
            invalidate:  ()  => settingsList.invalidate(),
            handleInput: (d) => settingsList.handleInput(d),
          };
        });
      },
    });

    // Redirect skills/prompts to .jonggrang/ directories (only if they exist)
    pi.on('resources_discover', async (event) => {
      const cwd = event.cwd || process.cwd();
      const skillsPath  = path.join(cwd, '.jonggrang', 'skills');
      const promptsPath = path.join(cwd, '.jonggrang', 'prompts');
      return {
        skillPaths:  fs.existsSync(skillsPath)  ? [skillsPath]  : [],
        promptPaths: fs.existsSync(promptsPath) ? [promptsPath] : [],
        themePaths:  [],
      };
    });

  };

  // Load the security+workflow extension via --extension so Pi's jiti loader
  // transpiles the .ts file and wires all hooks (tool_call, tool_result, agent_end, etc.)
  const extPath = path.join(__dirname, '..', 'hooks', 'pi', 'jonggrang-extension.ts');
  const extArgs = fs.existsSync(extPath) ? ['--extension', extPath] : [];

  await main(extArgs, { extensionFactories: [jonggrangExtension] });
}

// ============================================================
// AUTH / PROVIDER COMMANDS
// ============================================================

function resolveAgentDir() {
  return path.join(os.homedir(), '.jonggrang', 'agent');
}

function resolveAuthPath() {
  return path.join(resolveAgentDir(), 'auth.json');
}

// ENV_AGENT_DIR is not re-exported from @earendil-works/pi-coding-agent's index.
// Derive it from Pi's package.json: APP_NAME = piConfig.name || "pi",
// ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`.
function getPiAgentDirEnvVar() {
  try {
    const piPkg = require('@earendil-works/pi-coding-agent/package.json');
    const appName = (piPkg.piConfig && piPkg.piConfig.name) || 'pi';
    return `${appName.toUpperCase()}_CODING_AGENT_DIR`;
  } catch {
    return 'PI_CODING_AGENT_DIR';
  }
}

function applyAgentDirEnv() {
  process.env[getPiAgentDirEnvVar()] = resolveAgentDir();
}
const API_KEY_PROVIDERS = [
  { id: 'anthropic',               name: 'Anthropic' },
  { id: 'openai',                  name: 'OpenAI' },
  { id: 'google',                  name: 'Google Gemini' },
  { id: 'opencode-go',             name: 'OpenCode Go' },
  { id: 'deepseek',                name: 'DeepSeek' },
  { id: 'mistral',                 name: 'Mistral' },
  { id: 'groq',                    name: 'Groq' },
  { id: 'xai',                     name: 'xAI (Grok)' },
  { id: 'openrouter',              name: 'OpenRouter' },
  { id: 'azure-openai-responses',  name: 'Azure OpenAI' },
  { id: 'cloudflare-ai-gateway',   name: 'Cloudflare AI Gateway' },
  { id: 'cloudflare-workers-ai',   name: 'Cloudflare Workers AI' },
  { id: 'fireworks',               name: 'Fireworks AI' },
  { id: 'huggingface',             name: 'Hugging Face' },
  { id: 'cerebras',                name: 'Cerebras' },
  { id: 'moonshotai',              name: 'Moonshot AI (Kimi)' },
  { id: 'kimi-coding',             name: 'Kimi Coding' },
];

async function cmdLogin() {
  applyAgentDirEnv(); // must be before any Pi import side-effects touch the fs
  const { AuthStorage, LoginDialogComponent, initTheme } = await import('@earendil-works/pi-coding-agent');
  const { TUI, ProcessTerminal } = await import('@earendil-works/pi-tui');
  const { runJonggrangTUI } = require('../lib/tui');

  initTheme();

  const authStorage = AuthStorage.create(resolveAuthPath());

  const oauthProviders = authStorage.getOAuthProviders();

  const items = [
    ...oauthProviders.map(p => ({ value: `oauth:${p.id}`, label: p.name, description: 'subscription (OAuth)' })),
    ...API_KEY_PROVIDERS.map(p => ({ value: `apikey:${p.id}`, label: p.name, description: 'API key' })),
  ];

  const choice = await runJonggrangTUI(items);
  if (!choice || choice === 'exit') return;

  if (choice.startsWith('oauth:')) {
    const providerId = choice.slice(6);
    const providerName = oauthProviders.find(p => p.id === providerId)?.name || providerId;

    await new Promise((resolve) => {
      let settled = false;
      const done = (ok, msg) => {
        if (settled) return;
        settled = true;
        if (ok) console.log(`\n✓ Logged in to ${providerName}`);
        else logError(`Login failed${msg ? ': ' + msg : ''}`);
        resolve();
      };

      const terminal = new ProcessTerminal();
      const tui = new TUI(terminal);

      const dialog = new LoginDialogComponent(tui, providerId, (success, message) => {
        tui.stop();
        done(success, message);
      });

      tui.addChild(dialog);
      tui.setFocus(dialog);
      tui.start();

      authStorage.login(providerId, {
        onAuth:            (info) => dialog.showAuth(info.url, info.instructions),
        onPrompt:          async (prompt) => dialog.showPrompt(prompt.message, prompt.placeholder),
        onProgress:        (msg) => dialog.showProgress(msg),
        onManualCodeInput: () => dialog.showManualInput('Paste the authorization code:'),
        signal:            dialog.signal,
      }).then(() => {
        tui.stop();
        done(true);
      }).catch((err) => {
        if (!dialog.signal.aborted) {
          tui.stop();
          done(false, err.message);
        } else {
          tui.stop();
          resolve();
        }
      });
    });

  } else if (choice.startsWith('apikey:')) {
    const providerId = choice.slice(7);
    const providerName = API_KEY_PROVIDERS.find(p => p.id === providerId)?.name || providerId;

    const key = await text({
      message: `Enter API key for ${providerName}:`,
      validate(value) { if (!value || !value.trim()) return 'API key is required.'; },
    });
    if (isCancel(key)) { logWarn('Login cancelled.'); return; }

    authStorage.set(providerId, { type: 'api_key', key: key.trim() });
    console.log(`✓ API key saved for ${providerName}`);
  }
}

async function cmdLogout() {
  applyAgentDirEnv();
  const { AuthStorage } = await import('@earendil-works/pi-coding-agent');
  const { runJonggrangTUI } = require('../lib/tui');

  const authStorage = AuthStorage.create(resolveAuthPath());

  const configured = authStorage.list();
  if (configured.length === 0) {
    console.log('No providers configured. Use `jonggrang login` to add one.');
    return;
  }

  const items = configured.map(id => {
    const status = authStorage.getAuthStatus(id);
    return { value: id, label: id, description: status.source ? `via ${status.source}` : 'configured' };
  });

  const choice = await runJonggrangTUI(items);
  if (!choice || choice === 'exit') return;

  authStorage.logout(choice);
  console.log(`✓ Logged out from ${choice}`);
}

async function cmdModel() {
  applyAgentDirEnv();
  const { AuthStorage, ModelRegistry } = await import('@earendil-works/pi-coding-agent');
  const { runJonggrangTUI } = require('../lib/tui');

  const authStorage = AuthStorage.create(resolveAuthPath());
  const modelRegistry = ModelRegistry.create(authStorage);

  let models = modelRegistry.getAvailable();
  if (models.length === 0) {
    console.log('No configured providers found — showing all models. Run `jonggrang login` first.');
    models = modelRegistry.getAll();
  }
  if (models.length === 0) {
    logError('No models available.');
    return;
  }

  const items = models.map(m => ({
    value: `${m.provider}::${m.id}`,
    label: m.name || m.id,
    description: String(m.provider),
  }));

  const choice = await runJonggrangTUI(items);
  if (!choice || choice === 'exit') return;

  const sepIdx = choice.indexOf('::');
  const provider = choice.slice(0, sepIdx);
  const modelId  = choice.slice(sepIdx + 2);

  if (lib.fileExists(CONFIG_FILE)) {
    const cfg = lib.readJSON(CONFIG_FILE) || {};
    cfg.provider = provider;
    cfg.model = modelId;
    lib.writeJSON(CONFIG_FILE, cfg);
    console.log(`✓ Model set to ${modelId} (${provider})`);
  } else {
    logWarn('Project not initialized — run `jonggrang init` first to save this selection.');
    console.log(`  Selected: ${modelId} (${provider})`);
  }
}

// ============================================================
// TASK CLI
// ============================================================

function cmdTask(args) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    cmdTaskHelp();
    return;
  }

  // Parse task-specific flags
  const flags = {};
  const positional = [];
  let j = 0;
  while (j < subArgs.length) {
    if (subArgs[j] === '--title')                                   { flags.title = subArgs[++j]; }
    else if (subArgs[j] === '--desc' || subArgs[j] === '--description') { flags.description = subArgs[++j]; }
    else if (subArgs[j] === '--priority')                           { flags.priority = parseInt(subArgs[++j], 10); }
    else if (subArgs[j] === '--status')                             { flags.status = subArgs[++j]; }
    else if (subArgs[j] === '--skill')                              { flags.skill = subArgs[++j]; }
    else if (subArgs[j] === '--blocked-by')                         { flags.blocked_by = subArgs[++j].split(','); }
    else if (subArgs[j] === '--files')                              { flags.files = subArgs[++j].split(','); }
    else if (subArgs[j] === '--reason')                             { flags.reason = subArgs[++j]; }
    else if (subArgs[j] === '--feature')                            { flags.feature = subArgs[++j]; }
    else if (subArgs[j] === '--input')                              { flags.input = subArgs[++j]; }
    else if (subArgs[j] === '--pretty')                             { flags.pretty = true; }
    else if (subArgs[j] === '--json')                               { flags.json = true; }
    else { positional.push(subArgs[j]); }
    j++;
  }

  const isTTY = process.stdout.isTTY;
  const pretty = flags.pretty || (isTTY && !flags.json);

  // Resolve the per-feature tasks file. Three resolution modes:
  //  - task-id commands (show/update/done/block/remove): auto-lookup the
  //    feature via findTaskFeature; --feature overrides.
  //  - no-task-id commands (add/import/next): --feature if given, else
  //    resolveActiveFeature (most-recent-incomplete).
  //  - list: cross-feature (getAllTasks), no single file.
  function resolveTasksFile(taskId) {
    let fid = flags.feature;
    if (!fid && taskId) fid = lib.findTaskFeature(PROJECT_ROOT, taskId);
    if (!fid) fid = lib.resolveActiveFeature(PROJECT_ROOT);
    if (!fid) throw new Error('No active feature found. Run `jonggrang plan` + `jonggrang approve` first, or pass --feature <id>.');
    return lib.tasksFileFor(PROJECT_ROOT, fid);
  }
  function resolveFeatureId(taskId) {
    let fid = flags.feature;
    if (!fid && taskId) fid = lib.findTaskFeature(PROJECT_ROOT, taskId);
    if (!fid) fid = lib.resolveActiveFeature(PROJECT_ROOT);
    if (!fid) throw new Error('No active feature found. Run `jonggrang plan` + `jonggrang approve` first, or pass --feature <id>.');
    return fid;
  }

  try {
    switch (subcommand) {
      case 'list':   taskList(flags, positional, pretty); break;
      case 'show':   taskShow(flags, positional, pretty); break;
      case 'add':    taskAdd(flags, positional, pretty); break;
      case 'import': taskImport(flags, positional, pretty); break;
      case 'update': taskUpdate(flags, positional, pretty); break;
      case 'done':   taskDone(flags, positional, pretty); break;
      case 'block':  taskBlock(flags, positional, pretty); break;
      case 'remove': taskRemove(flags, positional, pretty); break;
      case 'next':   taskNext(flags, positional, pretty); break;
      default:
        logError(`Unknown task subcommand: ${subcommand}`);
        console.log("Run 'jonggrang task help' for usage.");
        process.exit(1);
    }
  } catch (err) {
    if (pretty) {
      logError(err.message);
    } else {
      console.log(JSON.stringify({ error: err.message }));
    }
    process.exit(1);
  }
}

// ── Task handlers ─────────────────────────────────────────────

function taskList(flags, positional, pretty) {
  safeCheckConfig();
  // Cross-feature view: merge all feature task files.
  const data = lib.getAllTasks(PROJECT_ROOT);
  let tasks = data.tasks || [];

  const statusFilter = positional[0] || flags.status;
  if (statusFilter) tasks = tasks.filter(t => t.status === statusFilter);

  if (pretty) {
    const completed = tasks.filter(t => t.status === 'completed').length;
    console.log(`\n${BOLD}Tasks: ${completed}/${tasks.length} completed${NC}\n`);
    // Check if tasks span multiple features
    const featureIds = new Set(tasks.map(t => t.feature_id).filter(Boolean));
    const multiFeature = featureIds.size > 1;
    console.log(`${BOLD}${'ID'.padEnd(11)} ${'Status'.padEnd(12)} ${'Pri'.padEnd(4)} ${multiFeature ? 'Feature'.padEnd(22) : ''}Title${NC}`);
    console.log('-'.repeat(multiFeature ? 87 : 65));
    for (const task of tasks) {
      let color = NC;
      if (task.status === 'completed') color = GREEN;
      else if (task.status === 'in_progress') color = YELLOW;
      else if (task.status === 'blocked') color = RED;
      const featureCol = multiFeature ? (task.feature_id || '').slice(0, 21).padEnd(22) : '';
      console.log(`${color}${(task.id || '').padEnd(11)} ${(task.status || '').padEnd(12)} ${String(task.priority || '-').padEnd(4)} ${featureCol}${task.title || ''}${NC}`);
    }
    if (tasks.length === 0) console.log('  (no tasks)');
  } else {
    console.log(JSON.stringify(tasks));
  }
}

function taskShow(flags, positional, pretty) {
  safeCheckConfig();
  const taskId = positional[0];
  if (!taskId) throw new Error('Task ID required. Usage: jonggrang task show <task-id>');
  const tasksFile = resolveTasksFile(taskId);
  const task = lib.getTask(tasksFile, taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  if (pretty) {
    console.log(`\n${BOLD}${task.id}${NC} — ${task.title}`);
    console.log(`Status:      ${task.status}`);
    console.log(`Priority:    ${task.priority}`);
    if (task.feature_id) {
      const archivePlan = path.join(PROJECT_ROOT, '.jonggrang', '.output', 'features', task.feature_id, 'plan.md');
      let featureLabel = task.feature_id;
      if (lib.fileExists(archivePlan)) {
        const fm = parsePlanFrontmatter(fs.readFileSync(archivePlan, 'utf8'));
        featureLabel = `${fm.feature || task.feature_id}${fm.description ? ' — ' + fm.description : ''}`;
      }
      console.log(`Feature:     ${featureLabel}  ${DIM}(${task.feature_id})${NC}`);
      console.log(`Plan:        .jonggrang/.output/features/${task.feature_id}/plan.md`);
    }
    console.log(`Skill:       ${task.skill || '(none)'}`);
    console.log(`Blocked by:  ${(task.blocked_by || []).join(', ') || '(none)'}`);
    console.log(`Files:       ${(task.files || []).join(', ') || '(none)'}`);
    console.log(`Passes:      ${task.passes}`);
    if (task.description) console.log(`\nDescription:\n${task.description}`);
    if (task.error_log && task.error_log.length > 0) {
      console.log(`\nError log:`);
      for (const err of task.error_log) console.log(`  - ${err}`);
    }
  } else {
    console.log(JSON.stringify(task));
  }
}

function taskAdd(flags, positional, pretty) {
  safeCheckConfig();
  const title = flags.title || positional[0];
  if (!title) throw new Error('Title required. Usage: jonggrang task add --title "..." or jonggrang task add "title"');

  const featureId = resolveFeatureId();
  const task = lib.addTask(PROJECT_ROOT, featureId, {
    title,
    description: flags.description || '',
    priority: flags.priority,
    skill: flags.skill || null,
    blocked_by: flags.blocked_by || [],
    files: flags.files || [],
  });

  if (pretty) {
    logSuccess(`Created ${task.id}: ${task.title}`);
  } else {
    console.log(JSON.stringify(task));
  }
}

function taskImport(flags, positional, pretty) {
  safeCheckConfig();

  let raw;
  if (flags.input) {
    raw = flags.input;
  } else if (positional[0]) {
    const filePath = path.resolve(positional[0]);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    raw = fs.readFileSync(filePath, 'utf8');
  } else if (!process.stdin.isTTY) {
    raw = fs.readFileSync('/dev/stdin', 'utf8');
  } else {
    throw new Error('Provide tasks via --json \'[...]\', a file path, or stdin.');
  }

  let taskDataArray;
  try {
    taskDataArray = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
  if (!Array.isArray(taskDataArray)) throw new Error('Input must be a JSON array of tasks.');
  if (taskDataArray.length === 0) throw new Error('Task array is empty.');

  const featureId = resolveFeatureId();
  const created = lib.addTasksBulk(PROJECT_ROOT, featureId, taskDataArray);

  if (pretty) {
    logSuccess(`Imported ${created.length} task(s):`);
    for (const t of created) console.log(`  ${t.id}: ${t.title}`);
  } else {
    console.log(JSON.stringify(created));
  }
}

function taskUpdate(flags, positional, pretty) {
  safeCheckConfig();
  const taskId = positional[0];
  if (!taskId) throw new Error('Task ID required. Usage: jonggrang task update <task-id> --status in_progress');

  const updates = {};
  if (flags.title !== undefined)       updates.title = flags.title;
  if (flags.description !== undefined) updates.description = flags.description;
  if (flags.priority !== undefined)    updates.priority = flags.priority;
  if (flags.status !== undefined)      updates.status = flags.status;
  if (flags.skill !== undefined)       updates.skill = flags.skill;
  if (flags.blocked_by !== undefined)  updates.blocked_by = flags.blocked_by;
  if (flags.files !== undefined)       updates.files = flags.files;

  if (Object.keys(updates).length === 0) throw new Error('No updates provided. Use flags like --status, --title, --priority, etc.');

  const tasksFile = resolveTasksFile(taskId);
  const task = lib.updateTask(tasksFile, taskId, updates);

  if (pretty) {
    logSuccess(`Updated ${task.id}: ${task.title}`);
  } else {
    console.log(JSON.stringify(task));
  }
}

function taskDone(flags, positional, pretty) {
  safeCheckConfig();
  const taskId = positional[0];
  if (!taskId) throw new Error('Task ID required. Usage: jonggrang task done <task-id>');

  const tasksFile = resolveTasksFile(taskId);
  lib.markTaskDone(tasksFile, taskId);
  const task = lib.getTask(tasksFile, taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  if (pretty) {
    logSuccess(`Completed ${task.id}: ${task.title}`);
  } else {
    console.log(JSON.stringify(task));
  }
}

function taskBlock(flags, positional, pretty) {
  safeCheckConfig();
  const taskId = positional[0];
  if (!taskId) throw new Error('Task ID required. Usage: jonggrang task block <task-id> [--reason "..."]');

  const tasksFile = resolveTasksFile(taskId);
  lib.updateTask(tasksFile, taskId, { status: 'blocked' });

  if (flags.reason) {
    const data = lib.getTasks(tasksFile);
    const t = data.tasks.find(x => x.id === taskId);
    if (t) {
      if (!t.error_log) t.error_log = [];
      t.error_log.push(`[${new Date().toISOString()}] Blocked: ${flags.reason}`);
      lib.writeJSON(tasksFile, data);
    }
  }

  const task = lib.getTask(tasksFile, taskId);
  if (pretty) {
    logWarn(`Blocked ${task.id}: ${task.title}${flags.reason ? ' — ' + flags.reason : ''}`);
  } else {
    console.log(JSON.stringify(task));
  }
}

function taskRemove(flags, positional, pretty) {
  safeCheckConfig();
  const taskId = positional[0];
  if (!taskId) throw new Error('Task ID required. Usage: jonggrang task remove <task-id>');

  const tasksFile = resolveTasksFile(taskId);
  const removed = lib.removeTask(tasksFile, taskId);
  if (pretty) {
    logSuccess(`Removed ${removed.id}: ${removed.title}`);
  } else {
    console.log(JSON.stringify(removed));
  }
}

function taskNext(flags, positional, pretty) {
  safeCheckConfig();
  const featureId = resolveFeatureId();
  const tasksFile = lib.tasksFileFor(PROJECT_ROOT, featureId);
  const nextId = lib.getNextTask(tasksFile);
  if (!nextId) {
    if (pretty) {
      logInfo('No eligible tasks (all completed or blocked).');
    } else {
      console.log(JSON.stringify(null));
    }
    return;
  }
  const task = lib.getTask(tasksFile, nextId);
  if (pretty) {
    console.log(`\nNext task: ${BOLD}${task.id}${NC} — ${task.title}`);
    console.log(`Priority: ${task.priority}  |  Status: ${task.status}`);
  } else {
    console.log(JSON.stringify(task));
  }
}

function cmdTaskHelp() {
  console.log(`Jonggrang Task Manager

Usage: jonggrang task <subcommand> [options]

Subcommands:
  list [status]              List all tasks (optionally filter by status)
  show <task-id>             Show task details
  add --title "..." [opts]   Add a single task
  import [opts]              Import multiple tasks from a JSON array (bulk add)
  update <task-id> [opts]    Update task fields
  done <task-id>             Mark task as completed
  block <task-id> [--reason] Mark task as blocked
  remove <task-id>           Remove a task
  next                       Show the next eligible task

Add/Update flags:
  --title <title>            Task title
  --desc <description>       Task description
  --priority <n>             Priority (1 = highest)
  --status <status>          pending|in_progress|completed|blocked|waiting|skipped
  --skill <skill>            Skill name
  --blocked-by <id,id,...>   Comma-separated dependency task IDs
  --files <path,path,...>    Comma-separated file paths

Import flags:
  --input '<array>'          JSON array of task objects (inline string)
  <file>                     Path to a JSON file containing a task array
  (stdin)                    Pipe a JSON array via stdin

Output flags:
  --json                     Force JSON output (default in non-TTY)
  --pretty                   Force human-readable output

Examples:
  jonggrang task list
  jonggrang task list pending
  jonggrang task add --title "Add login page" --priority 1
  jonggrang task add "Quick task title"
  jonggrang task import --input '[{"id":"task-001","title":"Setup CI","priority":1},{"id":"task-002","title":"Write tests","priority":2,"blocked_by":["task-001"]}]'
  jonggrang task import tasks.json
  echo '[{"title":"Fix bug"}]' | jonggrang task import
  jonggrang task update task-003 --status in_progress
  jonggrang task update task-003 --blocked-by task-001,task-002
  jonggrang task done task-003
  jonggrang task block task-004 --reason "Waiting for API spec"
  jonggrang task remove task-005
  jonggrang task show task-001
  jonggrang task next`);
}

// ============================================================
// MANIFEST COMMAND
// ============================================================

function cmdManifest(args) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    cmdManifestHelp();
    return;
  }

  // Parse flags common across subcommands
  const flags = {};
  const positional = [];
  let j = 0;
  while (j < subArgs.length) {
    if (subArgs[j] === '--feature')        { flags.feature = subArgs[++j]; }
    else if (subArgs[j] === '--phase')     { flags.phase = parseInt(subArgs[++j], 10); }
    else if (subArgs[j] === '--files')     { flags.files = subArgs[++j]; }
    else if (subArgs[j] === '--absolute')  { flags.absolute = true; }
    else if (subArgs[j] === '--json')      { flags.json = true; }
    else { positional.push(subArgs[j]); }
    j++;
  }

  const isTTY = process.stdout.isTTY;
  const pretty = !flags.json && isTTY;

  try {
    switch (subcommand) {
      case 'list': manifestList(flags, positional, pretty); break;
      case 'show': manifestShow(flags, positional, pretty); break;
      case 'add':  manifestAdd(flags, positional, pretty); break;
      default:
        // Treat bare feature ID as "show <id>"
        manifestShow(flags, [subcommand, ...positional], pretty);
    }
  } catch (err) {
    if (pretty) {
      logError(err.message);
    } else {
      console.log(JSON.stringify({ error: err.message }));
    }
    process.exit(1);
  }
}

function manifestAdd(flags, _positional, pretty) {
  const featureId = flags.feature;
  if (!featureId) throw new Error('--feature <id> required');
  const phaseNum = flags.phase;
  if (!phaseNum || isNaN(phaseNum)) throw new Error('--phase <num> required (e.g. --phase 8)');

  let files;
  try {
    files = JSON.parse(flags.files || '[]');
  } catch (err) {
    throw new Error(`--files must be valid JSON: ${err.message}`);
  }
  if (!Array.isArray(files)) throw new Error('--files must be a JSON array');

  const manifestPath = orchestration.getManifestPath(PROJECT_ROOT, featureId);
  if (!require('fs').existsSync(manifestPath)) {
    throw new Error(`Feature not found: ${featureId}\nExpected manifest at: ${manifestPath}`);
  }
  const stored = orchestration.addOutputFiles(manifestPath, phaseNum, files);

  if (pretty) {
    logSuccess(`Added ${stored.length} file(s) to phase ${phaseNum} of feature ${featureId}`);
    for (const f of stored) {
      console.log(`  ${f.path} [${f.type || 'output'}${f.size ? `, ${f.size}b` : ''}]`);
    }
  } else {
    console.log(JSON.stringify({ added: stored.length, files: stored }));
  }
}

function manifestList(flags, _positional, pretty) {
  const manifests = orchestration.listManifests(PROJECT_ROOT);

  if (!pretty) {
    console.log(JSON.stringify(manifests.map(({ featureId, manifest: m }) => {
      const fileCount = Object.values(m.phases || {}).reduce((n, p) => n + (p.output_files ? p.output_files.length : 0), 0);
      return { feature_id: featureId, description: m.description, work_type: m.work_type, status: m.status, updated_at: m.updated_at, file_count: fileCount };
    })));
    return;
  }

  console.log(`\n${BOLD}Feature Manifests (${manifests.length})${NC}\n`);
  if (manifests.length === 0) {
    console.log('  (no manifests found — run: jonggrang work "description")');
    return;
  }
  const W = { id: 30, status: 12, type: 8, files: 6, updated: 10 };
  console.log(`${BOLD}${'Feature ID'.padEnd(W.id)} ${'Status'.padEnd(W.status)} ${'Type'.padEnd(W.type)} ${'Files'.padEnd(W.files)} ${'Updated'.padEnd(W.updated)} Description${NC}`);
  console.log('-'.repeat(W.id + W.status + W.type + W.files + W.updated + 16));
  for (const { featureId, manifest: m } of manifests) {
    const color = m.status === 'completed' ? GREEN : m.status === 'failed' ? RED : YELLOW;
    const updated = (m.updated_at || '').slice(0, 10);
    const fileCount = Object.values(m.phases || {}).reduce((n, p) => n + (p.output_files ? p.output_files.length : 0), 0);
    console.log(`${featureId.slice(0, W.id - 1).padEnd(W.id)} ${color}${(m.status || '').padEnd(W.status)}${NC} ${(m.work_type || '').padEnd(W.type)} ${String(fileCount).padEnd(W.files)} ${updated.padEnd(W.updated)} ${m.description || ''}`);
  }
  console.log('');
}

function manifestShow(flags, positional, pretty) {
  let featureId = flags.feature || positional[0];
  let manifestPath;

  if (featureId) {
    manifestPath = orchestration.getManifestPath(PROJECT_ROOT, featureId);
  } else {
    const found = orchestration.findIncompleteManifest(PROJECT_ROOT);
    if (found) {
      manifestPath = found.manifestPath;
      featureId = found.featureId;
    } else {
      const all = orchestration.listManifests(PROJECT_ROOT);
      if (all.length === 0) throw new Error('No manifests found. Run: jonggrang work "description"');
      manifestPath = all[0].manifestPath;
      featureId = all[0].featureId;
    }
  }

  const manifest = orchestration.readManifest(manifestPath);
  if (!manifest) throw new Error(`Manifest not found for feature: ${featureId}\nExpected: ${manifestPath}`);

  if (!pretty) {
    // Resolve absolute paths if requested
    if (flags.absolute) {
      for (const phaseNum of Object.keys(manifest.phases || {})) {
        const phase = manifest.phases[phaseNum];
        if (Array.isArray(phase.output_files)) {
          phase.output_files = phase.output_files.map(f => ({
            ...f,
            path: f.path ? path.resolve(PROJECT_ROOT, f.path) : f.path,
          }));
        }
      }
    }
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const statusColor = manifest.status === 'completed' ? GREEN :
    manifest.status === 'failed' ? RED : YELLOW;

  console.log(`\n${BOLD}Feature: ${manifest.description}${NC}`);
  console.log(`ID:       ${featureId}`);
  console.log(`Status:   ${statusColor}${manifest.status}${NC}`);
  console.log(`Type:     ${manifest.work_type}`);
  console.log(`Updated:  ${manifest.updated_at ? manifest.updated_at.slice(0, 19).replace('T', ' ') : 'unknown'}`);
  console.log('');

  const phasesWithFiles = Object.entries(manifest.phases || {})
    .filter(([, p]) => Array.isArray(p.output_files) && p.output_files.length > 0);

  if (phasesWithFiles.length === 0) {
    console.log(`  ${YELLOW}No output files tracked yet.${NC}`);
    console.log(`  (tracking applies to phases 8 implementation, 12 code-quality, 14 testing)`);
  } else {
    console.log(`${BOLD}Output files by phase:${NC}`);
    for (const [num, phase] of phasesWithFiles) {
      const phaseStatus = phase.status === 'completed' ? `${GREEN}✓${NC}` : `${YELLOW}~${NC}`;
      console.log(`\n  ${phaseStatus} Phase ${num} — ${phase.name}`);
      for (const f of phase.output_files) {
        const p = flags.absolute ? path.resolve(PROJECT_ROOT, f.path) : f.path;
        const size = f.size ? ` (${f.size}b)` : '';
        console.log(`    ${p}${size}  [${f.type || 'output'}]`);
      }
    }
  }
  console.log('');
}

function cmdManifestHelp() {
  console.log(`jonggrang manifest — inspect output-file tracking for orchestration features

Usage: jonggrang manifest [subcommand] [options]

Subcommands:
  (none)                 Show active/most-recent manifest
  list                   List all feature manifests
  show [feature-id]      Show manifest with output files per phase
  add                    Record output files into a manifest (used by hooks)

Options (show/list):
  --feature <id>         Target feature ID
  --absolute             Resolve file paths to absolute
  --json                 Machine-readable JSON output

Options (add — for hooks):
  --feature <id>         Feature ID (required)
  --phase <num>          Phase number (required, e.g. 8)
  --files '<json>'       JSON array of file entries (required)
                         e.g. '[{"path":"src/foo.js","type":"code"}]'
  --json                 Output JSON result

Examples:
  jonggrang manifest                          # show active feature
  jonggrang manifest list                     # all features
  jonggrang manifest show feat-abc123         # specific feature
  jonggrang manifest show feat-abc123 --absolute
  jonggrang manifest add --feature feat-abc123 --phase 8 --files '[{"path":"src/x.js","type":"code"}]'
`);
}

// ============================================================
// HELP
// ============================================================

function cmdHelp() {
  console.log(`Jonggrang — AI Development Workflow Orchestrator

Usage: jonggrang <command> [options]

Commands:
  init                    Setup project (interactive or with flags)
  plan <description>      Phase 1 — generate human-readable .jonggrang/plan.md for review
  plan <description> --yes  Plan + auto-approve + decompose to tasks in one shot
  approve                 Phase 2 — decompose approved plan.md into tasks (after review)
  work [description]      Execute tasks — with description runs plan → approve → execute
  work --resume           Resume incomplete pipeline from last phase
  plan --update <desc>    Update existing plan (preserves completed tasks)
  bug "description"       Report a bug → append to bugs.md + optionally create task
  bug list                List all bug reports (all features)
  bug convert             AI converts open bugs → tasks (batch)
  status                  Show pipeline state + task board
  review                  Run code review
  task <subcommand>       Manage tasks (list, add, update, done, block, remove, show, next)
  manifest [sub]          Inspect output-file manifests (list, show, add)
  agent                   Start interactive chat with the AI agent (Pi TUI)
  login                   Add provider credentials (OAuth subscription or API key)
  logout                  Remove provider credentials
  model                   Select AI model for jonggrang engine
  web                     Start web dashboard (port 7777, Ctrl+C to stop)
  menu                    Interactive menu launcher
  bot-reviewer <sub>      Automated MR review bot
    bot-reviewer gitlab     Start GitLab MR review bot (polls for new MRs)
    bot-reviewer settings   Configure token, repos, and Anthropic API key
  issues <subcommand>     Import GitHub/GitLab issues (feature #55)
    issues list             List issues from configured sources or --repo
    issues pickup <p> <r> <n>  Generate a plan from an issue in this project
  version                 Show version

  # Backward compat (routes to work):
  orchestrate <desc>      Alias for: jonggrang work "<desc>"
  orchestrate --resume    Resume incomplete pipeline

Work type auto-detection:
  BUGFIX / SMALL          Work loop only (fast)
  MEDIUM                  Work loop + reviewer quality pass
  LARGE                   Work loop + reviewer + test-lead + tester + final

Init flags (bypass wizard):
  --name <name>           Project name
  --tool <tool>           jonggrang | claude | opencode (default: jonggrang) — all tools always set up
  --autonomy <mode>       supervised | balanced | autonomous
  --force                 Overwrite existing jonggrang.json
  (stack, type, testing, ci are auto-detected from the project)

Work / Plan / Review flags:
  --mode <mode>           supervised | balanced | autonomous
  --tool <tool>           Override AI tool (jonggrang | claude | opencode)
  --model <model>         Pin model for the spawned backend agent (see backend table below)
  --effort <level>        Pin reasoning effort (see backend table below)
  --task <task-id>        Work on specific task only
  --max-iterations <n>    Max iterations (default: unlimited)
  --branch <name>         Feature branch name
  --dry-run               Preview prompts, no execution
  --debug                 Dump raw JSON from opencode/claude to stderr (diagnose stuck agents)
  --skip-gates            Skip quality gates even for MEDIUM/LARGE

--model / --effort backend mapping:
  --tool claude:     --model opus|sonnet|haiku|best|<full-id>   --effort low|medium|high|max|xhigh
  --tool opencode:   --model anthropic/claude-sonnet-4-5-20250929  --effort high  (→ --variant)
  --tool jonggrang:  --model anthropic/claude-sonnet-4-5  --effort high  (→ SDK thinkingLevel)

Resolution order: --model flag > JONGGRANG_MODEL env > tools.<tool>.model in jonggrang.json > backend default

Examples:
  jonggrang init
  jonggrang plan "add JWT auth"             # Phase 1: generate plan.md, review it
  jonggrang plan "add JWT auth" --deep      # deep mode: 3-phase analysis → enriched plan
  jonggrang approve                         # Phase 2: decompose plan.md → tasks
  jonggrang work                            # execute tasks (after approve)
  jonggrang plan "add JWT auth" --yes       # plan + auto-approve + tasks in one shot
  jonggrang work "add JWT auth" --yes       # full pipeline: plan → approve → execute
  jonggrang work "add JWT auth" --deep --yes  # deep mode full pipeline
  jonggrang work --task task-003            # run specific task only
  jonggrang work --ignore-plan              # execute tasks, skip pending plan warning

  # Pin model per-invocation (composes with --tool):
  jonggrang plan "add auth" --tool claude --model opus --effort xhigh
  jonggrang work --tool opencode --model anthropic/claude-opus-4-7 --effort high
  jonggrang work --tool jonggrang --model anthropic/claude-sonnet-4-5 --effort medium
  jonggrang bug "null pointer on POST /hello"   # report a bug (interactive feature picker)
  jonggrang bug list                        # list all bugs across features
  jonggrang bug convert                     # AI converts open bugs → tasks
  jonggrang bug convert --feature add-hello-endpoint-abc12345
  jonggrang status                          # pipeline + task board
  jonggrang web                             # visual dashboard
  jonggrang bot-reviewer settings           # configure GitLab token + repos
  jonggrang bot-reviewer gitlab             # start MR review bot`);
}

// ============================================================
// ISSUES — import GitHub/GitLab issues (feature #55)
// ============================================================

async function cmdIssues(args) {
  const issueProviders = require('../lib/issue-providers');
  const webState = require('../lib/web-state');
  const sub = args[0];

  function tokenFor(provider) {
    let t = {};
    try { t = webState.getGitTokens(); } catch {}
    if (provider === 'github') return t.GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
    if (provider === 'gitlab') return t.GITLAB_TOKEN || process.env.GITLAB_TOKEN || null;
    return null;
  }

  function flag(name, def) {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
  }

  if (sub === 'list') {
    const provider = flag('--provider', null);
    const repoFlag = flag('--repo', null);
    const state = flag('--state', 'open');
    const limit = parseInt(flag('--limit', '30'), 10);

    let targets = [];
    if (repoFlag && provider) {
      targets = [{ provider, repo: repoFlag }];
    } else {
      let sources = { github: [], gitlab: [] };
      try { sources = webState.getIssueSources(); } catch {}
      for (const p of ['github', 'gitlab']) {
        if (provider && provider !== p) continue;
        for (const r of sources[p]) targets.push({ provider: p, repo: r });
      }
    }
    if (!targets.length) {
      logError('No repos. Use --provider <github|gitlab> --repo owner/repo, or configure Issue Sources in the dashboard.');
      process.exit(1);
    }
    for (const t of targets) {
      const token = tokenFor(t.provider);
      if (!token) { logError(`No ${t.provider} token (set GH_TOKEN/GITLAB_TOKEN or configure in dashboard).`); continue; }
      try {
        const issues = await issueProviders.getProvider(t.provider).listIssues(token, { repo: t.repo, state, perPage: limit });
        console.log(`\n${t.provider}:${t.repo} (${issues.length})`);
        for (const it of issues) console.log(`  #${it.number}  [${it.state}]  ${it.title}`);
      } catch (e) { logError(`${t.provider}:${t.repo} — ${e.message}`); }
    }
    return;
  }

  if (sub === 'pickup') {
    const provider = args[1];
    const repo = args[2];
    const number = parseInt(args[3], 10);
    if (!provider || !repo || !number) {
      logError('Usage: jonggrang issues pickup <github|gitlab> <owner/repo> <number> [--deep] [--yes]');
      process.exit(1);
    }
    const token = tokenFor(provider);
    if (!token) { logError(`No ${provider} token configured.`); process.exit(1); }
    const issue = await issueProviders.getProvider(provider).getIssue(token, { repo, number });
    const marker = `<!-- jonggrang-source: ${JSON.stringify({ provider, repo, number: issue.number, url: issue.url })} -->`;
    const description = [
      marker,
      `# ${issue.title}`,
      '',
      `> Imported from issue ${repo}#${issue.number} (${issue.url})`,
      '',
      issue.body || '(no description)',
    ].join('\n');
    logInfo(`Picking up ${provider}:${repo}#${number} → plan`);
    await cmdPlan([description, ...args.slice(4)]);
    return;
  }

  console.log('Usage:');
  console.log('  jonggrang issues list [--provider github|gitlab] [--repo owner/repo] [--state open|closed|all] [--limit N]');
  console.log('  jonggrang issues pickup <github|gitlab> <owner/repo> <number> [--deep] [--yes]');
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

  // Subcommands that handle their own flags — bypass global parser
  if (command === 'task') {
    cmdTask(rest);
    return;
  }

  if (command === 'bot-reviewer') {
    const { runBotReviewer } = require('../lib/bot-reviewer');
    await runBotReviewer(rest);
    return;
  }

  if (command === 'manifest') {
    cmdManifest(rest);
    return;
  }

  if (command === 'web' && rest[0] === 'tunnel') {
    cmdWebTunnel(rest.slice(1));
    return;
  }

  if (command === 'issues') {
    await cmdIssues(rest);
    return;
  }

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
      case '--debug':         DEBUG   = true; break;
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
      case '--host':          WEB_HOST = rest[++i]; break;
      case '--resume':        ORCHESTRATE_RESUME = true; break;
      case '--role':          ORCHESTRATE_ROLE = rest[++i]; break;
      case '--skip-gates':    SKIP_GATES = true; break;
      case '--model':         MODEL = rest[++i]; break;
      case '--effort':        EFFORT = rest[++i]; break;
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
      await cmdWork(planArgs);
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
    case 'approve':
      checkDeps();
      await cmdApprove(planArgs);
      break;
    case 'bug':
      checkDeps();
      await cmdBug(planArgs);
      break;
    case 'orchestrate':
      await cmdOrchestrate(planArgs);
      break;
    case 'agent':
      await cmdAgent();
      break;
    case 'login':
      await cmdLogin();
      break;
    case 'logout':
      await cmdLogout();
      break;
    case 'model':
      await cmdModel();
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

main().then(() => {
  // runAgent (Pi backend) disposes each session, but the SDK can leave residual
  // async handles that keep the event loop alive. Exit once here, after the whole
  // command finished — NOT inside runAgent (that killed the work loop after one
  // task). setImmediate lets buffered stdout flush to a piped parent first.
  setImmediate(() => process.exit(process.exitCode || 0));
}).catch((err) => {
  logError(err.message);
  process.exit(1);
});
