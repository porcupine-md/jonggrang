//
// JONGGRANG — Orchestration Engine
// 16-phase state machine with MANIFEST.yaml persistence
//

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const locks = require('./locks');

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
  7:  { name: 'architecting',        description: 'Technical design AND task decomposition' },
  8:  { name: 'implementation',      description: 'Code development' },
  9:  { name: 'design-verification', description: 'Verify implementation matches plan' },
  10: { name: 'domain-compliance',   description: 'Domain-specific mandatory patterns' },
  11: { name: 'code-quality',        description: 'Code review for maintainability' },
  12: { name: 'test-planning',       description: 'Test strategy and plan creation' },
  13: { name: 'testing',             description: 'Test implementation and execution' },
  14: { name: 'coverage',            description: 'Verify test coverage meets threshold' },
  15: { name: 'test-quality',        description: 'No low-value tests, correct assertions' },
  16: { name: 'completion',          description: 'Final verification, PR, cleanup' },
};

// Phases that are computationally expensive — compaction gate checks before these
const HEAVY_PHASES = new Set([3, 8, 13]);

// Phases skipped per work type
const PHASE_SKIP_MAP = {
  BUGFIX:  new Set([5, 6, 7, 9, 12]),   // no architecture, no brainstorming
  SMALL:   new Set([5, 6, 7, 9]),        // no complexity analysis
  MEDIUM:  new Set([]),                   // nothing skipped
  LARGE:   new Set([]),                   // all 16 phases
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

/**
 * Return which phase numbers will actually execute given a work type.
 * @param {'BUGFIX'|'SMALL'|'MEDIUM'|'LARGE'} workType
 * @returns {number[]} sorted phase numbers
 */
function getActivePhases(workType) {
  const skip = PHASE_SKIP_MAP[workType] || new Set();
  return Object.keys(PHASES)
    .map(Number)
    .filter(n => !skip.has(n));
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
function createManifest(projectRoot, featureId, description, workType) {
  const activePhases = getActivePhases(workType);
  const manifest = {
    feature_id: featureId,
    description,
    work_type: workType,
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
 * Mark a phase as completed with optional output.
 */
function completePhase(manifestPath, phaseNum, output = null) {
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
  return manifest;
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
// PHASE SUMMARY FOR PROMPTS
// ============================================================

/**
 * Generate a phase context block to inject into agent prompts.
 * Tells the agent which phase it's running and what's been done.
 */
function buildPhaseContext(manifest, currentPhaseNum) {
  const phase = PHASES[currentPhaseNum];
  if (!phase) return '';

  const completedPhases = manifest.active_phases
    .filter(n => manifest.phases[n] && manifest.phases[n].status === 'completed')
    .map(n => `  - Phase ${n} (${PHASES[n].name}): ✓`);

  return [
    `## Orchestration Context`,
    `Feature: ${manifest.description}`,
    `Work Type: ${manifest.work_type}`,
    `Current Phase: ${currentPhaseNum} — ${phase.name}`,
    `Phase Purpose: ${phase.description}`,
    completedPhases.length > 0 ? `\nCompleted phases:\n${completedPhases.join('\n')}` : '',
    `\nReturn structured JSON with { phase: ${currentPhaseNum}, status: "completed"|"failed", output: {...} }`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  PHASES,
  HEAVY_PHASES,
  PHASE_SKIP_MAP,
  classifyWorkType,
  getActivePhases,
  getManifestPath,
  getProjectRootFromManifest,
  readManifest,
  writeManifest,
  createManifest,
  startPhase,
  completePhase,
  failPhase,
  updateContextUsage,
  registerAgent,
  resolveAgent,
  updateValidation,
  generateFeatureId,
  findIncompleteManifest,
  listManifests,
  buildPhaseContext,
};
