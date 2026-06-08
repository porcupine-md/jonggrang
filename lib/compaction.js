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

/**
 * Rough token estimate for a block of text (~4 chars per token).
 * Used for budget checks where an exact tokenizer is unnecessary.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

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
 * Parse a JSONL session file and estimate current context size.
 * Uses the LAST message's input_tokens as the best proxy for current context,
 * since each API call includes the full conversation context.
 * Falls back to the last message with usage data if the very last has none.
 * Returns { total, cacheRead, cacheCreate, input } or null.
 */
function parseSessionUsage(sessionFilePath) {
  if (!fs.existsSync(sessionFilePath)) return null;

  const lines = fs.readFileSync(sessionFilePath, 'utf8').split('\n').filter(Boolean);

  // Walk backwards to find the most recent message with usage data
  let lastUsage = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const usage = entry?.message?.usage || entry?.usage;
      if (usage && (usage.input_tokens || usage.cache_read_input_tokens)) {
        lastUsage = usage;
        break;
      }
    } catch {
      // skip malformed lines
    }
  }

  if (!lastUsage) return null;

  const cacheRead   = lastUsage.cache_read_input_tokens    || 0;
  const cacheCreate = lastUsage.cache_creation_input_tokens || 0;
  const input       = lastUsage.input_tokens               || 0;
  const total = cacheRead + cacheCreate + input;
  return { total, cacheRead, cacheCreate, input };
}

/**
 * Read cached compaction state from ephemeral file.
 * This is updated by hooks for OpenCode/Jonggrang engines.
 * Falls back to Claude Code session parsing if no cached state.
 */
function readCachedCompactionState(projectRoot) {
  const state = readCachedState(projectRoot);
  if (state) {
    // Accept cached state if it's less than 5 minutes old
    const age = Date.now() - new Date(state.updated_at).getTime();
    if (age < 300_000 && state.ratio != null) {
      return { ratio: state.ratio, tokens: state.tokens, breakdown: state.breakdown, source: 'cache' };
    }
  }
  return null;
}

/**
 * Get current context usage ratio for a project (0-1).
 * Checks cached state first (written by hooks for any engine),
 * then falls back to Claude Code session JSONL parsing.
 * Returns null if no data available.
 */
function getContextUsage(projectRoot) {
  // Try cached state first (works for all engines via hooks)
  const cached = readCachedCompactionState(projectRoot);
  if (cached) return cached;

  // Fall back to Claude Code session parsing
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
    source: 'claude-session',
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

  const { ratio } = usage;
  const tokens = usage.tokens ?? 0;
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
// EPHEMERAL STATE FILE (used by hooks for all engines)
// ============================================================

const COMPACTION_STATE_FILE = '.jonggrang/.ephemeral/compaction-state.json';

function stateFilePath(projectRoot) {
  return path.join(projectRoot, COMPACTION_STATE_FILE);
}

function writeCachedState(projectRoot, state) {
  const f = stateFilePath(projectRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(state, null, 2));
}

function readCachedState(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(projectRoot), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Refresh compaction state and write to disk.
 * Called before heavy phases and by hooks.
 */
function refreshCompactionState(projectRoot, externalUsage = null) {
  // If external usage data is provided (from hooks), update cache without checking Claude sessions
  if (externalUsage && externalUsage.ratio != null) {
    const state = {
      ratio: externalUsage.ratio,
      tokens: externalUsage.tokens,
      breakdown: externalUsage.breakdown || {},
      status: externalUsage.ratio >= THRESHOLDS.BLOCK ? 'block'
        : externalUsage.ratio >= THRESHOLDS.MUST ? 'must'
        : externalUsage.ratio >= THRESHOLDS.WARN ? 'warn'
        : 'ok',
      message: externalUsage.message || `Context at ${Math.round(externalUsage.ratio * 100)}%`,
      source: 'hook',
      updated_at: new Date().toISOString(),
    };
    writeCachedState(projectRoot, state);
    return state;
  }

  const gate = checkCompactionGate(projectRoot);
  const state = {
    ...gate,
    updated_at: new Date().toISOString(),
  };
  writeCachedState(projectRoot, state);
  return state;
}

module.exports = {
  THRESHOLDS,
  CONTEXT_WINDOW,
  estimateTokens,
  getClaudeProjectsDir,
  hashProjectPath,
  findLatestSessionFile,
  parseSessionUsage,
  getContextUsage,
  checkCompactionGate,
  shouldBlockAgentSpawn,
  writeCompactionState: writeCachedState,
  readCompactionState: readCachedState,
  refreshCompactionState,
};
