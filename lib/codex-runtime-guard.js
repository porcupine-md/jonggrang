'use strict';

// Best-effort runtime guard for `codex exec --json`.
//
// Important limitation: Codex JSONL events are observational. By the time
// Jonggrang sees item.started/item.completed, Codex has already dispatched the
// action. This guard is therefore a damage-control layer, not a native
// PreToolUse replacement: it can redact output before Jonggrang prints/captures
// it, track modifications, and abort the Codex process after a risky action is
// observed.

const path = require('path');
const {
  detectDomain,
  isSecretCommand,
  isSensitiveFile,
  sanitizeSecrets,
} = require('../hooks/codex/lib/policies');
const handlers = require('../hooks/codex/lib/handlers');
const {
  _extractPathsFromPatch: extractPathsFromPatch,
} = handlers;
const feedback = require('./feedback');

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function shellCommandFromArgs(args) {
  if (args.command) return String(args.command);
  if (args.cmd) return String(args.cmd);
  if (Array.isArray(args.argv)) return args.argv.join(' ');
  if (Array.isArray(args.args)) return args.args.join(' ');
  return '';
}

function extractCommand(item = {}) {
  if (typeof item.command === 'string') return item.command;
  if (typeof item.cmd === 'string') return item.cmd;
  if (typeof item.command_line === 'string') return item.command_line;
  if (typeof item.arguments === 'string' || typeof item.arguments === 'object') {
    return shellCommandFromArgs(parseJsonObject(item.arguments));
  }
  if (item.tool_input && typeof item.tool_input === 'object') {
    return shellCommandFromArgs(item.tool_input);
  }
  return '';
}

function extractArgs(item = {}) {
  if (item.tool_input && typeof item.tool_input === 'object') return item.tool_input;
  return parseJsonObject(item.arguments);
}

function extractFilePathsFromItem(item = {}) {
  const args = extractArgs(item);
  const paths = [];
  if (args.file_path) paths.push(String(args.file_path));
  if (args.path) paths.push(String(args.path));

  const command = extractCommand(item);
  if (command) paths.push(...extractPathsFromPatch(command));

  return [...new Set(paths.filter(Boolean))];
}

function isModificationItem(item = {}) {
  const type = String(item.type || '').toLowerCase();
  const name = String(item.name || item.tool_name || '').toLowerCase();
  const command = extractCommand(item);
  return type === 'command_execution'
    || name === 'apply_patch'
    || name === 'edit'
    || name === 'write'
    || /apply_patch/.test(command);
}

function markModifiedDomains(projectRoot, filePaths) {
  const domains = [];
  for (const filePath of filePaths) {
    if (!filePath || /^\.jonggrang\//.test(filePath)) continue;
    const domain = detectDomain(filePath);
    feedback.setDirtyBit(projectRoot, domain);
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

function formatRuntimeAbort(reason) {
  return [
    '=== CODEX RUNTIME GUARD ===',
    reason,
    '',
    'Codex native hooks are not reliably dispatched under `codex exec`, so this is a post-hoc damage-control abort, not a pre-execution deny. Review the workspace before continuing.',
  ].join('\n');
}

function inspectItemEvent(obj, projectRoot) {
  const eventType = obj?.type || '';
  if (eventType !== 'item.started' && eventType !== 'item.completed') return { action: 'allow' };

  const item = obj.item || {};
  const command = extractCommand(item);
  const filePaths = extractFilePathsFromItem(item);

  if (eventType === 'item.started' && command && isSecretCommand(command)) {
    return {
      action: 'abort',
      reason: formatRuntimeAbort(`Secret-like command observed after dispatch: ${command.slice(0, 160)}`),
    };
  }

  if (isModificationItem(item) && filePaths.length > 0) {
    for (const filePath of filePaths) {
      if (isSensitiveFile(filePath, projectRoot)) {
        return {
          action: 'abort',
          reason: formatRuntimeAbort(`Sensitive file modification/access observed after dispatch: ${filePath}`),
        };
      }
    }

    if (eventType === 'item.completed') {
      try {
        const domains = markModifiedDomains(projectRoot, filePaths);
        if (domains.length > 0) {
          return {
            action: 'allow',
            warning: `[jonggrang] codex runtime guard: dirty bit set for ${domains.join(', ')}`,
          };
        }
      } catch (err) {
        return {
          action: 'allow',
          warning: `[jonggrang] codex runtime guard: failed to set dirty bit: ${err.message}`,
        };
      }
    }
  }

  return { action: 'allow' };
}

function sanitizeText(text) {
  return sanitizeSecrets(text || '');
}

async function checkExitGates(projectRoot) {
  const ctx = { projectRoot, jonggrangLib: __dirname };
  for (const handler of [handlers.feedbackLoop, handlers.qualityGate]) {
    const result = await handler({}, ctx);
    if (result.decision === 'continue') {
      return {
        action: 'abort',
        reason: result.reason || 'Codex runtime guard blocked completion.',
      };
    }
  }
  return { action: 'allow' };
}

function createCodexRuntimeGuard({ projectRoot }) {
  return {
    inspectEvent(obj) {
      return inspectItemEvent(obj, projectRoot);
    },
    checkExitGates() {
      return checkExitGates(projectRoot);
    },
    sanitizeText,
  };
}

module.exports = {
  createCodexRuntimeGuard,
  extractCommand,
  extractFilePathsFromItem,
  inspectItemEvent,
  checkExitGates,
  sanitizeText,
  _formatRuntimeAbort: formatRuntimeAbort,
};
