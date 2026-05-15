'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const MAX_DIFF_CHARS = 60000;

const SYSTEM_PROMPT = `You are an expert code reviewer and security analyst reviewing a GitLab merge request diff.

Analyze the diff and provide structured feedback covering:
1. Bugs and correctness issues
2. Security vulnerabilities (injection, auth bypass, secrets exposure, insecure deps, OWASP Top 10)
3. Performance problems
4. Code quality and maintainability
5. Missing error handling or edge cases

Respond ONLY with valid JSON — no markdown fences, no prose outside the JSON:
{
  "verdict": "APPROVED" | "CHANGES_REQUESTED" | "COMMENT",
  "summary": "2-3 sentence overall assessment",
  "issues": [
    {
      "file": "relative/path/to/file.ext",
      "line": <integer or null>,
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
      "type": "security" | "bug" | "performance" | "style" | "maintainability",
      "message": "Concise description and suggested fix"
    }
  ]
}

Rules:
- APPROVED only when there are zero CRITICAL/HIGH issues
- CHANGES_REQUESTED when CRITICAL or HIGH issues exist
- COMMENT for informational feedback only
- Empty issues array [] if the diff is clean
- line: new-file line number from the diff, or null if not applicable`;

// ── Auth path helpers ─────────────────────────────────────────────────────────

function resolveAgentDir() {
  return path.join(os.homedir(), '.jonggrang', 'agent');
}

function resolveAuthPath() {
  return path.join(resolveAgentDir(), 'auth.json');
}

// ── Main review function — uses Pi's agent for all model routing ──────────────

async function reviewDiff(diff, mrTitle, mrDescription, provider, modelId) {
  const {
    createAgentSession,
    AuthStorage,
    ModelRegistry,
    ENV_AGENT_DIR,
  } = await import('@earendil-works/pi-coding-agent');

  const agentDir = resolveAgentDir();
  process.env[ENV_AGENT_DIR] = agentDir;

  const authStorage  = AuthStorage.create(resolveAuthPath());
  const modelRegistry = ModelRegistry.create(authStorage);

  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Model not found: ${provider}/${modelId}. Run 'jonggrang model' to reconfigure.`);
  }
  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`No auth for ${provider}. Run 'jonggrang login' first.`);
  }

  const trimmed = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n[... diff truncated ...]'
    : diff;

  const userContent = [
    `## MR: ${mrTitle}`,
    mrDescription ? `**Description:** ${mrDescription}` : '',
    '',
    '## Diff',
    '```diff',
    trimmed,
    '```',
    '',
    '---',
    SYSTEM_PROMPT,
    '',
    'Respond with ONLY the JSON object. No prose, no markdown fences, no explanation before or after the JSON.',
  ].filter(Boolean).join('\n');

  // Pi creates a session per review — handles all model routing internally
  // (openai-codex-responses, anthropic-messages, openai-responses, etc.)
  const { session } = await createAgentSession({
    agentDir,
    authStorage,
    modelRegistry,
    model,
    cwd: os.tmpdir(),
  });

  try {
    // No tools needed — pure text review
    session.setActiveToolsByName([]);

    // Override Pi's default system prompt with our review prompt
    session.agent.state.systemPrompt = SYSTEM_PROMPT;

    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Review timed out after 120s')), 120_000);

      session.subscribe((event) => {
        if (event.type === 'agent_end') {
          clearTimeout(timer);
          resolve(session.getLastAssistantText() ?? '');
        } else if (event.type === 'error') {
          clearTimeout(timer);
          reject(new Error(event.error?.message || 'Agent error during review'));
        }
      });

      session.sendUserMessage(userContent).catch(reject);
    });

    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    // Model returned markdown — derive verdict heuristically and post as-is
    if (!cleaned) throw new Error('Empty response from model');
    const verdict = /critical|high.{0,20}sever|must.fix|block|cannot.merge/i.test(cleaned)
      ? 'CHANGES_REQUESTED'
      : /looks good|lgtm|no issue|all good|clean/i.test(cleaned)
      ? 'APPROVED'
      : 'COMMENT';
    return { verdict, summary: cleaned, issues: [] };
  } finally {
    try { session.dispose(); } catch {}
  }
}

module.exports = { reviewDiff };
