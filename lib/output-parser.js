'use strict';

const jsYaml = require('js-yaml');

const OUTPUT_FILES_HEADER = 'OUTPUT_FILES:';

/**
 * Parse OUTPUT_FILES blocks emitted by agents in stdout/stderr.
 *
 * Agents are instructed to emit a block like:
 *
 *   OUTPUT_FILES:
 *   - path: src/foo.js
 *     type: code
 *   - path: docs/report.md
 *     type: report
 *
 * or with an optional fenced code block wrapper:
 *
 *   OUTPUT_FILES:
 *   ```yaml
 *   - path: src/foo.js
 *     type: code
 *   ```
 *
 * Multiple blocks (e.g. from stdout + stderr combined) are merged.
 * Duplicate paths: last occurrence wins (consistent with addOutputFile idempotency).
 * size and created_at are NOT set here — orchestration.addOutputFile handles that.
 *
 * @param {string} stdout
 * @param {string} [stderr]
 * @returns {Array<{path: string, type?: string}>}
 */
function parseOutputFiles(stdout, stderr) {
  const combined = [stdout || '', stderr || ''].join('\n');
  const lines = combined.split('\n');

  // Map<path, entry> — last write wins
  const seen = new Map();

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== OUTPUT_FILES_HEADER) {
      i++;
      continue;
    }
    i++; // consume the OUTPUT_FILES: line

    // Optional fenced code block opener
    let inFence = false;
    if (i < lines.length && /^```/.test(lines[i].trim())) {
      inFence = true;
      i++;
    }

    // Collect YAML lines until end-of-fence or first blank line (unfenced)
    const yamlLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (inFence) {
        if (/^```/.test(l.trim())) {
          i++; // consume closing fence
          break;
        }
        yamlLines.push(l);
        i++;
      } else {
        if (l.trim() === '') break; // blank line ends unfenced block
        yamlLines.push(l);
        i++;
      }
    }

    // Parse and collect entries
    let parsed;
    try {
      parsed = jsYaml.load(yamlLines.join('\n'));
    } catch (_) {
      continue; // malformed YAML — skip block
    }

    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed) {
      if (!entry || typeof entry.path !== 'string') continue;
      const p = entry.path.trim();
      if (!p) continue;
      const item = { path: p };
      if (entry.type && typeof entry.type === 'string') item.type = entry.type;
      seen.set(p, item); // last write wins
    }
  }

  return Array.from(seen.values());
}

module.exports = { parseOutputFiles, OUTPUT_FILES_HEADER };
