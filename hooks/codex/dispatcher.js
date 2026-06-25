#!/usr/bin/env node
//
// JONGGRANG — Codex Hook Dispatcher
// Entry point invoked by .codex/hooks.json as: `node .../dispatcher.js <hookName>`
//
// Codex sends one JSON object on stdin per hook event. This dispatcher:
//   1. Reads <hookName> from argv (which jonggrang hook to run)
//   2. Reads the codex hook payload from stdin
//   3. Builds a normalized input + ctx for the handler
//   4. Calls the handler
//   5. Translates the handler result → codex's per-event output contract
//      (permissionDecision:deny / decision:block + reason / additionalContext)
//
// Exit codes (codex convention):
//   0  = success, continue
//   2  = block (PreToolUse) or continue-with-reason (Stop/SubagentStop)
//
// stdout = codex-format JSON (or nothing for plain exit 0)
// stderr = diagnostics (not model-visible)
//

'use strict';

const fs = require('fs');
const path = require('path');

const handlers = require('./lib/handlers');

// ── Handler registry: jonggrang hook name → handler fn ───────────────────
const HANDLER_MAP = {
  // PreToolUse
  blockSensitiveFiles:      handlers.blockSensitiveFiles,
  blockSecretCommands:      handlers.blockSecretCommands,
  agentFirst:               handlers.agentFirst,
  // PostToolUse
  trackModifications:        handlers.trackModifications,
  sanitizeOutput:           handlers.sanitizeOutput,
  taskSkillEnforcement:     handlers.taskSkillEnforcement,
  // Stop / SubagentStop
  feedbackLoop:             handlers.feedbackLoop,
  qualityGate:              handlers.qualityGate,
  outputEnforcement:        handlers.outputEnforcement,
  secretFinalCheck:         handlers.secretFinalCheck,
  // SubagentStart / SessionStart
  taskRoleClaim:            handlers.taskRoleClaim,
  sessionInit:              handlers.sessionInit,
};

// ── Codex event → jonggrang handler name mapping ─────────────────────────
// (which handler runs for a given codex event is decided by hooks.json matcher,
//  but the dispatcher also validates the argv hookName is sane)
const CODEX_EVENT_FOR = {
  blockSensitiveFiles:      'PreToolUse',
  blockSecretCommands:      'PreToolUse',
  agentFirst:               'PreToolUse',
  trackModifications:        'PostToolUse',
  sanitizeOutput:           'PostToolUse',
  taskSkillEnforcement:     'PostToolUse',
  feedbackLoop:             'Stop',
  qualityGate:              'Stop',
  outputEnforcement:        'SubagentStop',
  secretFinalCheck:         'SubagentStop',
  taskRoleClaim:            'SubagentStart',
  sessionInit:              'SessionStart',
};

// ── Helpers ──────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  process.stderr.write(`[jonggrang-codex] ${msg}\n`);
  process.exit(code);
}

/** Resolve jonggrang lib dir: .jonggrang/lib (user project) or lib (source repo). */
function resolveJonggrangLib(projectRoot) {
  const base = path.dirname(path.dirname(path.dirname(__filename))); // hooks/codex/ → repo/install root
  const candidates = [
    path.join(projectRoot, '.jonggrang', 'lib'),
    path.join(base, 'lib'),
    path.join(projectRoot, 'node_modules', 'jonggrang', 'lib'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[1]; // best-effort fallback
}

/** Emit codex-format output for a PreToolUse deny. */
function emitPreToolUseDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n');
}

/** Emit codex-format output for Stop/SubagentStop continue (decision:block = continue). */
function emitStopContinue(reason) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason,
  }) + '\n');
}

/** Emit additionalContext (non-blocking warn) — PostToolUse/SessionStart/SubagentStart. */
function emitAdditionalContext(context, hookEvent) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: hookEvent,
      additionalContext: context,
    },
  }) + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const hookName = process.argv[2];
  if (!hookName || !HANDLER_MAP[hookName]) {
    die(`unknown hook: ${hookName || '(none)'}. valid: ${Object.keys(HANDLER_MAP).join(', ')}`);
  }

  const handler = HANDLER_MAP[hookName];
  const codexEvent = CODEX_EVENT_FOR[hookName];

  // Read stdin payload
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (e) {
    die(`could not read stdin: ${e.message}`);
  }

  let input = {};
  if (raw.trim()) {
    try { input = JSON.parse(raw); }
    catch (e) { die(`could not parse stdin JSON: ${e.message}`); }
  }

  const projectRoot = input.cwd || process.env.JONGGRANG_PROJECT_ROOT || process.cwd();
  const jonggrangLib = resolveJonggrangLib(projectRoot);
  const ctx = { projectRoot, jonggrangLib, hookName };

  // ── Run handler ──────────────────────────────────────────────────────
  let result;
  try {
    result = await handler(input, ctx);
  } catch (e) {
    // Handler threw — fail open (don't block the agent) but log.
    process.stderr.write(`[jonggrang-codex] ${hookName} handler threw: ${e.message}\n`);
    process.exit(0);
  }

  if (!result) result = { decision: 'allow' };

  // Diagnostic stderr (not model-visible)
  if (result.stderr) {
    process.stderr.write(`[jonggrang-codex] ${result.stderr}\n`);
  }

  // ── Translate result → codex output per event type ───────────────────
  const decision = result.decision || 'allow';

  if (decision === 'deny') {
    // PreToolUse deny
    if (codexEvent === 'PreToolUse') {
      emitPreToolUseDeny(result.reason || 'blocked by jonggrang hook');
      process.exit(2);
    }
    // Stop/SubagentStop "deny" really means continue with reason
    if (codexEvent === 'Stop' || codexEvent === 'SubagentStop') {
      emitStopContinue(result.reason || 'jonggrang gate requires more work');
      process.exit(2);
    }
    // Other events can't deny — fall through to allow
  }

  if (decision === 'continue') {
    // Stop/SubagentStop continue with reason
    if (codexEvent === 'Stop' || codexEvent === 'SubagentStop') {
      emitStopContinue(result.reason || 'jonggrang gate requires more work');
      process.exit(2);
    }
    // PreToolUse can't "continue" — treat as allow with context
  }

  // decision === 'allow' (with optional additionalContext)
  if (result.context) {
    emitAdditionalContext(result.context, codexEvent);
  }

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[jonggrang-codex] fatal: ${e.message}\n`);
  process.exit(0); // fail open
});
