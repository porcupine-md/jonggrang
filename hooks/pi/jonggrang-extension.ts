//
// JONGGRANG — Pi Extension
// Implements the same enforcement as Claude Code hooks and OpenCode plugin
// using Pi's TypeScript extension API.
//
// Events used:
//   session_start        → session role init (claim pending role from queue)
//   resources_discover   → redirect skill/prompt discovery to .jonggrang/
//   before_agent_start   → inject codemap into system prompt (first turn only)
//   tool_call            → file protection + secret command block + agent-first + compaction gate + task role claim
//   tool_result          → track modifications (dirty bit) + output sanitization
//   agent_end            → secret final check + feedback loop gate + quality gate + output enforcement
//
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const path = require("path") as typeof import("path");
const fs = require("fs") as typeof import("fs");
const { execSync, execFileSync } = require("child_process") as typeof import("child_process");

// Per-session state: cached codemap markdown (loaded on session_start, injected on first turn).
const MAX_CODEMAP_INJECTION_CHARS = 4500;

// ── Sensitive file check — mirrors block-sensitive-files.sh ──────────────────
function isSensitiveFile(filePath: string, projectRoot: string): boolean {
  if (!filePath) return false;

  let resolved = filePath;
  try { resolved = fs.realpathSync(path.resolve(projectRoot, filePath)); } catch {}

  const check = (p: string): "allow" | "env" | "block" | "pass" => {
    if (/\.example$/i.test(p)) return "allow";
    if (/(^|\/)\.env(\.[^/]+)?$|(^|\/)orcinus(\.[^/]+)?$/i.test(p)) return "env";
    const sensitivePatterns = [
      /\.pem$/i, /\.key$/i, /(^|\/)id_rsa/i, /id_ed25519/i, /id_ecdsa/i,
      /id_ed25519_sk/i, /id_ecdsa_sk/i, /id_dsa/i, /(^|\/)identity/i, /ssh_host_.*_key/i,
      /\bcredentials\b/i, /\.pfx$/i, /\.p12$/i, /\.crt$/i, /\.cer$/i,
      /\.pkcs12$/i, /\.jks$/i, /\.keystore$/i, /(^|\/)\.ssh\//i, /authorized_keys/i,
    ];
    return sensitivePatterns.some(rx => rx.test(p)) ? "block" : "pass";
  };

  const verdicts = [check(filePath), check(resolved)];
  if (verdicts.includes("block")) return true;
  if (verdicts.includes("env")) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", filePath], { cwd: projectRoot, stdio: "ignore" });
      return false; // in .gitignore — allowed
    } catch {
      return true; // not in .gitignore — block
    }
  }
  return false;
}

// ── Secret command check — mirrors block-secret-commands.sh ─────────────────
function isSecretCommand(command: string): boolean {
  if (!command) return false;
  const lifted = command
    .replace(/\$\(([^)]*)\)/g, "\n$1\n")
    .replace(/`([^`]*)`/g, "\n$1\n")
    .replace(/[()]/g, " ");
  const segments = lifted
    .split(/&&|\|\||;|\||\n/)
    .map((s: string) => s.trim().replace(/^(bash|sh|zsh|dash)\s+-c\s+['"]?/, "").replace(/^["']/, ""))
    .filter(Boolean);
  const READERS = "(?:cat|head|tail|less|more|xxd|od|hexdump|strings|awk|sed|cp|mv|tar|zip|base64|openssl|grep|rg|fgrep|egrep|nl|tac|view|vim|vi|nano|emacs|code|subl)";
  const SECRETPATH = "(credentials|\\.pem(\\s|$)|\\.key(\\s|$)|id_rsa|id_ed25519|id_ecdsa|id_ed25519_sk|id_ecdsa_sk|id_dsa|identity|ssh_host_.*_key|\\.ssh/|\\.aws/credentials|authorized_keys)";
  for (const seg of segments) {
    if (/^(env|printenv|set)(\s|$)/.test(seg)) return true;
    if (/^export\s+[A-Za-z_][A-Za-z0-9_]*=[^$]/.test(seg)) return true;
    if (/\baws\s+(configure\s+list|sts\s+get-session-token)\b/.test(seg)) return true;
    if (/\bgh\s+auth\s+(token|status)\b/.test(seg)) return true;
    if (/\bkubectl\s+config\s+view\b/.test(seg) && !/--minify/.test(seg)) return true;
    if (new RegExp(`\\b${READERS}\\b.*${SECRETPATH}`, "i").test(seg)) return true;
    if (/\becho\s+\$[A-Za-z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)/i.test(seg)) return true;
  }
  return false;
}

// ── Output sanitization — mirrors sanitize-output.sh ─────────────────────────
function sanitizeSecrets(text: string): string {
  return text
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AWS_KEY<REDACTED>")
    .replace(/(aws_secret_access_key\s*=\s*)\S+/gi, "$1<REDACTED>")
    .replace(/(aws_access_key_id\s*=\s*)\S+/gi, "$1<REDACTED>")
    .replace(/-----BEGIN [A-Z ]*(PRIVATE|CERTIFICATE|EC|OPENSSH) KEY-----/g, "-----BEGIN <REDACTED>-----")
    .replace(/(eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+/g, "$1<REDACTED>")
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, "$1<REDACTED>@")
    .replace(/(mongodb(?:\+srv)?:\/\/[^:\s]+:)[^@\s]+@/g, "$1<REDACTED>@")
    .replace(/(mysql:\/\/[^:\s]+:)[^@\s]+@/g, "$1<REDACTED>@")
    .replace(/(redis:\/\/[^:\s]+:)[^@\s]+@/g, "$1<REDACTED>@");
}

function readJsonSafe(filePath: string): Record<string, any> {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {}
  return {};
}

function writeJsonSafe(filePath: string, data: any): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.error("[jonggrang] writeJsonSafe failed:", e.message);
  }
}

export default function (pi: ExtensionAPI) {
  // projectRoot = cwd where `jonggrang agent` is invoked.
  // Do NOT use __dirname — the extension is loaded via --extension flag, not from a fixed install path.
  const projectRoot = process.cwd();
  const jonggrangLib = (() => {
    // 1. Try npm package (project-local or globally installed)
    try {
      return path.dirname(require.resolve("jonggrang/lib/jonggrang.js"));
    } catch {}
    // 2. Co-located lib/ relative to this extension file (handles global
    //    install via symlink, npx, or --extension flag from repo clone)
    try {
      const coLocated = path.join(__dirname, '..', '..', 'lib');
      if (fs.existsSync(path.join(coLocated, 'codemap.js'))) return coLocated;
    } catch {}
    // 3. Last resort: project-local node_modules
    return path.join(projectRoot, "node_modules", "jonggrang", "lib");
  })();

  function loadLib(name: string) {
    return require(path.join(jonggrangLib, name));
  }

  // ── Codemap (LLM-free project context) — loaded once on session_start ──
  // Mirrors pi-compass: pre-compute markdown, inject on first turn only.
  let codemapInjected = false;
  let codemapMarkdown: string | null = null;
  let codemapStale = false;
  function loadCodemap() {
    try {
      const codemap = loadLib("codemap.js");
      const result = codemap.getOrGenerateCodemap(projectRoot);
      if (result && result.codemap) {
        codemapMarkdown = codemap.formatCodemapMarkdown(result.codemap, { maxChars: MAX_CODEMAP_INJECTION_CHARS });
        codemapStale = !!result.stale;
      }
    } catch (e: any) {
      console.error("[jonggrang] codemap load failed:", e?.message || e);
    }
  }

  function detectDomain(filePath: string): string {
    if (!filePath) return "backend";
    const fp = filePath.toLowerCase();
    if (/frontend|client|components|pages|views|ui|\.tsx|\.jsx|\.css|\.scss/.test(fp)) return "frontend";
    if (/\.test\.|\.spec\.|__tests__|\/test\/|\/tests\//.test(fp)) return "testing";
    if (/migration|schema\.|\/database\/|\/db\//.test(fp)) return "database";
    if (/routes?\/|controllers?\/|handlers?\/|\/api\/|services?\//.test(fp)) return "api";
    return "backend";
  }

  // ── LAYER 0: session_start → sessionInit ─────────────────────────────────
  // Claims a pending role from queue and registers this session's identity.
  // Mirrors hooks/claude/session-init.sh and opencode plugin session.created handler.
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = (ctx as any)?.sessionId || "";
    if (!sessionId) return;

    const sessionRolesPath = path.join(projectRoot, ".jonggrang", ".ephemeral", "session-roles.json");
    const sessionRoles: Record<string, string> = readJsonSafe(sessionRolesPath);

    if (sessionRoles[sessionId]) return; // already registered

    // Claim oldest pending role from queue
    let role = "";
    const pendingDir = path.join(projectRoot, ".jonggrang", ".ephemeral", "pending-roles");
    if (fs.existsSync(pendingDir)) {
      const files = fs.readdirSync(pendingDir)
        .filter((f: string) => f.endsWith(".json"))
        .sort();
      if (files.length > 0) {
        const oldest = path.join(pendingDir, files[0]);
        try {
          const data = JSON.parse(fs.readFileSync(oldest, "utf8"));
          role = data.role || "";
          fs.unlinkSync(oldest);
        } catch {}
      }
    }

    if (!role) return;
    sessionRoles[sessionId] = role;
    writeJsonSafe(sessionRolesPath, sessionRoles);
  });

  // ── LAYER 1: resources_discover → redirect to .jonggrang/ paths ──────────
  // Adds .jonggrang/skills and .jonggrang/prompts to Pi's discovery paths.
  // This avoids needing a full custom ResourceLoader.
  pi.on("resources_discover", async (event) => {
    const cwd = event.cwd || projectRoot;
    const skillsPath  = path.join(cwd, ".jonggrang", "skills");
    const promptsPath = path.join(cwd, ".jonggrang", "prompts");
    return {
      skillPaths:  fs.existsSync(skillsPath)  ? [skillsPath]  : [],
      promptPaths: fs.existsSync(promptsPath) ? [promptsPath] : [],
      themePaths:  [],
    };
  });

  // ── LAYER 1.5: before_agent_start → inject codemap (first turn only) ──────
  // Mirrors pi-compass: deterministic, cached codebase map prepended to the
  // system prompt once per session. Avoids spending tool calls on `ls`/`find`.
  // Subsequent turns do NOT re-inject (mirrors pi-compass behavior).
  if (!codemapMarkdown) loadCodemap();
  pi.on("before_agent_start", (event) => {
    if (codemapInjected) return {};
    if (!codemapMarkdown) return {};
    codemapInjected = true;
    const banner = codemapStale
      ? `\n\n> ⚠️ Codemap may be outdated. Run \`jonggrang codemap --refresh\` to update.`
    const section = `\n\n## Codebase Map (LLM-free, cached)\n\n${codemapMarkdown}${banner}`;
    return { systemPrompt: section + event.systemPrompt };

  // ── LAYER 2: tool_call → fileProtection + secretCommandBlock + agentFirst + compactionGate + taskRoleClaim ─
  // event.toolName is the Pi API property (lowercase: "read", "edit", "write", "bash", "grep", "find", "ls")
  // Return { block: true, reason? } to block — this is ToolCallEventResult, NOT { action: "block" }
  pi.on("tool_call", (event, ctx) => {
    const toolName = event.toolName || "";
    const input = event.input || {};
    const filePath = (input.file_path as string) || (input.path as string) || "";
    const command = (input.command as string) || (input.cmd as string) || "";
    const globPattern = (input.pattern as string) || (input.glob as string) || "";

    // ── File Protection (mirrors block-sensitive-files.sh) ─────────────────
    const isFileOp = /^(read|edit|write|grep|find|ls)$/.test(toolName);
    if (isFileOp) {
      const candidates = [filePath, globPattern].filter(Boolean);
      for (const candidate of candidates) {
        if (isSensitiveFile(candidate, projectRoot)) {
          return {
            block: true,
            reason: `FILE PROTECTION: Access to '${candidate}' is blocked — sensitive file.\nUse a secret manager or an appropriate wrapper instead.`,
          };
        }
      }
    }

    // ── Secret Command Block (mirrors block-secret-commands.sh) ────────────
    if (toolName === "bash" && isSecretCommand(command)) {
      return {
        block: true,
        reason: `SECRET COMMAND BLOCKED: Command may expose secrets.\nUse 'run-with-secrets <profile> <cmd>' to access credentials safely.`,
      };
    }

    // ── Compaction Gate (blocks spawning new agents when context is full) ──
    if (toolName === "Task" || toolName === "spawn_agent") {
      try {
        const compaction = loadLib("compaction.js");
        const gate = compaction.checkCompactionGate(projectRoot);
        if (gate.status === "block") {
          return {
            block: true,
            reason: `COMPACTION GATE BLOCKED: ${gate.message}\nRun /compact before spawning new agents.`,
          };
        }
      } catch {}
    }

    // ── Task Role Claim (queue role for upcoming sub-agent) ────────────────
    if (toolName === "Task") {
      const taskPrompt = ((input.prompt as string) || (input.description as string) || "").toLowerCase();
      let expectedRole = "";
      if (/tester/.test(taskPrompt))         expectedRole = "tester";
      else if (/reviewer/.test(taskPrompt))  expectedRole = "reviewer";
      else if (/test.lead/.test(taskPrompt)) expectedRole = "test-lead";
      else if (/lead/.test(taskPrompt))      expectedRole = "lead";
      else if (/developer/.test(taskPrompt)) expectedRole = "developer";

      if (expectedRole) {
        const pendingDir = path.join(projectRoot, ".jonggrang", ".ephemeral", "pending-roles");
        try {
          fs.mkdirSync(pendingDir, { recursive: true });
          const claimFile = path.join(pendingDir, `${Date.now()}-${expectedRole}.json`);
          fs.writeFileSync(claimFile, JSON.stringify({ role: expectedRole, ts: Date.now() }));
        } catch {}
      }
    }

    // ── Agent-First Enforcement (blocks direct edits from orchestrator) ────
    if (toolName === "edit" || toolName === "write") {
      const agentsRegistry = path.join(projectRoot, ".jonggrang", ".output", "agents-registry.json");
      if (!fs.existsSync(agentsRegistry)) return;

      const domain = detectDomain(filePath);
      const registry: Record<string, unknown> = readJsonSafe(agentsRegistry);

      if (registry[domain]) {
        const sessionId = (ctx as any)?.sessionId || "";
        let sessionRole = "";
        if (sessionId) {
          const sessionRolesPath = path.join(projectRoot, ".jonggrang", ".ephemeral", "session-roles.json");
          const roles = readJsonSafe(sessionRolesPath);
          sessionRole = roles[sessionId] || "";
        }
        if (sessionRole !== "developer" && sessionRole !== "tester") {
          return {
            block: true,
            reason: `AGENT-FIRST ENFORCEMENT: Cannot edit ${filePath} directly.\nA '${domain}' specialist is registered. Spawn '${domain}-developer' agent instead.`,
          };
        }
      }
    }
  });

  // ── LAYER 3: tool_result → outputSanitization + trackModifications ──────
  // event.toolName is the Pi API property; event.content is (TextContent | ImageContent)[]
  // ToolResultEventResult: { content?, details?, isError? } — no additionalContext field
  pi.on("tool_result", (event) => {
    const toolName = event.toolName || "";
    const input = event.input || {};
    const filePath = (input.file_path as string) || (input.path as string) || "";

    // ── Output Sanitization (mirrors sanitize-output.sh) ─────────────────
    const rawContent = event.content ?? [];
    const outputStr = rawContent
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    const sanitized = sanitizeSecrets(outputStr);
    let hookReturn: import("@earendil-works/pi-coding-agent").ToolResultEventResult | undefined;
    if (sanitized !== outputStr) {
      hookReturn = {
        content: [{ type: "text", text: sanitized }],
      };
    }

    // ── Track Modifications (Dirty Bit) ──────────────────────────────────
    if (toolName === "edit" || toolName === "write") {
      const domain = detectDomain(filePath);
      try {
        const fb = loadLib("feedback.js");
        fb.setDirtyBit(projectRoot, domain);
      } catch (e: any) {
        console.error("[jonggrang] track-modifications warning:", e.message);
      }
    }

    return hookReturn;
  });

  // ── LAYER 4: agent_end → secretFinalCheck + feedbackLoop + qualityGate + outputEnforcement ─
  // Pi has "agent_end" not "agent_stop"
  pi.on("agent_end", (_event) => {
    // ── Secret Final Check (mirrors secret-final-check.sh) ───────────────
    try {
      const modifiedFiles = execSync(
        "{ git diff --name-only 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u",
        { cwd: projectRoot, encoding: "utf8" }
      ).split("\n").filter(Boolean);

      if (modifiedFiles.length > 0) {
        try {
          execSync("which trufflehog", { stdio: "ignore" });
          const scanDir = execSync("mktemp -d -t jonggrang-secret-scan.XXXXXXXX", { encoding: "utf8" }).trim();
          try {
            for (const f of modifiedFiles) {
              const src = path.join(projectRoot, f);
              const dst = path.join(scanDir, f);
              if (fs.existsSync(src)) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(src, dst);
              }
            }
            const leaked = execSync(
              `trufflehog filesystem --directory="${scanDir}" --only-verified --json --no-update 2>/dev/null || true`,
              { encoding: "utf8" }
            ).trim();
            if (leaked) {
              return {
                block: true,
                reason: `BLOCKED: Secret detected in modified files. Remove the secret and replace it with a secret manager reference before completing the task.\nFindings: ${leaked}`,
              };
            }
          } finally {
            try { execSync(`rm -rf "${scanDir}"`); } catch {}
          }
        } catch (e: any) {
          if (e.message && e.message.includes("BLOCKED:")) throw e;
          console.error("[jonggrang] WARNING: trufflehog not available — secret scan skipped.");
        }
      }
    } catch (e: any) {
      if (e.message && e.message.includes("BLOCKED:")) throw e;
    }

    // ── Feedback Loop Gate ────────────────────────────────────────────────
    try {
      const fb = loadLib("feedback.js");
      const gate = fb.checkExitGate(projectRoot);
      if (!gate.allowed) {
        const stuckCount = gate.stuck_count || 0;
        let message = `FEEDBACK LOOP GATE:\n${gate.reason}\n\nTo unblock:\n`;
        message += `  1. Spawn reviewer agent for each modified domain\n`;
        message += `  2. Spawn tester agent for each modified domain\n`;
        message += `  3. Both must return PASS status\n`;
        if (stuckCount > 3) {
          message += `\n=== ESCALATION ADVISOR ===\nAgent stuck for ${stuckCount} consecutive attempts.\n`;
          message += `Hint: Check feedback-loop-state.json — are reviewer/tester agents spawned?\n`;
        }
        return { block: true, reason: message };
      }
    } catch (e: any) {
      if (e.message && e.message.includes("FEEDBACK LOOP")) throw e;
    }

    // ── Output Enforcement (combined quality + output gates) ─────────────
    const violations: string[] = [];
    const ALLOWED_MD_PATTERNS = [
      /^\.jonggrang\//, /^\.claude\//, /^\.opencode\//, /^docs\//,
      /^AGENTS\.md$/, /^CLAUDE\.md$/, /^SKILL\.md$/,
      /^README\.md$/, /^CHANGELOG\.md$/, /^CONTRIBUTING\.md$/,
    ];
    try {
      const untracked = execSync("git ls-files --others --exclude-standard", {
        cwd: projectRoot, encoding: "utf8",
      }).split("\n").filter(Boolean);

      for (const file of untracked) {
        if (!file.endsWith(".md")) continue;
        if (!ALLOWED_MD_PATTERNS.some((p) => p.test(file))) {
          violations.push(`Unapproved .md file: ${file} (use .jonggrang/.output/)`);
        }
      }
    } catch {}

    if (violations.length > 0) {
      return {
        block: true,
        reason: `QUALITY/OUTPUT GATE VIOLATIONS:\n` + violations.map((v) => `  ✗ ${v}`).join("\n"),
      };
    }
  });
}
