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
//      (permissionDecision:deny / decision:block + reason / additionalContext
//      / systemMessage for non-blocking warnings on Stop/SubagentStop)
//
// Exit codes (codex convention):
//   0  = success, continue
//   2  = block (PreToolUse) or continue-with-reason (Stop/SubagentStop)
//
// Fail-closed policy: PreToolUse deny hooks (blockSecretCommands,
//   blockSensitiveFiles, agentFirst) fail CLOSED on internal error — a
//   crashed blocker emits a deny + exit 2 rather than silently permitting
//   the risky tool call. Codex hooks are the SOLE enforcement boundary in
//   autonomous mode (--dangerously-bypass-approvals-and-sandbox), so a
//   fail-open deny hook = zero safety net. All other hooks fail OPEN.
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
  // Stop / SubagentStop
  feedbackLoop:             handlers.feedbackLoop,
  qualityGate:              handlers.qualityGate,
  outputEnforcement:        handlers.outputEnforcement,
  secretFinalCheck:         handlers.secretFinalCheck,
  taskSkillEnforcement:     handlers.taskSkillEnforcement,
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
  feedbackLoop:             'Stop',
  qualityGate:              'Stop',
  outputEnforcement:        'SubagentStop',
  secretFinalCheck:         'SubagentStop',
  taskSkillEnforcement:     'SubagentStop',
  taskRoleClaim:            'SubagentStart',
  sessionInit:              'SessionStart',
};

// ── Fail-closed policy ──────────────────────────────────────────────────
// PreToolUse deny hooks that fail CLOSED on internal error. A crashed
// blocker must not silently permit a blocked action — codex hooks are the
// SOLE enforcement boundary in autonomous mode
// (--dangerously-bypass-approvals-and-sandbox), so fail-open here = zero
// safety net. All other hooks fail OPEN (a non-blocking warning crash
// should not lock the agent).
const FAIL_CLOSED_HOOKS = new Set([
  'blockSecretCommands',
  'blockSensitiveFiles',
  'agentFirst',
]);

/**
 * React to a handler/dispatcher error. PreToolUse deny hooks in
 * FAIL_CLOSED_HOOKS emit a PreToolUse deny + exit 2 (fail-closed); every
 * other hook logs + exit 0 (fail-open).
 */
function handleHookError(hookName, err) {
  const msg = err && err.message ? err.message : String(err);
  const label = hookName || 'dispatcher';
  process.stderr.write(`[jonggrang-codex] ${label} error: ${msg}\n`);
  const codexEvent = CODEX_EVENT_FOR[hookName];
  if (codexEvent === 'PreToolUse' && FAIL_CLOSED_HOOKS.has(hookName)) {
    emitPreToolUseDeny(
      `[jonggrang] fail-closed: ${hookName} internal error (${msg}). ` +
      `Denying to avoid silently permitting a blocked action.`
    );
    process.exit(2);
  }
  process.exit(0);
}

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

/**
 * Emit a non-blocking warning/context message in the shape valid for the
 * firing codex event:
 *   - PostToolUse / SessionStart / SubagentStart → hookSpecificOutput.additionalContext
 *     (model-injected; docs-supported for these events).
 *   - Stop / SubagentStop → top-level systemMessage (common output field;
 *     these events do NOT support hookSpecificOutput.additionalContext per
 *     codex docs, so we use systemMessage to preserve non-blocking Layer 1
 *     warning parity with the claude task-skill-enforcement.sh reference).
 */
function emitNonBlockingContext(context, hookEvent) {
  if (hookEvent === 'Stop' || hookEvent === 'SubagentStop') {
    process.stdout.write(JSON.stringify({ systemMessage: context }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEvent,
        additionalContext: context,
      },
    }) + '\n');
  }
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
    handleHookError(hookName, e);
    return; // handleHookError exits
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

  // decision === 'allow' (with optional non-blocking warning context)
  if (result.context) {
    emitNonBlockingContext(result.context, codexEvent);
  }

  process.exit(0);
}

main().catch((e) => {
  handleHookError(process.argv[2], e);
});
