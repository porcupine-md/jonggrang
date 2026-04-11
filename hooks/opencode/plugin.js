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

  return async (context) => {
    return {

      // ────────────────────────────────────────────────────────────────
      // LAYER 1: tool.execute.before — Agent-First + Compaction Gate
      // ────────────────────────────────────────────────────────────────
      'tool.execute.before': async (input) => {
        const toolName = input?.tool?.name || '';
        const filePath = input?.tool?.input?.file_path || '';

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
            // Check if we ARE the specialized agent
            const currentRole = context?.agent?.role || input?.agent_role || '';
            if (currentRole !== 'developer' && currentRole !== 'tester') {
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
      // ────────────────────────────────────────────────────────────────
      'tool.execute.after': async (input, output) => {
        const toolName = input?.tool?.name || '';
        const filePath = input?.tool?.input?.file_path || '';

        if (toolName === 'edit_file' || toolName === 'write_file' ||
            toolName === 'Edit'      || toolName === 'Write') {
          const domain = detectDomain(filePath);
          try {
            fb.setDirtyBit(projectRoot, domain);
          } catch (e) {
            // Non-critical — log and continue
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
          }).split('\n').filter(f => f.endsWith('.md') && !f.startsWith('.jonggrang/') && f !== 'AGENTS.md' && f !== 'README.md');

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
            /^AGENTS\.md$/,
            /^progress\.txt$/,
            /^README\.md$/,
            /^CHANGELOG\.md$/,
            /^docs\//,
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
}

module.exports = { createPlugin };
