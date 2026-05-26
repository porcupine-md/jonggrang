'use strict';

/**
 * Translate jonggrang's generic --model and --effort flags into
 * backend-specific CLI argument fragments.
 *
 * buildAgentArgs({ tool, model, effort }) → string[]
 *   Returns extra argv to splice into the backend spawn command.
 *   Throws on invalid combinations (e.g. bare model name for OpenCode).
 */
function buildAgentArgs({ tool, model, effort }) {
  const flags = [];
  if (!model && !effort) return flags;

  switch (tool) {
    case 'claude':
      // claude -p ... --model <alias|id> --effort <level>
      // Aliases: default, best, sonnet, opus, haiku, opusplan, sonnet[1m], opus[1m]
      // Full IDs: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5, etc.
      if (model) flags.push('--model', model);
      if (effort) flags.push('--effort', effort);
      break;

    case 'opencode':
      // opencode run --model <provider/model> --variant <level> <prompt>
      // Model must be in provider/model format (e.g. anthropic/claude-sonnet-4-5-20250929)
      if (model) {
        if (!model.includes('/')) {
          throw new Error(
            `OpenCode requires provider/model format (e.g. anthropic/claude-sonnet-4-5-20250929). ` +
            `Got: "${model}". Use --tool claude or --tool jonggrang for bare model names.`
          );
        }
        flags.push('--model', model);
      }
      // --effort → --variant for OpenCode
      // Canonical jonggrang level → provider built-in variant name when one exists;
      // otherwise pass through verbatim for custom variants.
      if (effort) flags.push('--variant', effort);
      break;

    case 'jonggrang':
      // jonggrang backend uses the pi SDK directly; model/effort are resolved in
      // runAgent() via the SDK API, not as CLI flags.
      break;

    case 'codex':
      // codex exec <prompt> --model <name> --config reasoning_effort=<level>
      if (model) flags.push('--model', model);
      if (effort) flags.push('--config', `reasoning_effort=${effort}`);
      break;

    default:
      break;
  }

  return flags;
}

module.exports = { buildAgentArgs };
