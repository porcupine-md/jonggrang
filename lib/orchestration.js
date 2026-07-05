//
// JONGGRANG — Orchestration Engine
// 16-phase state machine with MANIFEST.yaml persistence
//

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const locks = require('./locks');
const { estimateTokens } = require('./compaction');

// ============================================================
// PHASE DEFINITIONS
// ============================================================

const PHASES = {
  1:  { name: 'setup',               description: 'Worktree creation, output directory, MANIFEST initialization' },
  2:  { name: 'triage',              description: 'Classify work type, select phases to execute' },
  3:  { name: 'codebase-discovery',  description: 'Explore patterns, detect technologies (2-pass)' },
  4:  { name: 'skill-discovery',     description: 'Map technologies to skills' },
  5:  { name: 'complexity',          description: 'Technical assessment, execution strategy' },
  6:  { name: 'brainstorming',       description: 'Design refinement with human-in-loop' },
  6.5:{ name: 'design-system',       description: 'Author DESIGN.md: gather references/assets/URLs, extract tokens, construct Design Brief + narrative, self-lint (WCAG + broken refs). UI work only.' },
  7:  { name: 'architecting',        description: 'Technical design AND task decomposition' },
  8:  { name: 'implementation',      description: 'Code development' },
  9:  { name: 'simplification',      description: 'Clarity and conciseness improvements across changed files. Reduce complexity, eliminate redundancy, improve naming — never change behavior. Run tests after each change.' },
  10: { name: 'design-verification', description: 'Verify implementation matches plan' },
  11: { name: 'domain-compliance',   description: 'Domain-specific mandatory patterns' },
  11.5:{ name: 'design-verify-ui',   description: 'Verify implemented UI complies with DESIGN.md tokens. UI work only.' },
  12: { name: 'code-quality',        description: 'Code review for maintainability' },
  13: { name: 'test-planning',       description: 'Test strategy and plan creation' },
  14: { name: 'testing',             description: 'Test implementation and execution' },
  15: { name: 'coverage',            description: 'Verify test coverage meets threshold' },
  16: { name: 'test-quality',        description: 'No low-value tests, correct assertions' },
  17: { name: 'completion',          description: 'Final verification, PR, cleanup' },
};

// Phases that are computationally expensive — compaction gate checks before these
const HEAVY_PHASES = new Set([3, 8, 9, 14]);

// Design phases — gated by has_ui (orthogonal to work_type PHASE_SKIP_MAP)
const DESIGN_SYSTEM_PHASE = 6.5;
const DESIGN_VERIFY_UI_PHASE = 11.5;
const DESIGN_PHASES = new Set([DESIGN_SYSTEM_PHASE, DESIGN_VERIFY_UI_PHASE]);

// Phases skipped per work type
const PHASE_SKIP_MAP = {
  BUGFIX: new Set([5, 6, 7, 9, 10, 13]),   // no architecture, no brainstorming, no simplification, no design-verification
  SMALL: new Set([5, 6, 7, 10]),              // no complexity analysis, no design-verification (simplification runs for SMALL+)
  MEDIUM: new Set([]),                           // nothing skipped
  LARGE: new Set([]),                           // all 17 phases including simplification
};

// ============================================================
// WORK TYPE CLASSIFICATION
// ============================================================

/**
 * Classify a feature/task into a work type.
 * @param {string} description
 * @param {object} hints - optional { lineEstimate, fileCount }
 * @returns {'BUGFIX'|'SMALL'|'MEDIUM'|'LARGE'}
 */
function classifyWorkType(description, hints = {}) {
  const desc = description.toLowerCase();
  const { lineEstimate = 0, fileCount = 0 } = hints;

  // BUGFIX: clearly a bug fix (avoid false positives like "error message", "error handling")
  const isBugfix = /\b(fix|bug|broken|crash|typo|hotfix|regression)\b/.test(desc) ||
    /\berror\b(?!\s*(message|handling|response|code|log|output|format))/.test(desc);
  if (isBugfix) return 'BUGFIX';

  // LARGE: subsystems, major architectural changes, or many components mentioned
  const isLarge =
    fileCount >= 5 ||
    /\b(subsystem|architecture|refactor|migrate|overhaul|redesign|platform|infrastructure|framework)\b/.test(desc) ||
    /\b(authentication|authorization|auth system|checkout|billing|subscription)\b/.test(desc) ||
    /\bpayment\b.{0,40}\b(flow|system|integration|gateway|processor|webhook)\b/.test(desc) ||
    /\b(webhook|worker|queue|job)\b.{0,30}\b(handler|processor|system|service)\b/.test(desc) ||
    /\b(full|complete|entire|end-to-end|e2e)\b.{0,30}\b(system|flow|feature|implementation|setup)\b/.test(desc) ||
    // Many comma-separated components suggest large scope
    (desc.match(/,/g) || []).length >= 3;
  if (isLarge) return 'LARGE';

  // MEDIUM: non-trivial features — requires cross-cutting concerns or multi-file scope
  const isMedium =
    (lineEstimate >= 100 || fileCount >= 3) ||
    // Action keyword + substantial noun + cross-cutting connector ("with X and Y")
    /\b(implement|build|create|develop|setup|integrate)\b.{0,80}\b(with|including|plus)\b/.test(desc) ||
    /\b(with|including)\b.{0,40}\b(test|tests|validation|middleware|integration|authentication)\b/.test(desc) ||
    /\b(module|service|flow|handler|integration|pipeline|workflow)\b/.test(desc);
  if (isMedium) return 'MEDIUM';

  return 'SMALL';
}

// UI / frontend signal keywords — used to gate the design (DESIGN.md) phases.
const UI_KEYWORDS = /\b(ui|ux|frontend|front-end|client-side|component|page|screen|view|button|form|modal|dialog|layout|dashboard|css|tailwind|styl(e|ing)|react|vue|angular|svelte|next\.?js|nuxt|responsive|theme|design system|landing|navbar|sidebar|menu)\b/;

/**
 * Decide whether a feature touches UI/frontend, gating the design phases.
 * @param {string} description
 * @param {object} hints - optional { hasUi: boolean } explicit override
 * @returns {boolean}
 */
function classifyHasUi(description, hints = {}) {
  if (typeof hints.hasUi === 'boolean') return hints.hasUi;
  return UI_KEYWORDS.test((description || '').toLowerCase());
}

/**
 * Return which phase numbers will actually execute given a work type.
 * @param {'BUGFIX'|'SMALL'|'MEDIUM'|'LARGE'} workType
 * @returns {number[]} sorted phase numbers
 */
function getActivePhases(workType, opts = {}) {
  const { hasUi = false } = opts;
  const skip = PHASE_SKIP_MAP[workType] || new Set();
  return Object.keys(PHASES)
    .map(Number)
    .filter(n => !skip.has(n))
    .filter(n => hasUi || !DESIGN_PHASES.has(n))
    .sort((a, b) => a - b);
}

// ============================================================
// MANIFEST MANAGEMENT
// ============================================================

/**
 * Derive project root from a MANIFEST path.
 * .jonggrang/.output/features/{id}/MANIFEST.yaml -> project root (5 levels up)
 */
function getProjectRootFromManifest(manifestPath) {
  return path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(manifestPath)))));
}

/**
 * Build the MANIFEST path for a feature.
 * Stored in .jonggrang/.output/features/{featureId}/MANIFEST.yaml
 */
function getManifestPath(projectRoot, featureId) {
  return path.join(projectRoot, '.jonggrang', '.output', 'features', featureId, 'MANIFEST.yaml');
}

/**
 * Read MANIFEST.yaml. Returns null if not found.
 */
function readManifest(manifestPath) {
  try {
    if (!fs.existsSync(manifestPath)) return null;
    const raw = fs.readFileSync(manifestPath, 'utf8');
    return yaml.load(raw);
  } catch {
    return null;
  }
}

/**
 * Write MANIFEST.yaml atomically.
 */
function writeManifest(manifestPath, manifest) {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const content = yaml.dump(manifest, { lineWidth: -1 });
  fs.writeFileSync(manifestPath, content, 'utf8');
}

/**
 * Create a fresh MANIFEST for a new orchestration run.
 */
function createManifest(projectRoot, featureId, description, workType, opts = {}) {
  const { hasUi = false, artifact = './DESIGN.md', lint = true, wcag = 'AA' } = opts;
  const activePhases = getActivePhases(workType, { hasUi });
  const manifest = {
    feature_id: featureId,
    description,
    work_type: workType,
    has_ui: hasUi,
    design_artifact: hasUi ? artifact : null,
    design_lint: hasUi ? lint : null,
    design_wcag: hasUi ? wcag : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',       // running | paused | completed | failed
    current_phase: activePhases[0],
    active_phases: activePhases,
    phases: {},
    agents: {},              // agentId -> { role, status, started_at, output_path }
    validation: {
      review_passed: false,
      tests_passed: false,
      coverage_met: false,
    },
    locks: [],               // active file locks
    context_usage: null,     // last known context % (0-1)
  };

  for (const phaseNum of activePhases) {
    manifest.phases[phaseNum] = {
      name: PHASES[phaseNum].name,
      status: 'pending',     // pending | running | completed | skipped | failed
      started_at: null,
      completed_at: null,
      agent_id: null,
      output: null,
      output_files: [],      // files this phase produced — see addOutputFile()
    };
  }

  const manifestPath = getManifestPath(projectRoot, featureId);
  writeManifest(manifestPath, manifest);
  return { manifest, manifestPath };
}

/**
 * Advance manifest to a new phase.
 */
function startPhase(manifestPath, phaseNum) {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`MANIFEST not found at ${manifestPath}`);

  manifest.current_phase = phaseNum;
  manifest.updated_at = new Date().toISOString();
  if (manifest.phases[phaseNum]) {
    manifest.phases[phaseNum].status = 'running';
    manifest.phases[phaseNum].started_at = new Date().toISOString();
  }

  writeManifest(manifestPath, manifest);
  return manifest;
}

/**
 * Mark a phase as completed with optional output and output files.
 * @param {string} manifestPath
 * @param {number} phaseNum
 * @param {object|null} output - phase-level metadata (existing behavior)
 * @param {Array<{path:string,type?:string,size?:number,created_at?:string,agent_id?:string,task_id?:string}>|null} outputFiles
 *   - optional list of files produced by this phase. Backward compatible:
 *     existing 3-arg callers keep working unchanged.
 */
function completePhase(manifestPath, phaseNum, output = null, outputFiles = null) {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`MANIFEST not found at ${manifestPath}`);

  if (manifest.phases[phaseNum]) {
    manifest.phases[phaseNum].status = 'completed';
    manifest.phases[phaseNum].completed_at = new Date().toISOString();
    if (output) manifest.phases[phaseNum].output = output;
  }

  // Advance to next active phase
  const remaining = manifest.active_phases.filter(n => n > phaseNum);
  if (remaining.length > 0) {
    manifest.current_phase = remaining[0];
    manifest.status = 'running';
  } else {
    manifest.current_phase = null;
    manifest.status = 'completed';
  }

  manifest.updated_at = new Date().toISOString();
  writeManifest(manifestPath, manifest);

  // Record output files after marking complete (each does its own read/write).
  if (Array.isArray(outputFiles) && outputFiles.length > 0) {
    addOutputFiles(manifestPath, phaseNum, outputFiles);
    return readManifest(manifestPath);
  }
  return manifest;
}

/**
 * Record a single output file produced by a phase.
 * Idempotent on `path` within the phase (last write wins).
 * size/created_at are always filled from the filesystem — never trusted from the caller.
 *
 * @param {string} manifestPath
 * @param {number} phaseNum
 * @param {{path:string,type?:string,agent_id?:string,task_id?:string}} fileEntry
 * @returns {object} the stored entry (with size/created_at filled)
 */
function addOutputFile(manifestPath, phaseNum, fileEntry) {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`MANIFEST not found at ${manifestPath}`);
  if (!manifest.phases[phaseNum]) {
    throw new Error(`Phase ${phaseNum} not found in manifest (active phases: ${Object.keys(manifest.phases).join(', ')})`);
  }
  if (!fileEntry || typeof fileEntry.path !== 'string' || fileEntry.path.trim() === '') {
    throw new Error('addOutputFile: fileEntry.path must be a non-empty string');
  }

  const relPath = fileEntry.path.trim();
  const projectRoot = getProjectRootFromManifest(manifestPath);
  const absPath = path.resolve(projectRoot, relPath);

  // Always derive size/created_at from disk; null if the file no longer exists.
  let size = null;
  let createdAt = fileEntry.created_at || null;
  try {
    const stat = fs.statSync(absPath);
    size = stat.size;
    if (!createdAt) createdAt = stat.mtime.toISOString();
  } catch {
    // file missing at record time — keep size null
  }

  const entry = {
    path: relPath,
    type: (typeof fileEntry.type === 'string' && fileEntry.type.trim()) ? fileEntry.type.trim() : 'output',
    size,
    created_at: createdAt,
  };
  if (fileEntry.agent_id) entry.agent_id = fileEntry.agent_id;
  if (fileEntry.task_id) entry.task_id = fileEntry.task_id;

  const phase = manifest.phases[phaseNum];
  if (!Array.isArray(phase.output_files)) phase.output_files = [];

  // Idempotent on path: replace existing entry for the same path.
  const existingIdx = phase.output_files.findIndex(e => e && e.path === relPath);
  if (existingIdx >= 0) {
    phase.output_files[existingIdx] = entry;
  } else {
    phase.output_files.push(entry);
  }

  manifest.updated_at = new Date().toISOString();
  writeManifest(manifestPath, manifest);
  return entry;
}

/**
 * Bulk variant of addOutputFile. Records each entry, returns the stored entries.
 * @returns {object[]}
 */
function addOutputFiles(manifestPath, phaseNum, fileEntries) {
  if (!Array.isArray(fileEntries)) return [];
  const stored = [];
  for (const fileEntry of fileEntries) {
    stored.push(addOutputFile(manifestPath, phaseNum, fileEntry));
  }
  return stored;
}

/**
 * Mark a phase as failed with reason.
 */
function failPhase(manifestPath, phaseNum, reason) {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`MANIFEST not found at ${manifestPath}`);

  if (manifest.phases[phaseNum]) {
    manifest.phases[phaseNum].status = 'failed';
    manifest.phases[phaseNum].completed_at = new Date().toISOString();
    manifest.phases[phaseNum].output = { error: reason };
  }

  manifest.status = 'failed';
  manifest.updated_at = new Date().toISOString();
  writeManifest(manifestPath, manifest);
  return manifest;
}

/**
 * Update context usage in manifest.
 */
function updateContextUsage(manifestPath, usageRatio) {
  const manifest = readManifest(manifestPath);
  if (!manifest) return;
  manifest.context_usage = usageRatio;
  manifest.updated_at = new Date().toISOString();
  writeManifest(manifestPath, manifest);
}

/**
 * Register an agent run in manifest and optionally acquire file locks.
 * @param {string|null} outputPath - DEPRECATED: per-file tracking now lives in
 *   `phases[n].output_files[]` via addOutputFile(). The `output_path` field is
 *   retained for backward compatibility but should not be relied on for new code.
 * @param {string[]} lockedFiles - files this agent will exclusively modify
 */
function registerAgent(manifestPath, agentId, role, outputPath = null, lockedFiles = []) {
  const manifest = readManifest(manifestPath);
  if (!manifest) return;
  manifest.agents[agentId] = {
    role,
    status: 'running',
    started_at: new Date().toISOString(),
    output_path: outputPath,
    locked_files: lockedFiles,
  };
  manifest.updated_at = new Date().toISOString();
  writeManifest(manifestPath, manifest);

  if (lockedFiles.length > 0) {
    const projectRoot = getProjectRootFromManifest(manifestPath);
    locks.acquireLock(projectRoot, agentId, lockedFiles);
  }
}

/**
 * Mark agent as done in manifest and release its file locks.
 */
function resolveAgent(manifestPath, agentId, status = 'completed') {
  const manifest = readManifest(manifestPath);
  if (!manifest) return;
  if (manifest.agents[agentId]) {
    manifest.agents[agentId].status = status;
    manifest.agents[agentId].completed_at = new Date().toISOString();
  }
  manifest.updated_at = new Date().toISOString();
  writeManifest(manifestPath, manifest);

  const projectRoot = getProjectRootFromManifest(manifestPath);
  locks.releaseLock(projectRoot, agentId);
}

/**
 * Update validation flags.
 */
function updateValidation(manifestPath, flags) {
  const manifest = readManifest(manifestPath);
  if (!manifest) return;
  Object.assign(manifest.validation, flags);
  manifest.updated_at = new Date().toISOString();
  writeManifest(manifestPath, manifest);
}

// ============================================================
// FEATURE ID GENERATION
// ============================================================

function generateFeatureId(description) {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
  const ts = Date.now().toString(36);
  return `${slug}-${ts}`;
}

// ============================================================
// RESUME LOGIC
// ============================================================

/**
 * Find the most recent incomplete MANIFEST for a project.
 * Returns { featureId, manifest, manifestPath } or null.
 */
function findIncompleteManifest(projectRoot) {
  const outputDir = path.join(projectRoot, '.jonggrang', '.output', 'features');
  if (!fs.existsSync(outputDir)) return null;

  const entries = fs.readdirSync(outputDir)
    .map(name => {
      const mPath = path.join(outputDir, name, 'MANIFEST.yaml');
      const m = readManifest(mPath);
      return m ? { featureId: name, manifest: m, manifestPath: mPath } : null;
    })
    .filter(Boolean)
    .filter(e => ['running', 'in_progress', 'paused', 'failed'].includes(e.manifest.status))
    .sort((a, b) => new Date(b.manifest.updated_at) - new Date(a.manifest.updated_at));

  return entries.length > 0 ? entries[0] : null;
}

/**
 * List all manifests for a project.
 */
function listManifests(projectRoot) {
  const outputDir = path.join(projectRoot, '.jonggrang', '.output', 'features');
  if (!fs.existsSync(outputDir)) return [];

  return fs.readdirSync(outputDir)
    .map(name => {
      const mPath = path.join(outputDir, name, 'MANIFEST.yaml');
      const m = readManifest(mPath);
      return m ? { featureId: name, manifest: m, manifestPath: mPath } : null;
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.manifest.updated_at) - new Date(a.manifest.updated_at));
}

// ============================================================
// PHASE 9 — SIMPLIFICATION PROMPT BUILDER
// ============================================================

const SIMPLIFY_PHASE = 9;

// Total estimated diff tokens above which simplify splits into one
// fresh agent per file (Approach 2 fallback) instead of one agent for
// all files (Approach 1 default). Tunable.
const SIMPLIFY_DIFF_BUDGET = 200_000;

/**
 * Get changed files since implementation started.
 * Uses git diff to detect files modified during phase 8.
 * Falls back to agent locked_files from manifest.
 */
function getChangedFilesForSimplify(manifestPath, projectRoot) {
  const files = [];

  // Try git diff first — most reliable
  try {
    const execSync = require('child_process').execSync;

    // Get modified and added files (exclude deletions)
    const diffResult = execSync(
      'git diff --name-only --diff-filter=d HEAD',
      { cwd: projectRoot, encoding: 'utf8', timeout: 5000 }
    );

    // Get untracked files (new files not yet staged)
    const untrackedResult = execSync(
      'git ls-files --others --exclude-standard',
      { cwd: projectRoot, encoding: 'utf8', timeout: 5000 }
    );

    const changed = [
      ...diffResult.split('\n').filter(Boolean),
      ...untrackedResult.split('\n').filter(Boolean)
    ]
      // Exclude orchestration/tooling config files
      .filter(f =>
        !f.startsWith('.jonggrang/') &&
        !f.startsWith('.opencode/') &&
        !f.startsWith('.claude/') &&
        !f.startsWith('.codex/') &&
        !f.startsWith('hooks/') &&
        f !== 'AGENTS.md' &&
        f !== 'CLAUDE.md'
      );

    if (changed.length > 0) return [...new Set(changed)];
  } catch { /* fall through */ }

  // Fallback: read from manifest agent locked_files
  try {
    const manifest = readManifest(manifestPath);
    if (manifest) {
      for (const agent of Object.values(manifest.agents || {})) {
        if (agent.role === 'developer' && agent.locked_files) {
          files.push(...agent.locked_files);
        }
      }
    }
  } catch { /* ignore */ }

  return [...new Set(files)];
}

/**
 * Get the diff for a single changed file (tracked changes vs HEAD).
 * New / untracked files have no diff against HEAD, so their full
 * content is returned instead — simplifying a new file reviews it whole.
 */
function getDiffForFile(file, projectRoot) {
  const execFileSync = require('child_process').execFileSync;

  // Tracked changes: diff against HEAD (exclude deletions handled upstream).
  try {
    const diff = execFileSync('git', ['diff', 'HEAD', '--', file], {
      cwd: projectRoot, encoding: 'utf8', timeout: 5000,
    });
    if (diff.trim()) return diff;
  } catch { /* fall through */ }

  // New / untracked file: no diff against HEAD — use full content,
  // since simplifying a new file means reviewing it whole.
  try {
    return fs.readFileSync(path.join(projectRoot, file), 'utf8');
  } catch {
    return '';
  }
}

function gatherDiffs(changedFiles, projectRoot) {
  return changedFiles.map(file => ({ file, diff: getDiffForFile(file, projectRoot) }));
}

function formatChanges(diffs) {
  return diffs
    .map(d => `### ${d.file}\n\n\`\`\`diff\n${d.diff}\n\`\`\``)
    .join('\n\n');
}

function renderSimplifyPrompt(phaseContext, fileList, changesBlock) {
  return `## Phase 9 — Simplification

${phaseContext}

Review the changed files from the implementation phase and apply simplification improvements.

## Principles

- **Preserve functionality**: Never change what the code does. All existing tests must continue to pass.
- **Apply project standards**: Follow conventions from AGENTS.md and CLAUDE.md.
- **Enhance clarity**: Reduce unnecessary complexity and nesting. Eliminate redundant code and abstractions. Improve variable and function names. Consolidate related logic. Remove comments that describe obvious code.
- **Avoid nested ternary operators**: prefer switch statements or if/else chains for multiple conditions.
- **Maintain balance**: Do not over-simplify. Avoid overly clever solutions that are hard to understand. Do not combine too many concerns into single functions. Do not remove helpful abstractions. Prioritize readability over fewer lines.

## Scope

Only review and modify these files:
${fileList}

## Changes

${changesBlock}

## Process

1. Review the diff above. Use the Read tool to open a full file only if you need more surrounding context.
2. Identify concrete improvements (dead code, unclear names, redundant logic, inconsistent patterns)
3. Apply changes one file at a time
4. After all changes, run existing tests to verify nothing is broken
5. Summarize what you changed and why

Do NOT add new features, change public APIs, or refactor code outside the listed files.

## Role

You are a **Developer** in this phase — you can edit files. After completing all improvements, output:
IMPLEMENTATION_COMPLETE`;
}

/**
 * Build the single-agent simplification prompt for all changed files,
 * with their diffs inlined. Used when the total diff fits the budget
 * (see planSimplify). Instructs the developer agent to reduce complexity
 * without changing behavior.
 */
function buildSimplifyPrompt(manifest, projectRoot) {
  const manifestPath = getManifestPath(projectRoot, manifest.feature_id);
  const changedFiles = getChangedFilesForSimplify(manifestPath, projectRoot);
  const phaseContext = buildPhaseContext(manifest, SIMPLIFY_PHASE);

  if (changedFiles.length === 0) {
    return renderSimplifyPrompt(
      phaseContext,
      '(auto-detected from git diff — review all files modified in this feature)',
      '(no changes detected)',
    );
  }

  const diffs = gatherDiffs(changedFiles, projectRoot);
  const fileList = changedFiles.map(f => `- ${f}`).join('\n');
  return renderSimplifyPrompt(phaseContext, fileList, formatChanges(diffs));
}

/**
 * Decide how to run the simplification phase based on total diff size.
 *
 * Deterministic, made before spawning any agent:
 *   total diff tokens <= SIMPLIFY_DIFF_BUDGET → one agent, all diffs inlined
 *   otherwise                                 → one fresh agent per file
 *
 * Returns { mode: 'single', prompt } or { mode: 'per-file', units: [{ file, prompt }] }.
 */
function planSimplify(manifest, projectRoot) {
  const manifestPath = getManifestPath(projectRoot, manifest.feature_id);
  const changedFiles = getChangedFilesForSimplify(manifestPath, projectRoot);
  const phaseContext = buildPhaseContext(manifest, SIMPLIFY_PHASE);

  if (changedFiles.length === 0) {
    return { mode: 'single', prompt: buildSimplifyPrompt(manifest, projectRoot), totalTokens: 0 };
  }

  const diffs = gatherDiffs(changedFiles, projectRoot);
  const totalTokens = estimateTokens(diffs.map(d => d.diff).join('\n'));

  if (totalTokens <= SIMPLIFY_DIFF_BUDGET) {
    const fileList = changedFiles.map(f => `- ${f}`).join('\n');
    const prompt = renderSimplifyPrompt(phaseContext, fileList, formatChanges(diffs));
    return { mode: 'single', prompt, totalTokens };
  }

  const units = diffs.map(d => ({
    file: d.file,
    prompt: renderSimplifyPrompt(phaseContext, `- ${d.file}`, formatChanges([d])),
  }));
  return { mode: 'per-file', units, totalTokens };
}

// ============================================================
// DESIGN PHASE PROMPT BUILDERS
// ============================================================

/**
 * Phase 6.5 — DesignSystem. Designer authors DESIGN.md (emit-pattern).
 */
function buildDesignSystemPrompt(manifest, projectRoot) {
  const phaseContext = buildPhaseContext(manifest, DESIGN_SYSTEM_PHASE);
  const artifact = manifest.design_artifact || './DESIGN.md';
  const featureId = manifest.feature_id || '{feature_id}';
  const wcag = manifest.design_wcag || 'AA';
  const lintEnabled = manifest.design_lint !== false;
  const lintStep = lintEnabled
    ? `4. **Self-lint** — validate deterministically:
   \`npx @google/design.md lint\` (broken \`{token.refs}\`) and WCAG ${wcag} contrast.
   Fix any failures before signalling complete.`
    : `4. **Self-check** — WCAG ${wcag} contrast must pass before signalling complete.
   (\`design.lint\` is disabled in config, so the \`npx @google/design.md lint\` step is skipped.)`;
  const signalGate = lintEnabled ? 'lint + WCAG pass' : `WCAG ${wcag} passes`;
  return `## Phase 6.5 — Design System (Author DESIGN.md)

${phaseContext}

You are a **Designer**. You own the project's visual identity. You do NOT write source code.
**Allowed tools:** Read, Bash, Task   **Forbidden:** Edit, Write

Invoke the design skill first: use \`gateway-design\` to load \`design/design-md\`.

## Your Job — Gather → Extract → Construct → Self-lint

1. **Gather** — collect the user's design preferences, reference URLs, screenshots,
   and assets to emulate. If references are URLs, spawn extraction sub-agents (Task)
   to pull colors, type, spacing via DevTools/CSS.
2. **Extract** — derive design tokens (color, typography, spacing, radius, shadow)
   from the gathered references. For multi-reference work, fuse 2–3 sources tastefully
   (assign a role per reference; reconcile into ONE coherent system).
3. **Construct** — write a complete \`${artifact}\`: YAML front matter (machine-readable
   tokens) + markdown body (Design Brief + narrative rationale + 8 canonical sections).
${lintStep}

## Emit-pattern (no Write tool)

Emit the full \`${artifact}\` content as your phase output to:
\`.jonggrang/.output/features/${featureId}/06_5-designer-design-md.md\`
The platform persists it to \`${artifact}\` at project root (canonical, git-tracked).
If a \`${artifact}\` already exists, READ it and EXTEND, using \`diff\` to avoid regressions.

## Signal

When \`${artifact}\` is written and ${signalGate}, output:
DESIGN_COMPLETE`;
}

/**
 * Phase 11.5 — DesignVerifyUI. Designer verifies implemented UI vs DESIGN.md tokens.
 */
function buildDesignVerifyUiPrompt(manifest, projectRoot) {
  const phaseContext = buildPhaseContext(manifest, DESIGN_VERIFY_UI_PHASE);
  const artifact = manifest.design_artifact || './DESIGN.md';
  const lintLine = manifest.design_lint !== false
    ? ` Re-run\n   \`npx @google/design.md lint\` if the spec was touched.`
    : '';
  return `## Phase 11.5 — Design Verify UI (token compliance)

${phaseContext}

You are a **Designer** performing independent review of the **Developer's** UI output.
**Allowed tools:** Read, Bash, Task   **Forbidden:** Edit, Write

## Your Job

1. Read \`${artifact}\` (the canonical token spec).
2. Inspect the implemented UI / changed frontend files.
3. Verify the implementation uses DESIGN.md tokens and does NOT hardcode equivalent
   values (raw hex colors, ad-hoc spacing, off-spec fonts).${lintLine}
4. Report PASS or FAIL with specific token violations.

This is independent review (different author, different artifact), not self-review.

## Signal

If the UI complies with the token spec, output:
DESIGN_UI_VERIFIED

If it does not comply, report the violations clearly and do NOT emit the signal
(the feedback loop will route back to the Developer).`;
}

// ============================================================
// PHASE SUMMARY FOR PROMPTS
// ============================================================

/**
 * Generate a phase context block to inject into agent prompts.
 * Tells the agent which phase it's running and what's been done.
 */
// Phases that must emit an OUTPUT_FILES: block so the manifest can track what they produced.
// Phase 8  = implementation (developer writes code files)
// Phase 12 = code-quality   (reviewer writes a review report)
// Phase 14 = testing        (tester writes test files)
// Phases whose file outputs are tracked via git diff after the phase completes.
const OUTPUT_TRACKING_PHASES = new Set([8, 12, 14]);

function buildPhaseContext(manifest, currentPhaseNum, projectRoot) {
  const phase = PHASES[currentPhaseNum];
  if (!phase) return '';

  const completedPhases = manifest.active_phases
    .filter(n => manifest.phases[n] && manifest.phases[n].status === 'completed')
    .map(n => `  - Phase ${n} (${PHASES[n].name}): ✓`);

  // Inject a deterministic codebase map (LLM-free, cached). Gives every
  // fresh-context agent an immediate project orientation. Mirrors pi-compass.
  // Heavy on phase 3 (codebase-discovery) and phase 8 (implementation);
  // skipped for the simplify phase (it already gets a per-file diff payload).
  let codemapBlock = '';
  if (projectRoot && currentPhaseNum !== 9) {
    try {
      const codemap = require('./codemap');
      const { codemap: cm, stale } = codemap.getOrGenerateCodemap(projectRoot);
      if (cm) {
        const maxChars = (currentPhaseNum === 3 || currentPhaseNum === 8) ? 3500 : 2000;
        codemapBlock = `\n\n## Project Context (codemap)\n\n${codemap.formatCodemapMarkdown(cm, { maxChars })}`;
        if (stale) codemapBlock += `\n\n> ⚠️ Codemap may be outdated (project changed since ${cm.generatedAt}).`;
      }
    } catch { /* best-effort */ }
  }

  return [
    `## Orchestration Context`,
    `Feature: ${manifest.description}`,
    `Work Type: ${manifest.work_type}`,
    `Current Phase: ${currentPhaseNum} — ${phase.name}`,
    `Phase Purpose: ${phase.description}`,
    completedPhases.length > 0 ? `\nCompleted phases:\n${completedPhases.join('\n')}` : '',
    `\nReturn structured JSON with { phase: ${currentPhaseNum}, status: "completed"|"failed", output: {...} }`,
    codemapBlock,
  ].filter(Boolean).join('\n');
}

/**
 * Returns files changed since beforeSha (committed, staged, unstaged, and untracked).
 * Uses two commands: git diff for committed changes, git status --porcelain for working tree.
 * @param {string} projectRoot
 * @param {string} beforeSha - git SHA captured before the phase ran
 * @returns {Array<{path:string, type:string}>}
 */
function getChangedFiles(projectRoot, beforeSha) {
  const opts = { cwd: projectRoot, encoding: 'utf8' };
  const files = new Set();
  const collect = (cmd) => {
    try {
      const out = execSync(cmd, opts).trim();
      if (out) out.split('\n').forEach(f => { const t = f.trim(); if (t) files.add(t); });
    } catch {}
  };
  // Both commands are scoped to beforeSha — no leakage between phases
  collect(`git diff --name-only ${beforeSha}..HEAD`); // committed since beforeSha
  collect(`git diff --name-only ${beforeSha}`);        // staged + unstaged vs beforeSha
  return Array.from(files).map(p => ({ path: p, type: 'code' }));
}

module.exports = {
  PHASES,
  HEAVY_PHASES,
  PHASE_SKIP_MAP,
  DESIGN_PHASES,
  DESIGN_SYSTEM_PHASE,
  DESIGN_VERIFY_UI_PHASE,
  OUTPUT_TRACKING_PHASES,
  classifyWorkType,
  classifyHasUi,
  getActivePhases,
  getManifestPath,
  getProjectRootFromManifest,
  readManifest,
  writeManifest,
  createManifest,
  startPhase,
  completePhase,
  addOutputFile,
  addOutputFiles,
  getChangedFiles,
  failPhase,
  updateContextUsage,
  registerAgent,
  resolveAgent,
  updateValidation,
  generateFeatureId,
  findIncompleteManifest,
  listManifests,
  buildPhaseContext,
  buildSimplifyPrompt,
  buildDesignSystemPrompt,
  buildDesignVerifyUiPrompt,
  planSimplify,
  SIMPLIFY_PHASE,
  SIMPLIFY_DIFF_BUDGET,
};
