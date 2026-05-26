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
  // Universal event          Claude Code hook type     OpenCode event name             Pi extension event
  pre_tool:     { claude: 'PreToolUse',               opencode: 'tool.execute.before', jonggrang: 'tool_call'               },
  post_tool:    { claude: 'PostToolUse',              opencode: 'tool.execute.after',  jonggrang: 'tool_result'             },
  stop:         { claude: 'Stop',                     opencode: 'session.idle',        jonggrang: 'agent_stop'              },
  agent_stop:   { claude: 'SubagentStop',             opencode: 'session.updated',     jonggrang: 'agent_stop'              },
  session_start:{ claude: 'UserPromptSubmit',         opencode: 'session.created',     jonggrang: 'session_start'           },
  file_edit:    { claude: 'PostToolUse',              opencode: 'file.edited',         jonggrang: 'tool_result'             },
  compaction:   { claude: 'PreToolUse',               opencode: 'session.compacted',   jonggrang: 'before_provider_request' },
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
    jonggrang_handler: 'agentFirst',
    codex_handler: 'agentFirst',
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
    jonggrang_handler: 'compactionGate',
    codex_handler: 'compactionGate',
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
    jonggrang_handler: 'trackModifications',
    codex_handler: 'trackModifications',
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
    jonggrang_handler: 'feedbackLoop',
    codex_handler: 'feedbackLoop',
    blocking: true,
  },

  // Quality Gate (defense-in-depth backup for feedback loop)
  quality_gate: {
    event: 'stop',
    description: 'Final quality gate — defense in depth backup check',
    claude_script: 'hooks/claude/quality-gate.sh',
    opencode_handler: 'qualityGate',
    jonggrang_handler: 'qualityGate',
    codex_handler: 'qualityGate',
    blocking: true,
  },

  // Output Location Enforcement
  // Blocks agent exit if output files are in wrong locations
  output_enforcement: {
    event: 'agent_stop',
    description: 'Enforce output files are in .jonggrang/.output/ not scattered',
    claude_script: 'hooks/claude/output-enforcement.sh',
    opencode_handler: 'outputEnforcement',
    jonggrang_handler: 'outputEnforcement',
    codex_handler: 'outputEnforcement',
    blocking: true,
  },

  // Task Skill Enforcement (Output Location Layer 1)
  // Non-blocking warning if agent didn't invoke persisting-agent-outputs
  task_skill_enforcement: {
    event: 'post_tool',
    description: 'Warn if agent output lacks persisting-agent-outputs compliance marker',
    claude_script: 'hooks/claude/task-skill-enforcement.sh',
    opencode_handler: 'taskSkillEnforcement',
    jonggrang_handler: 'taskSkillEnforcement',
    codex_handler: 'taskSkillEnforcement',
    match_tools: ['Task'],
    blocking: false,
  },

  // Task Role Claim
  // Registers the expected role for the sub-agent about to be spawned
  task_role_claim: {
    event: 'pre_tool',
    description: 'Queue the expected role before spawning a sub-agent via Task',
    claude_script: 'hooks/claude/task-role-claim.sh',
    opencode_handler: 'taskRoleClaim',
    jonggrang_handler: 'taskRoleClaim',
    codex_handler: 'taskRoleClaim',
    match_tools: ['Task'],
    blocking: false,
  },

  // Session Init
  // Claims a pending role from queue and registers this session's identity
  session_init: {
    event: 'session_start',
    description: 'Register session role so agent-first enforcement can identify developers/testers',
    claude_script: 'hooks/claude/session-init.sh',
    opencode_handler: 'sessionInit',
    jonggrang_handler: 'sessionInit',
    codex_handler: 'sessionInit',
    blocking: false,
  },

  // Sensitive File Protection
  // Blocks AI agent from reading/writing .pem, .key, id_rsa, credentials, etc.
  // .env / orcinus files allowed only if already in .gitignore
  block_sensitive_files: {
    event: 'pre_tool',
    description: 'Block AI access to sensitive files — certs, keys, credentials, unprotected .env',
    claude_script: 'hooks/claude/block-sensitive-files.sh',
    opencode_handler: 'blockSensitiveFiles',
    match_tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    blocking: true,
  },

  // Secret Command Block
  // Blocks Bash commands that would dump secrets into LLM context
  block_secret_commands: {
    event: 'pre_tool',
    description: 'Block Bash commands that expose secrets (env, aws creds, gh token, etc.)',
    claude_script: 'hooks/claude/block-secret-commands.sh',
    opencode_handler: 'blockSecretCommands',
    match_tools: ['Bash'],
    blocking: true,
  },

  // Output Sanitization
  // Redacts secrets from tool output before it enters LLM context
  sanitize_output: {
    event: 'post_tool',
    description: 'Redact AWS keys, JWTs, DB passwords from tool output before LLM sees it',
    claude_script: 'hooks/claude/sanitize-output.sh',
    opencode_handler: 'sanitizeOutput',
    blocking: false,
  },

  // Secret Final Check (SubagentStop)
  // Scans modified files for leaked secrets via trufflehog before agent completes
  secret_final_check: {
    event: 'agent_stop',
    description: 'Trufflehog scan on modified files — block agent completion if secrets found',
    claude_script: 'hooks/claude/secret-final-check.sh',
    opencode_handler: 'secretFinalCheck',
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
          type: 'command',
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

    // Use git rev-parse for dynamic project root discovery — survives project moves/renames.
    // Falls back to $PWD (Claude Code sets CWD = project root when running hooks).
    const entry = {
      matcher: hookDef.match_tools && hookDef.match_tools.length > 0
        ? hookDef.match_tools.join('|')
        : '',
      hooks: [
        {
          type: 'command',
          command: `bash "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/${hookDef.claude_script}"`,
        },
      ],
    };

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

function generateOpenCodePlugin(_projectRoot) {
  // Mirrors installOpenCodePlugin but without a known fallback path.
  // Callers who need the fallback should use installOpenCodePlugin directly.
  return [
    `// Jonggrang orchestration plugin for OpenCode`,
    `// Generated by: jonggrang init — do not edit manually`,
    `const projectRoot = require('path').resolve(__dirname, '../..');`,
    `let createPlugin;`,
    `try {`,
    `  createPlugin = require('jonggrang/hooks/opencode/plugin').createPlugin;`,
    `} catch(e) {`,
    `  throw new Error('jonggrang not found in node_modules. Run: npm install jonggrang  (' + e.message + ')');`,
    `}`,
    `module.exports = createPlugin(projectRoot);`,
  ].join('\n') + '\n';
}

/**
 * Install OpenCode plugin in project.
 * Creates .opencode/plugins/jonggrang.js and registers in opencode.json.
 */
function installOpenCodePlugin(projectRoot, jonggrangInstallDir) {
  const pluginsDir = path.join(projectRoot, '.opencode', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  // Write plugin entry point.
  // Resolution strategy (in order):
  //   1. npm package ('jonggrang/...')  — works when jonggrang is in node_modules (local or global install)
  //   2. absolute fallback path         — works during development / running from source
  // __dirname at runtime = {project}/.opencode/plugins/, so ../../ = project root (always dynamic)
  const pluginEntry = path.join(pluginsDir, 'jonggrang.js');
  const handlerAbsPath = path.join(jonggrangInstallDir, 'hooks', 'opencode', 'plugin.js');

  fs.writeFileSync(pluginEntry, [
    `// Jonggrang orchestration plugin for OpenCode`,
    `// Generated by: jonggrang init — do not edit manually`,
    `const projectRoot = require('path').resolve(__dirname, '../..');`,
    `let createPlugin;`,
    `try {`,
    `  createPlugin = require('jonggrang/hooks/opencode/plugin').createPlugin;`,
    `} catch(e) {`,
    `  createPlugin = require(${JSON.stringify(handlerAbsPath)}).createPlugin;`,
    `}`,
    `// createPlugin returns { id, server, stub } — OpenCode calls server() when id is present`,
    `module.exports = createPlugin(projectRoot);`,
  ].join('\n'));

  // Note: .opencode/plugins/ is auto-discovered by OpenCode — no registration needed in opencode.json
  return pluginEntry;
}

// ============================================================
// PI (JONGGRANG) EXTENSION INSTALLER
// Installs the TypeScript Pi extension into .jonggrang/extensions/
// The extension is loaded on-the-fly via --extension flag in `jonggrang agent`,
// so no registration in ~/.jonggrang/agent/settings.json is needed.
// ============================================================

/**
 * Install Jonggrang Pi extension in project.
 * Copies hooks/pi/jonggrang-extension.ts → .jonggrang/extensions/jonggrang.ts
 */
function installPiExtension(projectRoot, jonggrangInstallDir) {
  const extensionsDir = path.join(projectRoot, '.jonggrang', 'extensions');
  fs.mkdirSync(extensionsDir, { recursive: true });

  const src = path.join(jonggrangInstallDir, 'hooks', 'pi', 'jonggrang-extension.ts');
  const dest = path.join(extensionsDir, 'jonggrang.ts');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }

  return dest;
}

// ============================================================
// AUTO-DETECT AND INSTALL
// ============================================================

/**
 * Install hooks for the appropriate tool (claude, opencode, or jonggrang).
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

  const settingsPath = installClaudeHooks(projectRoot);
  results.claude = { installed: true, path: settingsPath };

  const pluginPath = installOpenCodePlugin(projectRoot, jonggrangInstallDir);
  results.opencode = { installed: true, path: pluginPath };

  const piExtPath = installPiExtension(projectRoot, jonggrangInstallDir);
  results.jonggrang = { installed: true, path: piExtPath };

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
  installPiExtension,
  installHooksForTool,
};
