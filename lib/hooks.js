//
// JONGGRANG — Universal Hook Abstraction Layer
// Generates Claude Code settings.json hooks + OpenCode plugin.js
// from a single unified hook configuration.
//

const fs = require('fs');
const path = require('path');

// ============================================================
// HOOK EVENT MAPPING
// Maps universal events → tool-specific event names
// ============================================================

const EVENT_MAP = {
  // Universal event          Claude Code hook type     OpenCode event name
  pre_tool:     { claude: 'PreToolUse',               opencode: 'tool.execute.before' },
  post_tool:    { claude: 'PostToolUse',              opencode: 'tool.execute.after'  },
  stop:         { claude: 'Stop',                     opencode: 'session.idle'        },
  agent_stop:   { claude: 'SubagentStop',             opencode: 'session.updated'     },
  session_start:{ claude: 'UserPromptSubmit',         opencode: 'session.created'     },
  file_edit:    { claude: 'PostToolUse',              opencode: 'file.edited'         },
  compaction:   { claude: 'PreToolUse',               opencode: 'session.compacted'   },
};

// ============================================================
// HOOK DEFINITIONS
// Each hook references a script in hooks/claude/ or hooks/opencode/
// ============================================================

const HOOK_DEFINITIONS = {
  // Agent-First Enforcement
  // Blocks orchestrator from directly editing files (must delegate to worker)
  agent_first: {
    event: 'pre_tool',
    description: 'Block direct file edits — force delegation to specialized agents',
    claude_script: 'hooks/claude/agent-first.sh',
    opencode_handler: 'agentFirst',
    match_tools: ['Edit', 'Write'],   // only intercept these tools
    blocking: true,
  },

  // Compaction Gate
  // Blocks agent spawning when context > 85%
  compaction_gate: {
    event: 'pre_tool',
    description: 'Block new agent spawning when context budget exceeded',
    claude_script: 'hooks/claude/compaction-gate.sh',
    opencode_handler: 'compactionGate',
    match_tools: ['Task'],
    blocking: true,
  },

  // Track Modifications (Dirty Bit)
  // Sets dirty bit when files are modified
  track_modifications: {
    event: 'post_tool',
    description: 'Track file modifications and set domain dirty bit',
    claude_script: 'hooks/claude/track-modifications.sh',
    opencode_handler: 'trackModifications',
    match_tools: ['Edit', 'Write'],
    blocking: false,
  },

  // Feedback Loop Stop Gate
  // Blocks agent exit until review + testing pass for all modified domains
  feedback_loop: {
    event: 'stop',
    description: 'Block exit until all modified domains pass review and testing',
    claude_script: 'hooks/claude/feedback-loop.sh',
    opencode_handler: 'feedbackLoop',
    blocking: true,
  },

  // Quality Gate (defense-in-depth backup for feedback loop)
  quality_gate: {
    event: 'stop',
    description: 'Final quality gate — defense in depth backup check',
    claude_script: 'hooks/claude/quality-gate.sh',
    opencode_handler: 'qualityGate',
    blocking: true,
  },

  // Output Location Enforcement
  // Blocks agent exit if output files are in wrong locations
  output_enforcement: {
    event: 'agent_stop',
    description: 'Enforce output files are in .jonggrang/.output/ not scattered',
    claude_script: 'hooks/claude/output-enforcement.sh',
    opencode_handler: 'outputEnforcement',
    blocking: true,
  },
};

// ============================================================
// CLAUDE CODE HOOK GENERATOR
// Generates .claude/settings.json hooks array entries
// ============================================================

function generateClaudeHooks(projectRoot, enabledHooks = null) {
  const hooks = enabledHooks || Object.keys(HOOK_DEFINITIONS);
  const result = [];

  for (const hookKey of hooks) {
    const hookDef = HOOK_DEFINITIONS[hookKey];
    if (!hookDef) continue;

    const claudeEventType = EVENT_MAP[hookDef.event]?.claude;
    if (!claudeEventType) continue;

    const scriptPath = path.join(projectRoot, hookDef.claude_script);

    const hookEntry = {
      matcher: hookDef.match_tools ? hookDef.match_tools.join('|') : '',
      hooks: [
        {
          type: claudeEventType,
          command: `bash "${scriptPath}"`,
        },
      ],
    };

    result.push(hookEntry);
  }

  return result;
}

/**
 * Write Claude Code hooks to .claude/settings.json in a project.
 * Merges with existing settings if present.
 */
function installClaudeHooks(projectRoot, enabledHooks = null) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

  let existing = {};
  try {
    if (fs.existsSync(settingsPath)) {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch {
    existing = {};
  }

  const jonggrangHooks = buildClaudeSettingsHooks(projectRoot, enabledHooks);
  existing.hooks = jonggrangHooks;

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
  return settingsPath;
}

/**
 * Build the hooks array for Claude Code settings.json.
 * Groups hooks by event type as Claude Code expects.
 */
function buildClaudeSettingsHooks(projectRoot, enabledHooks = null) {
  const hooks = enabledHooks || Object.keys(HOOK_DEFINITIONS);
  const byEvent = {};

  for (const hookKey of hooks) {
    const hookDef = HOOK_DEFINITIONS[hookKey];
    if (!hookDef) continue;

    const claudeEvent = EVENT_MAP[hookDef.event]?.claude;
    if (!claudeEvent) continue;

    if (!byEvent[claudeEvent]) byEvent[claudeEvent] = [];

    const scriptPath = path.resolve(projectRoot, hookDef.claude_script);
    const entry = { command: `bash "${scriptPath}"` };
    if (hookDef.match_tools && hookDef.match_tools.length > 0) {
      entry.matcher = hookDef.match_tools.join('|');
    }

    byEvent[claudeEvent].push(entry);
  }

  // Claude Code settings.json format:
  // { hooks: { PreToolUse: [...], PostToolUse: [...], Stop: [...] } }
  return byEvent;
}

// ============================================================
// OPENCODE PLUGIN GENERATOR
// Generates .opencode/plugins/jonggrang.js plugin
// ============================================================

function generateOpenCodePlugin(projectRoot) {
  // The plugin references the hook handlers from hooks/opencode/plugin.js
  const pluginPath = path.join(projectRoot, 'hooks', 'opencode', 'plugin.js');

  return `// Auto-generated by jonggrang
// OpenCode plugin — delegates to hooks/opencode/plugin.js
const handlers = require("${pluginPath}");
module.exports = handlers.createPlugin;
`;
}

/**
 * Install OpenCode plugin in project.
 * Creates .opencode/plugins/jonggrang.js and registers in opencode.json.
 */
function installOpenCodePlugin(projectRoot, jonggrangInstallDir) {
  const pluginsDir = path.join(projectRoot, '.opencode', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  // Write plugin entry point that points to jonggrang's hooks
  const pluginEntry = path.join(pluginsDir, 'jonggrang.js');
  const handlerPath = path.join(jonggrangInstallDir, 'hooks', 'opencode', 'plugin.js');

  fs.writeFileSync(pluginEntry, [
    `// Jonggrang orchestration plugin for OpenCode`,
    `// Generated by: jonggrang init`,
    `const { createPlugin } = require(${JSON.stringify(handlerPath)});`,
    `module.exports = createPlugin(${JSON.stringify(projectRoot)});`,
  ].join('\n'));

  // Register in opencode.json
  const opencodeCfg = path.join(projectRoot, 'opencode.json');
  let cfg = {};
  try {
    if (fs.existsSync(opencodeCfg)) cfg = JSON.parse(fs.readFileSync(opencodeCfg, 'utf8'));
  } catch {}

  if (!cfg.plugins) cfg.plugins = [];
  const relPath = path.relative(projectRoot, pluginEntry);
  if (!cfg.plugins.includes(relPath)) cfg.plugins.push(relPath);

  fs.writeFileSync(opencodeCfg, JSON.stringify(cfg, null, 2));
  return pluginEntry;
}

// ============================================================
// AUTO-DETECT AND INSTALL
// ============================================================

/**
 * Install hooks for the appropriate tool (claude or opencode).
 * Called during `jonggrang init`.
 */
function installHooksForTool(projectRoot, tool, jonggrangInstallDir) {
  const results = {};

  // Copy hook scripts from jonggrang install dir into project
  if (jonggrangInstallDir) {
    const srcHooks = path.join(jonggrangInstallDir, 'hooks');
    const destHooks = path.join(projectRoot, 'hooks');
    if (fs.existsSync(srcHooks)) {
      copyDirRecursive(srcHooks, destHooks);
    }
  }

  if (tool === 'claude' || tool === 'both') {
    const settingsPath = installClaudeHooks(projectRoot);
    results.claude = { installed: true, path: settingsPath };
  }

  if (tool === 'opencode' || tool === 'both') {
    const pluginPath = installOpenCodePlugin(projectRoot, jonggrangInstallDir);
    results.opencode = { installed: true, path: pluginPath };
  }

  return results;
}

/**
 * Recursively copy a directory.
 */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      // Preserve execute bit for shell scripts
      if (entry.name.endsWith('.sh')) {
        fs.chmodSync(destPath, 0o755);
      }
    }
  }
}

module.exports = {
  EVENT_MAP,
  HOOK_DEFINITIONS,
  generateClaudeHooks,
  installClaudeHooks,
  buildClaudeSettingsHooks,
  generateOpenCodePlugin,
  installOpenCodePlugin,
  installHooksForTool,
};
