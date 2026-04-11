//
// JONGGRANG — Compaction Gate
// Token tracking + context budget enforcement
// Reads Claude Code session JSONL transcripts
// OpenCode: integrates via session.compacted event in plugin
//

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================
// THRESHOLDS
// ============================================================

const THRESHOLDS = {
  WARN:  0.75,   // 75% — should compact
  MUST:  0.80,   // 80% — must compact
  BLOCK: 0.85,   // 85% — hard block, refuse to spawn agents
};

const CONTEXT_WINDOW = 200_000; // Claude's context window in tokens

// ============================================================
// CLAUDE CODE — SESSION TRANSCRIPT READER
// ============================================================

/**
 * Find the Claude Code projects directory.
 */
function getClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Hash a project root path to its Claude Code project directory name.
 * Claude Code uses the absolute path with separators replaced by dashes.
 */
function hashProjectPath(projectRoot) {
  const abs = path.resolve(projectRoot);
  // Claude Code encodes path as: replace / with - (and leading -)
  return abs.replace(/\//g, '-');
}

/**
 * Find the most recent session JSONL file for a project.
 */
function findLatestSessionFile(projectRoot) {
  const projectHash = hashProjectPath(projectRoot);
  const claudeDir = path.join(getClaudeProjectsDir(), projectHash);

  if (!fs.existsSync(claudeDir)) return null;

  const files = fs.readdirSync(claudeDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(claudeDir, f),
      mtime: fs.statSync(path.join(claudeDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].path : null;
}

/**
 * Parse a JSONL session file and compute total token usage.
 * Sums: cache_read_input_tokens + cache_creation_input_tokens + input_tokens
 * Returns { total, cacheRead, cacheCreate, input } or null.
 */
function parseSessionUsage(sessionFilePath) {
  if (!fs.existsSync(sessionFilePath)) return null;

  const lines = fs.readFileSync(sessionFilePath, 'utf8').split('\n').filter(Boolean);
  let cacheRead = 0;
  let cacheCreate = 0;
  let input = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const usage = entry?.message?.usage || entry?.usage;
      if (usage) {
        cacheRead   += usage.cache_read_input_tokens    || 0;
        cacheCreate += usage.cache_creation_input_tokens || 0;
        input       += usage.input_tokens               || 0;
      }
    } catch {
      // skip malformed lines
    }
  }

  const total = cacheRead + cacheCreate + input;
  return { total, cacheRead, cacheCreate, input };
}

/**
 * Get current context usage ratio for a project (0-1).
 * Returns null if session file not found.
 */
function getContextUsage(projectRoot) {
  const sessionFile = findLatestSessionFile(projectRoot);
  if (!sessionFile) return null;

  const usage = parseSessionUsage(sessionFile);
  if (!usage) return null;

  return {
    ratio: Math.min(usage.total / CONTEXT_WINDOW, 1),
    tokens: usage.total,
    breakdown: {
      cache_read: usage.cacheRead,
      cache_create: usage.cacheCreate,
      input: usage.input,
    },
  };
}

// ============================================================
// COMPACTION GATE
// ============================================================

/**
 * Check compaction status for a project.
 * @returns {{ status: 'ok'|'warn'|'must'|'block', ratio: number, message: string }}
 */
function checkCompactionGate(projectRoot) {
  const usage = getContextUsage(projectRoot);

  if (!usage) {
    // Can't determine — be permissive but note it
    return {
      status: 'ok',
      ratio: 0,
      message: 'Context usage unknown (no session file). Proceeding.',
    };
  }

  const { ratio, tokens } = usage;
  const pct = Math.round(ratio * 100);

  if (ratio >= THRESHOLDS.BLOCK) {
    return {
      status: 'block',
      ratio,
      tokens,
      message: `HARD BLOCK: Context at ${pct}% (${tokens.toLocaleString()} / ${CONTEXT_WINDOW.toLocaleString()} tokens). Run /compact before spawning new agents.`,
    };
  }

  if (ratio >= THRESHOLDS.MUST) {
    return {
      status: 'must',
      ratio,
      tokens,
      message: `MUST COMPACT: Context at ${pct}%. Strongly recommended before heavy phases. Run /compact now.`,
    };
  }

  if (ratio >= THRESHOLDS.WARN) {
    return {
      status: 'warn',
      ratio,
      tokens,
      message: `WARNING: Context at ${pct}%. Consider running /compact before heavy execution phases.`,
    };
  }

  return {
    status: 'ok',
    ratio,
    tokens,
    message: `Context healthy at ${pct}% (${tokens.toLocaleString()} tokens).`,
  };
}

/**
 * Returns true if spawning new agents should be blocked.
 */
function shouldBlockAgentSpawn(projectRoot) {
  const gate = checkCompactionGate(projectRoot);
  return gate.status === 'block';
}

// ============================================================
// COMPACTION STATE FILE
// For use by hooks (hook reads state file written by compaction.js)
// ============================================================

const COMPACTION_STATE_FILE = '.jonggrang/.ephemeral/compaction-state.json';

function writeCompactionState(projectRoot, state) {
  const stateFile = path.join(projectRoot, COMPACTION_STATE_FILE);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function readCompactionState(projectRoot) {
  const stateFile = path.join(projectRoot, COMPACTION_STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Refresh compaction state and write to disk.
 * Called before heavy phases and by hooks.
 */
function refreshCompactionState(projectRoot) {
  const gate = checkCompactionGate(projectRoot);
  const state = {
    ...gate,
    updated_at: new Date().toISOString(),
  };
  writeCompactionState(projectRoot, state);
  return state;
}

module.exports = {
  THRESHOLDS,
  CONTEXT_WINDOW,
  getClaudeProjectsDir,
  hashProjectPath,
  findLatestSessionFile,
  parseSessionUsage,
  getContextUsage,
  checkCompactionGate,
  shouldBlockAgentSpawn,
  writeCompactionState,
  readCompactionState,
  refreshCompactionState,
};
