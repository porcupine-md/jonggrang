//
// JONGGRANG — Five-Role Pipeline
// Lead → Developer → Reviewer → TestLead → Tester
//

const path = require('path');

// ============================================================
// ROLE DEFINITIONS
// ============================================================

const ROLES = {
  lead: {
    name: 'lead',
    label: 'Specialized Lead',
    responsibility: 'Architecture & Strategy. Decomposes requirements into atomic tasks. Does NOT write code.',
    tools: ['Task', 'Read', 'TodoWrite'],       // coordinator: can spawn, cannot edit
    forbidden_tools: ['Edit', 'Write', 'Bash'],
    output_format: 'architecture_plan_json',
    agent_definition: 'templates/agents/lead.md',
    completion_signal: 'ARCHITECTURE_PLAN_COMPLETE',
  },
  developer: {
    name: 'developer',
    label: 'Specialized Developer',
    responsibility: 'Implementation. Executes specific sub-tasks from the lead plan. Focuses purely on logic.',
    tools: ['Edit', 'Write', 'Bash', 'Read'],   // executor: can edit, cannot spawn
    forbidden_tools: ['Task'],
    output_format: 'source_code',
    agent_definition: 'templates/agents/developer.md',
    completion_signal: 'IMPLEMENTATION_COMPLETE',
  },
  reviewer: {
    name: 'reviewer',
    label: 'Specialized Reviewer',
    responsibility: 'Compliance. Validates code against specs and patterns. Rejects non-compliant work.',
    tools: ['Read', 'Bash'],                    // read-only + shell (for static analysis)
    forbidden_tools: ['Edit', 'Write', 'Task'],
    output_format: 'review_report_json',
    agent_definition: 'templates/agents/reviewer.md',
    completion_signal: 'REVIEW_COMPLETE',
  },
  'test-lead': {
    name: 'test-lead',
    label: 'Test Lead',
    responsibility: 'Strategy. Analyzes the implementation to determine what needs testing.',
    tools: ['Read', 'Task', 'TodoWrite'],
    forbidden_tools: ['Edit', 'Write', 'Bash'],
    output_format: 'test_plan_json',
    agent_definition: 'templates/agents/test-lead.md',
    completion_signal: 'TEST_PLAN_COMPLETE',
  },
  tester: {
    name: 'tester',
    label: 'Specialized Tester',
    responsibility: 'Verification. Writes and runs the tests defined by the Test Lead.',
    tools: ['Edit', 'Write', 'Bash', 'Read'],
    forbidden_tools: ['Task'],
    output_format: 'test_results_json',
    agent_definition: 'templates/agents/tester.md',
    completion_signal: 'ALL_TESTS_PASSING',
  },
};

// ============================================================
// ASSEMBLY LINE ORDER
// ============================================================

// The standard five-role assembly order for a feature cycle
const ASSEMBLY_LINE = ['lead', 'developer', 'reviewer', 'test-lead', 'tester'];

// Which phases map to which roles
const PHASE_ROLE_MAP = {
  1:  null,         // setup — orchestrator handles
  2:  null,         // triage — orchestrator handles
  3:  null,         // codebase discovery — orchestrator handles
  4:  null,         // skill discovery — orchestrator handles
  5:  'lead',       // complexity — lead assesses
  6:  'lead',       // brainstorming — lead designs
  7:  'lead',       // architecting — lead decomposes
  8:  'developer',  // implementation — developer codes
  9:  'reviewer',   // design verification — reviewer checks
  10: 'reviewer',   // domain compliance — reviewer validates
  11: 'reviewer',   // code quality — reviewer judges
  12: 'test-lead',  // test planning — test lead strategizes
  13: 'tester',     // testing — tester executes
  14: 'tester',     // coverage — tester verifies
  15: 'reviewer',   // test quality — reviewer judges test suite quality
  16: 'lead',       // completion — lead finalises and summarises
};

// ============================================================
// ROLE HELPERS
// ============================================================

function getRole(roleName) {
  return ROLES[roleName] || null;
}

function getRoleForPhase(phaseNum) {
  const roleName = PHASE_ROLE_MAP[phaseNum];
  return roleName ? ROLES[roleName] : null;
}

/**
 * Check if a role is a coordinator (can spawn sub-agents via Task tool).
 */
function isCoordinator(roleName) {
  const role = ROLES[roleName];
  return role && role.tools.includes('Task');
}

/**
 * Check if a role is an executor (can write/edit files).
 */
function isExecutor(roleName) {
  const role = ROLES[roleName];
  return role && (role.tools.includes('Edit') || role.tools.includes('Write'));
}

// ============================================================
// TASK ROLE ASSIGNMENT
// ============================================================

/**
 * Derive the expected role for a task based on its type/title.
 * Falls back to 'developer' if unclear.
 */
function inferRoleFromTask(task) {
  if (task.role) return task.role;

  const title = (task.title || '').toLowerCase();
  const description = (task.description || '').toLowerCase();
  const combined = `${title} ${description}`;

  if (/\b(review|audit|compliance|validate|check|verify)\b/.test(combined)) return 'reviewer';
  if (/\b(test plan|test strategy|test coverage plan)\b/.test(combined)) return 'test-lead';
  if (/\b(test|spec|coverage|assertion|mock|stub)\b/.test(combined)) return 'tester';
  if (/\b(plan|architecture|design|strategy|decompose|analyze)\b/.test(combined)) return 'lead';

  return 'developer';
}

/**
 * Group tasks by role for parallel dispatch.
 * Returns: { lead: [...tasks], developer: [...tasks], ... }
 */
function groupTasksByRole(tasks) {
  const groups = {};
  for (const task of tasks) {
    const role = inferRoleFromTask(task);
    if (!groups[role]) groups[role] = [];
    groups[role].push(task);
  }
  return groups;
}

/**
 * Get the next role in the assembly line after a given role.
 */
function getNextRole(roleName) {
  const idx = ASSEMBLY_LINE.indexOf(roleName);
  if (idx < 0 || idx >= ASSEMBLY_LINE.length - 1) return null;
  return ASSEMBLY_LINE[idx + 1];
}

// ============================================================
// TOOL RESTRICTION BOUNDARY
// ============================================================

/**
 * Return allowed tools for a role as a Claude Code allowedTools list.
 */
function getAllowedToolsForRole(roleName) {
  const role = ROLES[roleName];
  if (!role) return [];
  return role.tools;
}

/**
 * Return forbidden tools for a role.
 */
function getForbiddenToolsForRole(roleName) {
  const role = ROLES[roleName];
  if (!role) return [];
  return role.forbidden_tools;
}

// ============================================================
// COMPLETION SIGNAL REGISTRY
// ============================================================

/**
 * Build a map of all completion signals for loop detection.
 */
function getCompletionSignals() {
  const signals = {};
  for (const [name, role] of Object.entries(ROLES)) {
    signals[role.completion_signal] = name;
  }
  return signals;
}

/**
 * Check if agent output contains a valid completion signal.
 * Returns role name or null.
 */
function detectCompletionSignal(output) {
  const signals = getCompletionSignals();
  for (const [signal, role] of Object.entries(signals)) {
    if (output.includes(signal)) return { signal, role };
  }
  return null;
}

module.exports = {
  ROLES,
  ASSEMBLY_LINE,
  PHASE_ROLE_MAP,
  getRole,
  getRoleForPhase,
  isCoordinator,
  isExecutor,
  inferRoleFromTask,
  groupTasksByRole,
  getNextRole,
  getAllowedToolsForRole,
  getForbiddenToolsForRole,
  getCompletionSignals,
  detectCompletionSignal,
};
