//
// JONGGRANG — Codex Hook Handlers
// One handler per jonggrang enforcement hook. Each mirrors the logic in
// hooks/claude/<name>.sh but in JS, using hooks/codex/lib/policies.js
// for the shared secret/sensitive-file/domain logic.
//
// Handler contract:
//   async (input, ctx) => {
//     decision: 'allow' | 'deny' | 'continue',
//     reason?:   string,   // model-visible block reason
//     context?:  string,   // additionalContext (PostToolUse warn / SessionStart)
//     stderr?:   string,   // diagnostic to stderr (not model-visible)
//   }
//
// ctx = { projectRoot, jonggrangLib, hookName }
//   - projectRoot:  from input.cwd (set by dispatcher)
//   - jonggrangLib: resolved path to lib/ (or .jonggrang/lib/) for feedback.js / compaction.js
//

const fs = require('fs');
const path = require('path');
const {
  isSensitiveFile, isSecretCommand, sanitizeSecrets, detectDomain,
} = require('./policies');

// ── Helpers ──────────────────────────────────────────────────────────────

/** Extract file paths from an apply_patch command (*** Add/Update/Delete File: <path>). */
function extractPathsFromPatch(command) {
  if (!command || typeof command !== 'string') return [];
  const paths = [];
  const re = /\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    paths.push(m[1].trim());
  }
  return paths;
}

/** Extract file paths from codex tool_input (handles apply_patch command + file_path/path). */
function extractFilePaths(toolInput, toolName) {
  const ti = toolInput || {};
  const paths = [];
  if (ti.file_path) paths.push(ti.file_path);
  if (ti.path) paths.push(ti.path);
  if (ti.command && /apply_patch/i.test(toolName || '')) {
    paths.push(...extractPathsFromPatch(ti.command));
  }
  // Glob matcher (e.g. Grep "*.pem") — codex MCP tools send args directly
  if (ti.glob) paths.push(ti.glob);
  return paths;
}

/** Read+parse JSON file, return {} on missing/error. */
function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return {}; }
}

/** Write JSON file, mkdir-p the parent. Swallow errors (non-blocking hooks). */
function writeJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch { return false; }
}

// ── PreToolUse handlers ──────────────────────────────────────────────────

/** block-sensitive-files — deny access to certs, keys, unprotected .env. */
async function blockSensitiveFiles(input, ctx) {
  const toolName = input.tool_name || '';
  const paths = extractFilePaths(input.tool_input, toolName);
  if (paths.length === 0) return { decision: 'allow' };

  for (const p of paths) {
    if (isSensitiveFile(p, ctx.projectRoot)) {
      return {
        decision: 'deny',
        reason: `DENIED: Access to '${p}' is blocked — sensitive file. Use a secret manager or an appropriate wrapper instead.`,
      };
    }
  }
  return { decision: 'allow' };
}

/** block-secret-commands — deny Bash commands that dump secrets into LLM context. */
async function blockSecretCommands(input, _ctx) {
  const command = (input.tool_input && input.tool_input.command) || '';
  if (!command) return { decision: 'allow' };

  if (isSecretCommand(command)) {
    return {
      decision: 'deny',
      reason: `SECRET COMMAND BLOCKED: Command '${command.slice(0, 120)}' may expose secrets. Use 'run-with-secrets <profile> <cmd>' to access credentials safely.`,
    };
  }
  return { decision: 'allow' };
}

/** agent-first — block direct edits when a domain specialist is registered. */
async function agentFirst(input, ctx) {
  const toolName = input.tool_name || '';
  const paths = extractFilePaths(input.tool_input, toolName);
  if (paths.length === 0) return { decision: 'allow' };

  const agentsRegistry = path.join(ctx.projectRoot, '.jonggrang', '.output', 'agents-registry.json');
  if (!fs.existsSync(agentsRegistry)) return { decision: 'allow' };

  const registry = readJson(agentsRegistry);

  for (const filePath of paths) {
    const domain = detectDomain(filePath);
    if (!registry[domain]) continue;

    // Are we running AS a specialized agent? Check session-roles.json.
    const sessionId = input.session_id || '';
    let sessionRole = '';
    if (sessionId) {
      const roles = readJson(path.join(ctx.projectRoot, '.jonggrang', '.ephemeral', 'session-roles.json'));
      sessionRole = roles[sessionId] || '';
    }
    if (sessionRole === 'developer' || sessionRole === 'tester') continue;

    return {
      decision: 'deny',
      reason: `AGENT-FIRST ENFORCEMENT: Cannot edit ${filePath} directly. A '${domain}' specialist is registered. Spawn '${domain}-developer' agent instead.`,
    };
  }
  return { decision: 'allow' };
}

// ── PostToolUse handlers ─────────────────────────────────────────────────

/** track-modifications — set dirty bit for the modified domain (non-blocking). */
async function trackModifications(input, ctx) {
  const toolName = input.tool_name || '';
  const paths = extractFilePaths(input.tool_input, toolName);
  if (paths.length === 0) return { decision: 'allow' };

  let fb;
  try { fb = require(path.join(ctx.jonggrangLib, 'feedback.js')); }
  catch (e) {
    return { decision: 'allow', stderr: `[jonggrang] track-modifications: feedback.js unavailable: ${e.message}` };
  }

  for (const filePath of paths) {
    // Skip .jonggrang/ orchestration files — ephemeral plans/reports aren't production code
    if (/\.jonggrang\//.test(filePath)) continue;
    const domain = detectDomain(filePath);
    try { fb.setDirtyBit(ctx.projectRoot, domain); }
    catch (e) { return { decision: 'allow', stderr: `[jonggrang] track-modifications warning: ${e.message}` }; }
  }
  return { decision: 'allow', stderr: `[jonggrang] dirty bit set for modified domains` };
}

/** sanitize-output — warn if tool output contains leaked secrets (non-blocking). */
async function sanitizeOutput(input, _ctx) {
  const output = input.tool_response || '';
  if (!output || typeof output !== 'string') return { decision: 'allow' };

  const sanitized = sanitizeSecrets(output);
  if (sanitized !== output) {
    return {
      decision: 'allow',
      context: '⚠ SECRET LEAK DETECTED in tool output. DO NOT repeat the raw secret values, do NOT write them to files, and do NOT commit them. Treat them as untrusted and surface the leak to the user.\n\n---\nREDACTED OUTPUT:\n' + sanitized + '\n---',
    };
  }
  return { decision: 'allow' };
}

/** task-skill-enforcement — warn if subagent output lacks persisting-agent-outputs marker. */
async function taskSkillEnforcement(input, _ctx) {
  const output = input.tool_response || input.last_assistant_message || '';
  if (!output) return { decision: 'allow' };

  if (!/(jonggrang-output|\.jonggrang\/\.output|persisting-agent-outputs)/i.test(output)) {
    return {
      decision: 'allow',
      context: '⚠ [jonggrang] SKILL COMPLIANCE: agent may not have invoked persisting-agent-outputs. Outputs should be written to .jonggrang/.output/features/{feature_id}/ with jonggrang-output: true.',
    };
  }
  return { decision: 'allow' };
}

// ── Stop / SubagentStop handlers ─────────────────────────────────────────

/** feedback-loop — block exit until all modified domains pass review+testing. */
async function feedbackLoop(_input, ctx) {
  const statePath = path.join(ctx.projectRoot, '.jonggrang', '.ephemeral', 'feedback-loop-state.json');
  const state = readJson(statePath);
  if (state.active !== true || state.dirty_bit !== true) return { decision: 'allow' };

  let fb;
  try { fb = require(path.join(ctx.jonggrangLib, 'feedback.js')); }
  catch (e) {
    return { decision: 'allow', stderr: `[jonggrang] feedback-loop: feedback.js unavailable: ${e.message}` };
  }

  let result;
  try { result = fb.checkExitGate(ctx.projectRoot); }
  catch (e) { result = { allowed: true, reason: 'feedback.js error: ' + e.message }; }

  if (result.allowed) return { decision: 'allow' };

  let reason = result.reason || 'Feedback loop: pending review/testing';
  if ((result.stuck_count || 0) > 3) {
    reason = `=== ESCALATION ADVISOR ===\nAgent stuck for ${result.stuck_count} consecutive exits. Review feedback-loop-state.json.\n\n=== FEEDBACK LOOP GATE ===\n${reason}`;
  } else {
    reason = `=== FEEDBACK LOOP GATE ===\n${reason}\n\nTo unblock:\n  1. Spawn reviewer agent for each modified domain\n  2. Spawn tester agent for each modified domain\n  3. Both must return PASS status`;
  }
  return { decision: 'continue', reason };
}

/** quality-gate — defense-in-depth: untracked .md + feedback dirty bit. */
async function qualityGate(_input, ctx) {
  const violations = [];

  // Check 1: untracked .md outside .jonggrang/.output/
  let untrackedMd = [];
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('git', ['-C', ctx.projectRoot, 'ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    untrackedMd = out.split('\n').filter(f => f.endsWith('.md')
      && !f.startsWith('.jonggrang/')
      && !f.startsWith('.claude/')
      && !f.startsWith('.opencode/')
      && !['AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'progress.txt'].includes(f)
    ).slice(0, 10);
  } catch { /* git not available */ }

  for (const f of untrackedMd) violations.push(`Untracked .md outside .jonggrang/.output/: ${f}`);

  // Check 2: feedback loop dirty bit
  const state = readJson(path.join(ctx.projectRoot, '.jonggrang', '.ephemeral', 'feedback-loop-state.json'));
  if (state.active === true && state.dirty_bit === true) {
    violations.push('Feedback loop dirty bit still set — review/testing incomplete');
  }

  if (violations.length === 0) return { decision: 'allow' };
  return {
    decision: 'continue',
    reason: `=== QUALITY GATE VIOLATIONS ===\n${violations.map(v => '  ✗ ' + v).join('\n')}\n\nResolve violations before completing this phase.`,
  };
}

/** output-enforcement — block subagent exit if outputs scattered outside .jonggrang/.output/. */
async function outputEnforcement(_input, ctx) {
  const violations = [];
  const allowedPatterns = [
    /^\.jonggrang\//, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^SKILL\.md$/, /^progress\.txt$/,
    /^README\.md$/, /^CHANGELOG\.md$/, /^CONTRIBUTING\.md$/, /^docs\//,
    /^\.claude\//, /^\.opencode\//, /^\.codex\//,
  ];

  try {
    const { execFileSync } = require('child_process');
    const untracked = execFileSync('git', ['-C', ctx.projectRoot, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
    const staged = execFileSync('git', ['-C', ctx.projectRoot, 'diff', '--name-only', '--cached'], { encoding: 'utf8' });
    const allNew = [...untracked.split('\n'), ...staged.split('\n')].filter(f => f.endsWith('.md'));

    for (const f of allNew) {
      if (!f) continue;
      if (!allowedPatterns.some(p => p.test(f))) {
        violations.push(`Unapproved .md file: ${f} (should be in .jonggrang/.output/)`);
      }
    }
  } catch { /* git not available */ }

  if (violations.length === 0) return { decision: 'allow' };
  return {
    decision: 'continue',
    reason: `=== OUTPUT LOCATION VIOLATIONS ===\n${violations.map(v => '  ✗ ' + v).join('\n')}\n\nMove output files to .jonggrang/.output/features/{feature_id}/`,
  };
}

/** secret-final-check — trufflehog scan on modified files before subagent completes. */
async function secretFinalCheck(_input, ctx) {
  let modified = [];
  try {
    const { execFileSync } = require('child_process');
    const diff = execFileSync('git', ['-C', ctx.projectRoot, 'diff', '--name-only'], { encoding: 'utf8' });
    const cached = execFileSync('git', ['-C', ctx.projectRoot, 'diff', '--name-only', '--cached'], { encoding: 'utf8' });
    const others = execFileSync('git', ['-C', ctx.projectRoot, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
    modified = [...diff.split('\n'), ...cached.split('\n'), ...others.split('\n')]
      .filter(f => f).filter((v, i, a) => a.indexOf(v) === i);
  } catch { return { decision: 'allow' }; }

  if (modified.length === 0) return { decision: 'allow' };

  // trufflehog is optional — skip gracefully if absent
  try {
    require('child_process').execFileSync('trufflehog', ['--version'], { stdio: 'ignore' });
  } catch {
    return { decision: 'allow', stderr: '[jonggrang] trufflehog not installed — secret scan skipped' };
  }

  const os = require('os');
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-codex-scan-'));
  try {
    for (const f of modified) {
      const src = path.join(ctx.projectRoot, f);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(scanDir, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    const { execFileSync } = require('child_process');
    const leaked = execFileSync('trufflehog', ['filesystem', `--directory=${scanDir}`, '--only-verified', '--json', '--no-update'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (leaked && leaked.trim()) {
      return {
        decision: 'continue',
        reason: `BLOCKED: Secret detected in modified files. Remove the secret and replace it with a secret manager reference before completing the task. Findings: ${leaked.slice(0, 500)}`,
      };
    }
  } catch (e) {
    return { decision: 'allow', stderr: `[jonggrang] secret-final-check: ${e.message}` };
  } finally {
    try { fs.rmSync(scanDir, { recursive: true, force: true }); } catch {}
  }
  return { decision: 'allow' };
}

// ── SubagentStart / SessionStart handlers ────────────────────────────────

/** task-role-claim — queue a pending role before a subagent spawns (non-blocking). */
async function taskRoleClaim(input, ctx) {
  const desc = (input.agent_type || input.prompt || input.description || '').toLowerCase();
  let role = '';
  if (/\b(tester|testing agent)\b/.test(desc)) role = 'tester';
  else if (/\b(reviewer|review agent|auditor)\b/.test(desc)) role = 'reviewer';
  else if (/test[- ]lead|test strategy/.test(desc)) role = 'test-lead';
  else if (/\b(lead|architect|architecture)\b/.test(desc)) role = 'lead';
  else if (/\b(developer|implement|executor)\b/.test(desc)) role = 'developer';
  if (!role) return { decision: 'allow' };

  const pendingDir = path.join(ctx.projectRoot, '.jonggrang', '.ephemeral', 'pending-roles');
  const ts = `${Date.now()}${process.hrtime.bigint() % 1000000n}`;
  writeJson(path.join(pendingDir, `${ts}.json`), { role, created_at: new Date().toISOString() });
  return { decision: 'allow', stderr: `[jonggrang] Pending role queued for next session: ${role}` };
}

/** session-init — register this session's role (non-blocking). */
async function sessionInit(input, ctx) {
  const sessionId = input.session_id || '';
  if (!sessionId) return { decision: 'allow' };

  const rolesPath = path.join(ctx.projectRoot, '.jonggrang', '.ephemeral', 'session-roles.json');
  const roles = readJson(rolesPath);
  if (roles[sessionId]) return { decision: 'allow' };

  // 1. Detect role from prompt
  const prompt = (input.prompt || '').toLowerCase();
  let role = '';
  if (/you are a specialized tester|specialized tester/.test(prompt)) role = 'tester';
  else if (/you are a specialized reviewer|specialized reviewer/.test(prompt)) role = 'reviewer';
  else if (/you are a test lead|test lead/.test(prompt)) role = 'test-lead';
  else if (/you are a specialized lead|specialized lead/.test(prompt)) role = 'lead';
  else if (/you are a specialized developer|specialized developer/.test(prompt)) role = 'developer';

  // 2. Fallback: claim oldest pending role
  if (!role) {
    const pendingDir = path.join(ctx.projectRoot, '.jonggrang', '.ephemeral', 'pending-roles');
    if (fs.existsSync(pendingDir)) {
      const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).sort();
      if (files.length > 0) {
        const oldest = path.join(pendingDir, files[0]);
        const data = readJson(oldest);
        role = data.role || '';
        try { fs.unlinkSync(oldest); } catch {}
      }
    }
  }

  if (!role) return { decision: 'allow' };

  roles[sessionId] = role;
  writeJson(rolesPath, roles);
  return { decision: 'allow', stderr: `[jonggrang] Session ${sessionId} registered as: ${role}` };
}

/** compaction-gate — block agent spawn when context > threshold.
 *  NOTE: codex has no PreToolUse "Task" tool to intercept subagent spawning,
 *  so this handler is implemented for parity/testing but NOT wired into
 *  hooks.json. See docs/AGENTTOOLS.md "Known gaps" for details. */
async function compactionGate(_input, ctx) {
  let compaction;
  try { compaction = require(path.join(ctx.jonggrangLib, 'compaction.js')); }
  catch (e) { return { decision: 'allow', stderr: `[jonggrang] compaction-gate: compaction.js unavailable: ${e.message}` }; }

  let gate;
  try { gate = compaction.checkCompactionGate(ctx.projectRoot); }
  catch (e) { return { decision: 'allow', stderr: `[jonggrang] compaction-gate warning: ${e.message}` }; }

  if (gate.status === 'block') {
    return {
      decision: 'deny',
      reason: `COMPACTION GATE BLOCKED: ${gate.message}\nRun /compact to clear context before spawning new agents.`,
    };
  }
  if (gate.status === 'must' || gate.status === 'warn') {
    return { decision: 'allow', context: `⚠ COMPACTION WARNING: ${gate.message}` };
  }
  return { decision: 'allow' };
}

module.exports = {
  // PreToolUse
  blockSensitiveFiles,
  blockSecretCommands,
  agentFirst,
  compactionGate,
  // PostToolUse
  trackModifications,
  sanitizeOutput,
  taskSkillEnforcement,
  // Stop / SubagentStop
  feedbackLoop,
  qualityGate,
  outputEnforcement,
  secretFinalCheck,
  // SubagentStart / SessionStart
  taskRoleClaim,
  sessionInit,
  // helpers (exported for testing)
  _extractPathsFromPatch: extractPathsFromPatch,
  _extractFilePaths: extractFilePaths,
};
