//
// JONGGRANG — Distributed File Locking
// Prevents race conditions when multiple developer agents run in parallel
// Lock files: .jonggrang/locks/{agentId}.lock
//

const fs = require('fs');
const path = require('path');

const LOCKS_DIR = '.jonggrang/locks';

// ============================================================
// PATH HELPERS
// ============================================================

function getLocksDir(projectRoot) {
  return path.join(projectRoot, LOCKS_DIR);
}

function getLockPath(projectRoot, agentId) {
  return path.join(getLocksDir(projectRoot), `${agentId}.lock`);
}

// ============================================================
// LOCK OPERATIONS
// ============================================================

/**
 * Acquire a lock for an agent on a set of files.
 * Returns { acquired: bool, conflicts: Array<{file, owner}> }
 */
function acquireLock(projectRoot, agentId, files = []) {
  const locksDir = getLocksDir(projectRoot);
  fs.mkdirSync(locksDir, { recursive: true });

  // Check for conflicts with existing locks
  const conflicts = [];
  const existingLocks = readAllLocks(projectRoot);

  for (const [lockOwner, lockData] of Object.entries(existingLocks)) {
    if (lockOwner === agentId) continue;
    for (const file of files) {
      if ((lockData.files || []).includes(file)) {
        conflicts.push({ file, owner: lockOwner });
      }
    }
  }

  if (conflicts.length > 0) {
    return { acquired: false, conflicts };
  }

  const lockPath = getLockPath(projectRoot, agentId);
  const lockData = {
    agent_id: agentId,
    files,
    acquired_at: new Date().toISOString(),
    pid: process.pid,
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));
  return { acquired: true, conflicts: [] };
}

/**
 * Release an agent's lock.
 * Returns true if a lock was found and removed.
 */
function releaseLock(projectRoot, agentId) {
  const lockPath = getLockPath(projectRoot, agentId);
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
    return true;
  }
  return false;
}

/**
 * Check if a file is locked by any agent (optionally excluding one).
 * Returns { locked: bool, owner?: string, lockData?: object }
 */
function isFileLocked(projectRoot, filePath, excludeAgent = null) {
  const locks = readAllLocks(projectRoot);
  for (const [owner, lockData] of Object.entries(locks)) {
    if (excludeAgent && owner === excludeAgent) continue;
    if ((lockData.files || []).includes(filePath)) {
      return { locked: true, owner, lockData };
    }
  }
  return { locked: false };
}

/**
 * Read all active lock files.
 * Returns { agentId: lockData }
 */
function readAllLocks(projectRoot) {
  const locksDir = getLocksDir(projectRoot);
  if (!fs.existsSync(locksDir)) return {};

  const locks = {};
  const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.lock'));

  for (const file of files) {
    const agentId = file.replace(/\.lock$/, '');
    try {
      const content = fs.readFileSync(path.join(locksDir, file), 'utf8');
      locks[agentId] = JSON.parse(content);
    } catch {
      // skip malformed lock files
    }
  }

  return locks;
}

/**
 * Clean up stale lock files from crashed agents.
 * A lock is stale if older than maxAgeMs (default: 30 minutes).
 * Returns array of cleaned agent IDs.
 */
function cleanStaleLocks(projectRoot, maxAgeMs = 30 * 60 * 1000) {
  const locksDir = getLocksDir(projectRoot);
  if (!fs.existsSync(locksDir)) return [];

  const cleaned = [];
  const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.lock'));
  const now = Date.now();

  for (const file of files) {
    const lockPath = path.join(locksDir, file);
    try {
      const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const acquiredAt = new Date(content.acquired_at).getTime();
      if (now - acquiredAt > maxAgeMs) {
        fs.unlinkSync(lockPath);
        cleaned.push(file.replace(/\.lock$/, ''));
      }
    } catch {
      // remove malformed lock files
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  return cleaned;
}

module.exports = {
  getLocksDir,
  getLockPath,
  acquireLock,
  releaseLock,
  isFileLocked,
  readAllLocks,
  cleanStaleLocks,
};
