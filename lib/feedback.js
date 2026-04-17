//
// JONGGRANG — Feedback Loop State
// Dirty bit tracking, multi-domain pass management, stuck detection
//

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// STATE FILE LOCATION
// Ephemeral — cleared on session restart
// ============================================================

const FEEDBACK_STATE_FILE = '.jonggrang/.ephemeral/feedback-loop-state.json';

function getFeedbackStatePath(projectRoot) {
  return path.join(projectRoot, FEEDBACK_STATE_FILE);
}

// ============================================================
// DEFAULT STATE STRUCTURE
// ============================================================

function createDefaultState() {
  return {
    active: false,
    iteration: 0,
    modified_domains: [],
    domain_phases: {},
    // { backend: { review: { status: 'PENDING'|'PASS'|'FAIL', agent: null, timestamp: null },
    //              testing: { status: 'PENDING'|'PASS'|'FAIL', agent: null, timestamp: null } } }
    dirty_bit: false,
    last_outputs: [],       // last N agent output hashes (for loop detection)
    stuck_count: 0,         // consecutive blocked exits
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ============================================================
// READ / WRITE
// ============================================================

function readFeedbackState(projectRoot) {
  const statePath = getFeedbackStatePath(projectRoot);
  try {
    if (!fs.existsSync(statePath)) return createDefaultState();
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return createDefaultState();
  }
}

function writeFeedbackState(projectRoot, state) {
  const statePath = getFeedbackStatePath(projectRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function clearFeedbackState(projectRoot) {
  const statePath = getFeedbackStatePath(projectRoot);
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
}

// ============================================================
// DIRTY BIT OPERATIONS
// ============================================================

/**
 * Activate feedback loop for a domain.
 * Called when a developer agent starts working on a domain.
 */
function activateFeedbackLoop(projectRoot, domain) {
  const state = readFeedbackState(projectRoot);
  state.active = true;
  state.dirty_bit = true;

  if (!state.modified_domains.includes(domain)) {
    state.modified_domains.push(domain);
  }

  if (!state.domain_phases[domain]) {
    state.domain_phases[domain] = {
      review:  { status: 'PENDING', agent: null, timestamp: null },
      testing: { status: 'PENDING', agent: null, timestamp: null },
    };
  }

  writeFeedbackState(projectRoot, state);
  return state;
}

/**
 * Set dirty bit for a domain (called when files are modified).
 * Resets review + testing status for that domain.
 */
function setDirtyBit(projectRoot, domain) {
  const state = readFeedbackState(projectRoot);
  state.dirty_bit = true;
  state.iteration += 1;

  if (!state.modified_domains.includes(domain)) {
    state.modified_domains.push(domain);
  }

  // Reset domain phases when code changes
  if (state.domain_phases[domain]) {
    state.domain_phases[domain].review.status  = 'PENDING';
    state.domain_phases[domain].testing.status = 'PENDING';
  } else {
    state.domain_phases[domain] = {
      review:  { status: 'PENDING', agent: null, timestamp: null },
      testing: { status: 'PENDING', agent: null, timestamp: null },
    };
  }

  writeFeedbackState(projectRoot, state);
  return state;
}

// ============================================================
// PHASE PASS / FAIL RECORDING
// ============================================================

function recordPhaseResult(projectRoot, domain, phase, status, agentName = null) {
  const state = readFeedbackState(projectRoot);

  if (!state.domain_phases[domain]) {
    state.domain_phases[domain] = {
      review:  { status: 'PENDING', agent: null, timestamp: null },
      testing: { status: 'PENDING', agent: null, timestamp: null },
    };
  }

  state.domain_phases[domain][phase] = {
    status,
    agent: agentName,
    timestamp: new Date().toISOString(),
  };

  // If any domain FAILS, reset ALL domains for next iteration
  if (status === 'FAIL') {
    for (const d of state.modified_domains) {
      if (d !== domain) {
        if (state.domain_phases[d]) {
          state.domain_phases[d].review.status  = 'PENDING';
          state.domain_phases[d].testing.status = 'PENDING';
        }
      }
    }
    state.dirty_bit = true;
  }

  // Check if all domains passed all phases
  const allPassed = state.modified_domains.every(d => {
    const dp = state.domain_phases[d];
    return dp && dp.review.status === 'PASS' && dp.testing.status === 'PASS';
  });

  if (allPassed) {
    state.dirty_bit = false;
  }

  writeFeedbackState(projectRoot, state);
  return { state, allPassed };
}

// ============================================================
// EXIT GATE CHECK
// ============================================================

/**
 * Check if agent is allowed to exit.
 * Returns { allowed: bool, reason: string, state }
 */
function checkExitGate(projectRoot) {
  const state = readFeedbackState(projectRoot);

  if (!state.active) {
    return { allowed: true, reason: 'Feedback loop not active.', state };
  }

  if (!state.dirty_bit) {
    return { allowed: true, reason: 'No pending changes. Feedback loop satisfied.', state };
  }

  const blockedDomains = state.modified_domains.filter(d => {
    const dp = state.domain_phases[d];
    return !dp || dp.review.status !== 'PASS' || dp.testing.status !== 'PASS';
  });

  if (blockedDomains.length === 0) {
    return { allowed: true, reason: 'All domains passed review and testing.', state };
  }

  state.stuck_count = (state.stuck_count || 0) + 1;
  writeFeedbackState(projectRoot, state);

  const pendingStr = blockedDomains.map(d => {
    const dp = state.domain_phases[d] || {};
    const rStatus = dp.review?.status || 'PENDING';
    const tStatus = dp.testing?.status || 'PENDING';
    return `  ${d}: review=${rStatus}, testing=${tStatus}`;
  }).join('\n');

  return {
    allowed: false,
    reason: `EXIT BLOCKED. Modified domains have not completed review + testing:\n${pendingStr}`,
    state,
    blocked_domains: blockedDomains,
    stuck_count: state.stuck_count,
  };
}

// ============================================================
// LOOP DETECTION (>90% similarity)
// ============================================================

const MAX_OUTPUT_HISTORY = 5;
const SIMILARITY_THRESHOLD = 0.90;

/**
 * Simple similarity: Jaccard on word sets.
 */
function similarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Record agent output and check for stuck loop.
 * Returns { stuck: bool, similarity: number }
 */
function recordOutputAndCheckLoop(projectRoot, outputText) {
  const state = readFeedbackState(projectRoot);
  const hash = crypto.createHash('sha256').update(outputText).digest('hex').slice(0, 12);

  if (!state.last_outputs) state.last_outputs = [];

  // Check similarity against recent outputs
  let maxSim = 0;
  for (const prev of state.last_outputs) {
    const sim = similarity(prev.text || '', outputText);
    if (sim > maxSim) maxSim = sim;
  }

  state.last_outputs.push({ hash, text: outputText.slice(0, 500), timestamp: new Date().toISOString() });
  if (state.last_outputs.length > MAX_OUTPUT_HISTORY) {
    state.last_outputs = state.last_outputs.slice(-MAX_OUTPUT_HISTORY);
  }

  writeFeedbackState(projectRoot, state);

  const stuck = state.last_outputs.length >= 3 && maxSim >= SIMILARITY_THRESHOLD;
  return { stuck, similarity: maxSim, hash };
}

// ============================================================
// ESCALATION ADVISOR TRIGGER
// ============================================================

/**
 * Returns true if the escalation advisor should be triggered.
 * Condition: stuck_count > 3
 */
function shouldEscalate(projectRoot) {
  const state = readFeedbackState(projectRoot);
  return (state.stuck_count || 0) > 3;
}

module.exports = {
  getFeedbackStatePath,
  createDefaultState,
  readFeedbackState,
  writeFeedbackState,
  clearFeedbackState,
  activateFeedbackLoop,
  setDirtyBit,
  recordPhaseResult,
  checkExitGate,
  recordOutputAndCheckLoop,
  shouldEscalate,
};
