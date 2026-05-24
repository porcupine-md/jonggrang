//
// JONGGRANG — OpenCode Plugin
// Implements the same enforcement as Claude Code hooks
// using OpenCode's plugin lifecycle API
//
// Events used (OpenCode 1.15.0 valid API):
//   tool.execute.before               → file protection + secret command block + agent-first + compaction gate
//   tool.execute.after                → track modifications (dirty bit) + output sanitization
//   experimental.chat.system.transform → inject CLAUDE.md into system prompt
//   chat.message                      → session role init (first message per session)
//   experimental.session.compacting   → refresh compaction state on context compaction
//
// NOTE: Feedback Loop Gate, Quality Gate, and Output Location Enforcement are
// Claude Code-only (Stop/SubagentStop bash hooks). OpenCode 1.15.0 has no session-exit
// hook equivalent — these gates only fire for Claude Code users.
//

const path = require('path');
const fs = require('fs');

/**
 * Create the Jonggrang OpenCode plugin for a given project root.
 * Called from .opencode/plugins/jonggrang.js
 */
function createPlugin(projectRoot) {
  // Resolve jonggrang lib modules
  const jonggrangLib = path.join(__dirname, '..', '..', 'lib');
  const fb = require(path.join(jonggrangLib, 'feedback.js'));
  const compaction = require(path.join(jonggrangLib, 'compaction.js'));

  // Sensitive file patterns — mirrors block-sensitive-files.sh
  function isSensitiveFile(filePath) {
    if (!filePath) return false;

    // Canonicalize: resolve symlinks so /tmp/innocent → ~/.ssh/id_rsa can't bypass.
    // Falls back to the original path if resolution fails (file may not exist yet on Write).
    let resolved = filePath;
    try {
      resolved = fs.realpathSync(path.resolve(projectRoot, filePath));
    } catch { /* keep original */ }

    const check = (p) => {
      if (/\.example$/i.test(p)) return 'allow';
      if (/(^|\/)\.env(\.[^/]+)?$|(^|\/)orcinus(\.[^/]+)?$/i.test(p)) return 'env';
      const sensitivePatterns = [
        /\.pem$/i, /\.key$/i, /(^|\/)id_rsa/i, /id_ed25519/i, /id_ecdsa/i,
        /id_ed25519_sk/i, /id_ecdsa_sk/i, /id_dsa/i, /(^|\/)identity/i, /ssh_host_.*_key/i,
        /\bcredentials\b/i, /\.pfx$/i, /\.p12$/i, /\.crt$/i, /\.cer$/i,
        /\.pkcs12$/i, /\.jks$/i, /\.keystore$/i, /(^|\/)\.ssh\//i, /authorized_keys/i,
      ];
      return sensitivePatterns.some(rx => rx.test(p)) ? 'block' : 'pass';
    };

    // Block if EITHER the requested path OR its resolved target is sensitive.
    const verdicts = [check(filePath), check(resolved)];
    if (verdicts.includes('block')) return true;
    if (verdicts.includes('env')) {
      // .env / orcinus — allowed only if in .gitignore (use execFileSync to avoid shell injection)
      try {
        const { execFileSync } = require('child_process');
        execFileSync('git', ['check-ignore', '-q', '--', filePath], { cwd: projectRoot, stdio: 'ignore' });
        return false; // in .gitignore — allowed
      } catch {
        return true; // not in .gitignore — block
      }
    }
    return false;
  }

  // Blocked bash command patterns — mirrors block-secret-commands.sh
  // Splits on common chain/subshell delimiters so `; env`, `&& env`, `$(env)` don't bypass.
  function isSecretCommand(command) {
    if (!command) return false;
    // Lift command-substitution and backtick contents into their own segments
    // so `echo $(env)` and `echo \`env\`` are checked, not just the outer command.
    const lifted = command
      .replace(/\$\(([^)]*)\)/g, '\n$1\n')
      .replace(/`([^`]*)`/g, '\n$1\n')
      .replace(/[()]/g, ' ');
    const segments = lifted
      .split(/&&|\|\||;|\||\n/)
      .map(s => s.trim().replace(/^(bash|sh|zsh|dash)\s+-c\s+['"]?/, '').replace(/^["']/, ''))
      .filter(Boolean);

    const READERS = '(?:cat|head|tail|less|more|xxd|od|hexdump|strings|awk|sed|cp|mv|tar|zip|base64|openssl|grep|rg|fgrep|egrep|nl|tac|view|vim|vi|nano|emacs|code|subl)';
    const SECRETPATH = '(credentials|\\.pem(\\s|$)|\\.key(\\s|$)|id_rsa|id_ed25519|id_ecdsa|id_ed25519_sk|id_ecdsa_sk|id_dsa|identity|ssh_host_.*_key|\\.ssh/|\\.aws/credentials|authorized_keys)';

    for (const seg of segments) {
      if (/^(env|printenv|set)(\s|$)/.test(seg)) return true;
      if (/^export\s+[A-Za-z_][A-Za-z0-9_]*=[^$]/.test(seg)) return true;
      if (/\baws\s+(configure\s+list|sts\s+get-session-token)\b/.test(seg)) return true;
      if (/\bgh\s+auth\s+(token|status)\b/.test(seg)) return true;
      if (/\bkubectl\s+config\s+view\b/.test(seg) && !/--minify/.test(seg)) return true;
      if (new RegExp(`\\b${READERS}\\b.*${SECRETPATH}`, 'i').test(seg)) return true;
      if (/\becho\s+\$[A-Za-z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)/i.test(seg)) return true;
    }
    return false;
  }

  // Redact secrets from a string — mirrors sanitize-output.sh
  function sanitizeSecrets(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS_KEY<REDACTED>')
      .replace(/(aws_secret_access_key\s*=\s*)\S+/gi, '$1<REDACTED>')
      .replace(/(aws_access_key_id\s*=\s*)\S+/gi, '$1<REDACTED>')
      .replace(/-----BEGIN [A-Z ]*(PRIVATE|CERTIFICATE|EC|OPENSSH) KEY-----/g, '-----BEGIN <REDACTED>-----')
      .replace(/(eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+/g, '$1<REDACTED>')
      .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1<REDACTED>@')
      .replace(/(mongodb(?:\+srv)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1<REDACTED>@')
      .replace(/(mysql:\/\/[^:\s]+:)[^@\s]+@/g, '$1<REDACTED>@')
      .replace(/(redis:\/\/[^:\s]+:)[^@\s]+@/g, '$1<REDACTED>@');
  }

  // Domain detection from file path
  function detectDomain(filePath) {
    if (!filePath) return 'backend';
    const fp = filePath.toLowerCase();
    if (/frontend|client|components|pages|views|ui|\.tsx|\.jsx|\.css|\.scss/.test(fp)) return 'frontend';
    if (/\.test\.|\.spec\.|__tests__|\/test\/|\/tests\//.test(fp)) return 'testing';
    if (/migration|schema\.|\/database\/|\/db\//.test(fp)) return 'database';
    if (/routes?\/|controllers?\/|handlers?\/|\/api\/|services?\//.test(fp)) return 'api';
    return 'backend';
  }

  // Track which sessions have already had role init run (first-message guard).
  const initializedSessions = new Set();

  // OpenCode requires id field on the module export so it calls server().
  // The returned object also needs a stub hook key to trigger full plugin recognition.
  const pluginObj = {
    id: 'jonggrang',
    server: null, // set below
    // Stub: presence of this key triggers OpenCode to call server()
    'tool.execute.before': async (_input, _output) => {},
  };

  pluginObj.server = async (context) => {
    return {

      // ────────────────────────────────────────────────────────────────
      // LAYER 0a: experimental.chat.system.transform — Inject CLAUDE.md
      // OpenCode natively loads AGENTS.md but not CLAUDE.md. This appends
      // the jonggrang operational protocol to the system prompt so both
      // tools start with identical constraints.
      // API: (input: {sessionID}, output: {system: string}) => Promise<void>
      // ────────────────────────────────────────────────────────────────
      'experimental.chat.system.transform': async (_input, output) => {
        const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
        if (!fs.existsSync(claudeMdPath)) return;
        try {
          const content = fs.readFileSync(claudeMdPath, 'utf8');
          if (output && typeof output.system === 'string') {
            output.system = output.system + '\n\n' + content;
          }
        } catch (e) {
          console.error('[jonggrang] chat.system.transform: could not inject CLAUDE.md:', e.message);
        }
      },

      // ────────────────────────────────────────────────────────────────
      // LAYER 0b: chat.message — Session Role Init (first message only)
      // Mirrors session-init.sh (Claude Code UserPromptSubmit hook).
      // Detects role from the initial prompt text and writes to session-roles.json
      // so agent-first enforcement can identify developer/tester sessions.
      // API: (input: {sessionID, ...}, output: {message, parts}) => Promise<void>
      // ────────────────────────────────────────────────────────────────
      'chat.message': async (input, _output) => {
        const sessionId = input?.sessionID || '';
        if (!sessionId || initializedSessions.has(sessionId)) return;
        initializedSessions.add(sessionId);

        const sessionRolesPath = path.join(projectRoot, '.jonggrang', '.ephemeral', 'session-roles.json');
        let sessionRoles = {};
        try {
          if (fs.existsSync(sessionRolesPath)) {
            sessionRoles = JSON.parse(fs.readFileSync(sessionRolesPath, 'utf8'));
          }
        } catch {}

        if (sessionRoles[sessionId]) return; // already registered in a prior run

        // Detect role from system/first message text
        const prompt = (input?.message?.content || '').toLowerCase();
        let role = '';
        if (/you are a specialized tester|specialized tester/.test(prompt))           role = 'tester';
        else if (/you are a specialized reviewer|specialized reviewer/.test(prompt))  role = 'reviewer';
        else if (/you are a test lead|test lead/.test(prompt))                        role = 'test-lead';
        else if (/you are a specialized lead|specialized lead/.test(prompt))          role = 'lead';
        else if (/you are a specialized developer|specialized developer/.test(prompt)) role = 'developer';

        // Fallback: claim oldest pending role from queue
        if (!role) {
          const pendingDir = path.join(projectRoot, '.jonggrang', '.ephemeral', 'pending-roles');
          if (fs.existsSync(pendingDir)) {
            const files = fs.readdirSync(pendingDir)
              .filter(f => f.endsWith('.json'))
              .sort();
            if (files.length > 0) {
              const oldest = path.join(pendingDir, files[0]);
              try {
                const data = JSON.parse(fs.readFileSync(oldest, 'utf8'));
                role = data.role || '';
                fs.unlinkSync(oldest);
              } catch {}
            }
          }
        }

        if (!role) return;

        try {
          fs.mkdirSync(path.dirname(sessionRolesPath), { recursive: true });
          sessionRoles[sessionId] = role;
          fs.writeFileSync(sessionRolesPath, JSON.stringify(sessionRoles, null, 2));
        } catch (e) {
          console.error('[jonggrang] chat.message: session-role registration failed:', e.message);
        }
      },

      // ────────────────────────────────────────────────────────────────
      // LAYER 1: tool.execute.before — Agent-First + Compaction Gate
      // OpenCode API: input.tool = string (name), output.args = tool arguments
      // ────────────────────────────────────────────────────────────────
      'tool.execute.before': async (input, output) => {
        const toolName = input?.tool || '';
        // OpenCode uses camelCase args (filePath, not file_path)
        const filePath = output?.args?.filePath || output?.args?.file_path || output?.args?.path || '';
        const command  = output?.args?.command || output?.args?.cmd || '';

        // ── File Protection (mirrors block-sensitive-files.sh) ───────
        // Cover all known OpenCode and Claude Code tool name variants for file ops
        const isFileOp = /^(read_file|edit_file|write_file|glob|grep|view_file|cat|Read|Edit|Write|Glob|Grep|str_replace_editor)$/i.test(toolName);
        if (isFileOp && filePath && isSensitiveFile(filePath)) {
          throw new Error(
            `FILE PROTECTION: Access to '${filePath}' is blocked — sensitive file.\n` +
            `Use a secret manager or an appropriate wrapper instead.`
          );
        }

        // ── Secret Command Block (mirrors block-secret-commands.sh) ──
        // Cover all known OpenCode and Claude Code tool name variants for shell ops
        const isShellOp = /^(bash|Bash|shell|run_bash|run_command|execute|exec|terminal|computer)$/i.test(toolName);
        if (isShellOp && command && isSecretCommand(command)) {
          throw new Error(
            `SECRET COMMAND BLOCKED: Command '${command}' may expose secrets.\n` +
            `Use 'run-with-secrets <profile> <cmd>' to access credentials safely.`
          );
        }

        // ── Compaction Gate (Task = agent spawning) ─────────────────
        if (toolName === 'Task' || toolName === 'spawn_agent') {
          const gate = compaction.checkCompactionGate(projectRoot);
          if (gate.status === 'block') {
            throw new Error(
              `COMPACTION GATE BLOCKED: ${gate.message}\n` +
              `Run /compact before spawning new agents.`
            );
          }
          if (gate.status === 'must' || gate.status === 'warn') {
            // Non-blocking — surface warning via toast if API available
            if (context?.client?.showToast) {
              await context.client.showToast(`⚠ ${gate.message}`, 'warning').catch(() => {});
            }
          }
        }

        // ── Agent-First Enforcement (Edit/Write) ─────────────────────
        if (toolName === 'edit_file' || toolName === 'write_file' ||
            toolName === 'Edit'      || toolName === 'Write') {

          const agentsRegistry = path.join(projectRoot, '.jonggrang', '.output', 'agents-registry.json');
          if (!fs.existsSync(agentsRegistry)) return;

          const domain = detectDomain(filePath);
          let registry = {};
          try { registry = JSON.parse(fs.readFileSync(agentsRegistry, 'utf8')); } catch {}

          if (registry[domain]) {
            // Check if we ARE the specialized agent (prevent self-blocking).
            // Read session-roles.json — populated by chat.message handler.
            const sessionId = input?.session_id || input?.session?.id || '';
            let sessionRole = '';
            if (sessionId) {
              const sessionRolesPath = path.join(projectRoot, '.jonggrang', '.ephemeral', 'session-roles.json');
              try {
                if (fs.existsSync(sessionRolesPath)) {
                  const roles = JSON.parse(fs.readFileSync(sessionRolesPath, 'utf8'));
                  sessionRole = roles[sessionId] || '';
                }
              } catch {}
            }
            if (sessionRole !== 'developer' && sessionRole !== 'tester') {
              throw new Error(
                `AGENT-FIRST ENFORCEMENT: Cannot edit ${filePath} directly.\n` +
                `A '${domain}' specialist is registered. Spawn '${domain}-developer' agent instead.`
              );
            }
          }
        }
      },

      // ────────────────────────────────────────────────────────────────
      // LAYER 2: tool.execute.after — Track Modifications (Dirty Bit)
      // OpenCode API: input.tool = string, input.args = tool args, output.output = result text
      // ────────────────────────────────────────────────────────────────
      'tool.execute.after': async (input, output) => {
        const toolName = input?.tool || '';
        // OpenCode uses camelCase args in tool.execute.after input
        const filePath = input?.args?.filePath || input?.args?.file_path || '';

        // ── Output Sanitization (mirrors sanitize-output.sh) ─────────
        // OpenCode API: output.output is the tool result string
        if (output && typeof output.output === 'string') {
          output.output = sanitizeSecrets(output.output);
        }

        // ── Track Modifications (Dirty Bit) ──────────────────────────
        if (toolName === 'edit_file' || toolName === 'write_file' ||
            toolName === 'Edit'      || toolName === 'Write') {
          const domain = detectDomain(filePath);
          try {
            fb.setDirtyBit(projectRoot, domain);
          } catch (e) {
            console.error('[jonggrang] track-modifications warning:', e.message);
          }
        }
      },

      // ────────────────────────────────────────────────────────────────
      // LAYER 3: experimental.session.compacting — Refresh Compaction State
      // OpenCode 1.15.0 fires this when context is being compacted.
      // API: (input: {sessionID}, output: {context: string[], prompt?: string}) => Promise<void>
      // ────────────────────────────────────────────────────────────────
      'experimental.session.compacting': async (_input, _output) => {
        try {
          compaction.refreshCompactionState(projectRoot);
        } catch (e) {
          console.error('[jonggrang] compaction refresh warning:', e.message);
        }
      },

    };
  };

  return pluginObj;
}

module.exports = { createPlugin };
