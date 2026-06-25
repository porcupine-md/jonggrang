//
// JONGGRANG — Codex Hook Policies
// Shared enforcement logic used by all codex hook handlers.
// Ported from hooks/claude/*.sh + hooks/opencode/plugin.js so codex
// gets the same protection as the other backends.
//
// Pure functions only — no I/O, no side effects. Safe to unit-test.
//

const fs = require('fs');
const path = require('path');

const SECRET_COMMAND_READERS = '(?:cat|head|tail|less|more|xxd|od|hexdump|strings|awk|sed|cp|mv|tar|zip|base64|openssl|grep|rg|fgrep|egrep|nl|tac|view|vim|vi|nano|emacs|code|subl)';
const SECRET_PATH_PATTERN = '(credentials|\\.pem(\\s|$)|\\.key(\\s|$)|id_rsa|id_ed25519|id_ecdsa|id_ed25519_sk|id_ecdsa_sk|id_dsa|identity|ssh_host_.*_key|\\.ssh/|\\.aws/credentials|authorized_keys)';
const SECRET_READER_RE = new RegExp(`\\b${SECRET_COMMAND_READERS}\\b.*${SECRET_PATH_PATTERN}`, 'i');

/**
 * Sensitive-file patterns — mirrors block-sensitive-files.sh.
 * Returns 'block' | 'env' | 'allow' | 'pass'.
 */
function classifyFilePath(filePath) {
  if (!filePath) return 'pass';

  // *.example — always allowed (template files, not real secrets)
  if (/\.example$/i.test(filePath)) return 'allow';

  // .env / orcinus — allowed only if in .gitignore
  if (/(^|\/)\.env(\.[^/]+)?$|(^|\/)orcinus(\.[^/]+)?$/i.test(filePath)) return 'env';

  const sensitivePatterns = [
    /\.pem$/i, /\.key$/i, /(^|\/)id_rsa/i, /id_ed25519/i, /id_ecdsa/i,
    /id_ed25519_sk/i, /id_ecdsa_sk/i, /id_dsa/i, /(^|\/)identity/i, /ssh_host_.*_key/i,
    /\bcredentials\b/i, /\.pfx$/i, /\.p12$/i, /\.crt$/i, /\.cer$/i,
    /\.pkcs12$/i, /\.jks$/i, /\.keystore$/i, /(^|\/)\.ssh\//i, /authorized_keys/i,
  ];
  return sensitivePatterns.some(rx => rx.test(filePath)) ? 'block' : 'pass';
}

/**
 * Check if a file path is sensitive — resolves symlinks so a path like
 * /tmp/notes.md → ~/.ssh/id_rsa can't bypass. .env/orcinus allowed only
 * if in .gitignore.
 */
function isSensitiveFile(filePath, projectRoot) {
  if (!filePath) return false;

  // Canonicalize: resolve symlinks. Falls back to the original path if the
  // file doesn't exist yet (Write/Edit creating a new file).
  let resolved = filePath;
  try {
    resolved = fs.realpathSync(path.resolve(projectRoot || '.', filePath));
  } catch { /* keep original */ }

  const verdicts = [classifyFilePath(filePath), classifyFilePath(resolved)];
  if (verdicts.includes('block')) return true;
  if (verdicts.includes('env')) {
    try {
      const { execFileSync } = require('child_process');
      execFileSync('git', ['check-ignore', '-q', '--', filePath], {
        cwd: projectRoot || '.', stdio: 'ignore',
      });
      return false; // in .gitignore — allowed
    } catch {
      return true; // not in .gitignore — block
    }
  }
  return false;
}

/**
 * Blocked bash command patterns — mirrors block-secret-commands.sh.
 * Splits on chain/subshell delimiters so `; env`, `&& env`, `$(env)` don't bypass.
 */
function isSecretCommand(command) {
  if (!command) return false;
  // Lift command-substitution and backtick contents into their own segments
  const lifted = command
    .replace(/\$\(([^)]*)\)/g, '\n$1\n')
    .replace(/`([^`]*)`/g, '\n$1\n')
    .replace(/[()]/g, ' ');
  const segments = lifted
    .split(/&&|\|\||;|\||\n/)
    .map(s => s.trim()
      .replace(/^(?:\S*\/)?(?:bash|sh|zsh|dash)\s+-l?c\s+['"]?/, '')
      .replace(/^["']/, '')
      .replace(/["']$/, ''))
    .filter(Boolean);

  for (const seg of segments) {
    if (/^(env|printenv|set)(\s|$)/.test(seg)) return true;
    if (/^export\s+[A-Za-z_][A-Za-z0-9_]*=[^$]/.test(seg)) return true;
    if (/\baws\s+(configure\s+list|sts\s+get-session-token)\b/.test(seg)) return true;
    if (/\bgh\s+auth\s+(token|status)\b/.test(seg)) return true;
    if (/\bkubectl\s+config\s+view\b/.test(seg) && !/--minify/.test(seg)) return true;
    if (SECRET_READER_RE.test(seg)) return true;
    if (/\becho\s+\$[A-Za-z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)/i.test(seg)) return true;
  }
  return false;
}

/**
 * Redact secrets from a string — mirrors sanitize-output.sh.
 */
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

/**
 * Domain detection from file path — mirrors track-modifications.sh.
 */
function detectDomain(filePath) {
  if (!filePath) return 'backend';
  const fp = filePath.toLowerCase();
  if (/frontend|client|components|pages|views|ui|\.tsx|\.jsx|\.css|\.scss/.test(fp)) return 'frontend';
  if (/\.test\.|\.spec\.|__tests__|\/test\/|\/tests\//.test(fp)) return 'testing';
  if (/migration|schema\.|\/database\/|\/db\//.test(fp)) return 'database';
  if (/routes?\/|controllers?\/|handlers?\/|\/api\/|services?\//.test(fp)) return 'api';
  return 'backend';
}

module.exports = {
  classifyFilePath,
  isSensitiveFile,
  isSecretCommand,
  sanitizeSecrets,
  detectDomain,
};
