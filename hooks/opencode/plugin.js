//
// JONGGRANG — OpenCode Plugin
// Implements the same enforcement as Claude Code hooks
// using OpenCode's plugin lifecycle API
//
// Events used:
//   tool.execute.before  → agent-first enforcement + compaction gate
//   tool.execute.after   → track modifications (dirty bit)
//   file.edited          → track modifications (dirty bit)
//   session.idle         → feedback loop gate + quality gate
//   session.updated      → output enforcement (SubagentStop equivalent)
//   session.compacted    → refresh compaction state
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
    if (/\.example$/i.test(filePath)) return false; // always allow
    if (/(^|\/)\.env(\.[^/]+)?$|(^|\/)orcinus(\.[^/]+)?$/i.test(filePath)) {
      // .env / orcinus — allowed only if in .gitignore
      try {
        const { execSync } = require('child_process');
        execSync(`git check-ignore -q "${filePath}"`, { cwd: projectRoot, stdio: 'ignore' });
        return false; // in .gitignore — allowed
      } catch {
        return true; // not in .gitignore — block
      }
    }
    const sensitivePatterns = [
      /\.pem$/i, /\.key$/i, /(^|\/)id_rsa/i, /id_ed25519/i, /id_dsa/i,
      /\bcredentials\b/i, /\.pfx$/i, /\.p12$/i, /\.crt$/i, /\.cer$/i,
      /\.pkcs12$/i, /\.jks$/i, /\.keystore$/i, /(^|\/)\.ssh\//i, /authorized_keys/i,
    ];
    return sensitivePatterns.some(p => p.test(filePath));
  }

  // Blocked bash command patterns — mirrors block-secret-commands.sh
  function isSecretCommand(command) {
    if (!command) return false;
    if (/^(env|printenv|set)(\s|$)/.test(command)) return true;
    if (/^export [A-Za-z_][A-Za-z0-9_]*=[^$\(]/.test(command)) return true;
    if (/aws (configure list|sts get-session-token)/.test(command)) return true;
    if (/gh auth (token|status)/.test(command)) return true;
    if (/kubectl config view/.test(command) && !/--minify/.test(command)) return true;
    if (/cat .*(credentials|\.pem|\.key$|id_rsa|id_ed25519|id_dsa)/i.test(command)) return true;
    if (/echo \$[A-Za-z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)/i.test(command)) return true;
    return false;
  }

  // Redact secrets from a string — mirrors sanitize-output.sh
  function sanitizeSecrets(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA<REDACTED>')
      .replace(/(aws_secret_access_key\s*=\s*)\S+/gi, '$1<REDACTED>')
      .replace(/-----BEGIN [A-Z ]*(PRIVATE|CERTIFICATE) KEY-----[^-]*/g, '-----BEGIN <REDACTED>-----')
      .replace(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+/g, '$1<REDACTED>')
      .replace(/(postgres:\/\/[^:]+:)[^@]+@/g, '$1<REDACTED>@')
      .replace(/(mongodb:\/\/[^:]+:)[^@]+@/g, '$1<REDACTED>@')
      .replace(/(mysql:\/\/[^:]+:)[^@]+@/g, '$1<REDACTED>@');
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
      // LAYER 0: session.created — Inject CLAUDE.md + Session Role Init
      // Equivalent to Claude Code's auto-loading of CLAUDE.md at session start.
      // OpenCode natively loads AGENTS.md (project knowledge), but misses the
      // jonggrang operational protocol that lives in CLAUDE.md. This handler
      // bridges the gap so both tools have the same starting context.
      // ────────────────────────────────────────────────────────────────
      'session.created': async (input) => {
        // ── Inject CLAUDE.md content ──────────────────────────────────
        const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
        if (fs.existsSync(claudeMdPath) && context?.session?.addContext) {
          try {
            const content = fs.readFileSync(claudeMdPath, 'utf8');
            await context.session.addContext({
              type: 'text',
              title: 'CLAUDE.md — Jonggrang Operational Protocol',
              content,
            });
          } catch (e) {
            console.error('[jonggrang] session.created: could not inject CLAUDE.md:', e.message);
          }
        }

        // ── Session Role Registration (mirrors session-init.sh) ───────
        // Claim a pending role from the queue so agent-first enforcement
        // can identify developer/tester sessions (same mechanism as Claude Code).
        const sessionId = input?.session?.id || input?.id || '';
        if (!sessionId) return;

        const sessionRolesPath = path.join(projectRoot, '.jonggrang', '.ephemeral', 'session-roles.json');
        let sessionRoles = {};
        try {
          if (fs.existsSync(sessionRolesPath)) {
            sessionRoles = JSON.parse(fs.readFileSync(sessionRolesPath, 'utf8'));
          }
        } catch {}

        if (sessionRoles[sessionId]) return; // already registered

        // Detect role from session prompt if available
        const prompt = (input?.prompt || input?.session?.prompt || '').toLowerCase();
        let role = '';
        if (/you are a specialized tester|specialized tester/.test(prompt))         role = 'tester';
        else if (/you are a specialized reviewer|specialized reviewer/.test(prompt)) role = 'reviewer';
        else if (/you are a test lead|test lead/.test(prompt))                       role = 'test-lead';
        else if (/you are a specialized lead|specialized lead/.test(prompt))         role = 'lead';
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
          console.error('[jonggrang] session-role registration failed:', e.message);
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
            `FILE PROTECTION: Akses ke '${filePath}' diblokir — file sensitif.\n` +
            `Gunakan secret manager atau wrapper yang sesuai.`
          );
        }

        // ── Secret Command Block (mirrors block-secret-commands.sh) ──
        // Cover all known OpenCode and Claude Code tool name variants for shell ops
        const isShellOp = /^(bash|Bash|shell|run_bash|run_command|execute|exec|terminal|computer)$/i.test(toolName);
        if (isShellOp && command && isSecretCommand(command)) {
          throw new Error(
            `SECRET COMMAND BLOCKED: Command '${command}' berpotensi membongkar secret.\n` +
            `Gunakan 'run-with-secrets <profile> <cmd>' untuk akses kredensial.`
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
            // Read session-roles.json — populated by session.created handler.
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
      // LAYER 3: file.edited — Track Modifications (file watcher fallback)
      // ────────────────────────────────────────────────────────────────
      'file.edited': async (input) => {
        const filePath = input?.path || input?.file || '';
        if (!filePath) return;

        const domain = detectDomain(filePath);
        try {
          fb.setDirtyBit(projectRoot, domain);
        } catch (e) {
          console.error('[jonggrang] file.edited dirty bit warning:', e.message);
        }
      },

      // ────────────────────────────────────────────────────────────────
      // LAYER 4: session.idle — Feedback Loop Gate + Quality Gate
      // Equivalent to Claude Code's Stop hook
      // ────────────────────────────────────────────────────────────────
      'session.idle': async (input) => {
        // ── Feedback Loop Gate ────────────────────────────────────────
        try {
          const gate = fb.checkExitGate(projectRoot);
          if (!gate.allowed) {
            const stuckCount = gate.stuck_count || 0;

            let message = `FEEDBACK LOOP GATE:\n${gate.reason}\n\n`;
            message += `To unblock:\n`;
            message += `  1. Spawn reviewer agent for each modified domain\n`;
            message += `  2. Spawn tester agent for each modified domain\n`;
            message += `  3. Both must return PASS status\n`;

            if (stuckCount > 3) {
              message += `\n=== ESCALATION ADVISOR ===\n`;
              message += `Agent stuck for ${stuckCount} consecutive attempts.\n`;
              message += `Hint: Check feedback-loop-state.json — are reviewer/tester agents spawned?\n`;
            }

            throw new Error(message);
          }
        } catch (e) {
          if (e.message.includes('FEEDBACK LOOP')) throw e;
          // Other errors — allow exit
        }

        // ── Quality Gate (Defense in Depth) ──────────────────────────
        const violations = [];

        // Check untracked .md files
        try {
          const { execSync } = require('child_process');
          const untracked = execSync('git ls-files --others --exclude-standard', {
            cwd: projectRoot, encoding: 'utf8',
          }).split('\n').filter(f =>
            f.endsWith('.md') &&
            !f.startsWith('.jonggrang/') &&
            !f.startsWith('.claude/') &&
            !f.startsWith('.opencode/') &&
            !f.startsWith('docs/') &&
            f !== 'AGENTS.md' && f !== 'CLAUDE.md' && f !== 'README.md' &&
            f !== 'CHANGELOG.md' && f !== 'CONTRIBUTING.md' && f !== 'SKILL.md'
          );

          for (const f of untracked) {
            if (f) violations.push(`Untracked .md outside .jonggrang/.output/: ${f}`);
          }
        } catch {}

        if (violations.length > 0) {
          throw new Error(
            `QUALITY GATE VIOLATIONS:\n` +
            violations.map(v => `  ✗ ${v}`).join('\n') + '\n' +
            `\nResolve violations before completing this phase.`
          );
        }
      },

      // ────────────────────────────────────────────────────────────────
      // LAYER 5: session.updated — Output Location Enforcement
      // Equivalent to Claude Code's SubagentStop hook
      // ────────────────────────────────────────────────────────────────
      'session.updated': async (input) => {
        // Only enforce when session status changes to 'completed'
        const status = input?.status || input?.session?.status;
        if (status !== 'completed') return;

        const violations = [];

        try {
          const { execSync } = require('child_process');
          const untracked = execSync('git ls-files --others --exclude-standard', {
            cwd: projectRoot, encoding: 'utf8',
          }).split('\n').filter(Boolean);

          const allowedPatterns = [
            /^\.jonggrang\//,
            /^\.claude\//,
            /^\.opencode\//,
            /^docs\//,
            /^AGENTS\.md$/,
            /^CLAUDE\.md$/,
            /^SKILL\.md$/,
            /^progress\.txt$/,
            /^README\.md$/,
            /^CHANGELOG\.md$/,
            /^CONTRIBUTING\.md$/,
          ];

          for (const file of untracked) {
            if (!file.endsWith('.md')) continue;
            const allowed = allowedPatterns.some(p => p.test(file));
            if (!allowed) violations.push(`Unapproved .md file: ${file} (use .jonggrang/.output/)`);
          }
        } catch {}

        if (violations.length > 0) {
          throw new Error(
            `OUTPUT ENFORCEMENT:\n` +
            violations.map(v => `  ✗ ${v}`).join('\n')
          );
        }
      },

      // ────────────────────────────────────────────────────────────────
      // LAYER 6: session.compacted — Refresh Compaction State
      // ────────────────────────────────────────────────────────────────
      'session.compacted': async () => {
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
