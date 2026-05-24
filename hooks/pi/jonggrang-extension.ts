//
// JONGGRANG — Pi Extension
// Implements the same enforcement as Claude Code hooks and OpenCode plugin
// using Pi's TypeScript extension API.
//
// Events used:
//   session_start        → session role init (claim pending role from queue)
//   resources_discover   → redirect skill/prompt discovery to .jonggrang/
//   tool_call            → file protection + secret command block + agent-first + compaction gate + task role claim
//   tool_result          → track modifications (dirty bit) + output sanitization
//   agent_stop           → secret final check + feedback loop gate + quality gate + output enforcement
//
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const path = require("path") as typeof import("path");
const fs = require("fs") as typeof import("fs");
const { execSync, execFileSync } = require("child_process") as typeof import("child_process");

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
  // Resolve projectRoot from the extension's location:
  // installed at <projectRoot>/.jonggrang/extensions/jonggrang.ts → ../../.. = projectRoot
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const jonggrangLib = (() => {
    // Try npm package first, then fall back to co-located lib/
    try {
      return path.dirname(require.resolve("jonggrang/lib/jonggrang.js"));
    } catch {
      return path.join(projectRoot, "node_modules", "jonggrang", "lib");
    }
  })();

  function loadLib(name: string) {
    return require(path.join(jonggrangLib, name));
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
    const cwd = (event as any).cwd || projectRoot;
    return {
      skillPaths: [path.join(cwd, ".jonggrang", "skills")],
      promptPaths: [path.join(cwd, ".jonggrang", "prompts")],
      themePaths: [],
    };
  });

  // ── LAYER 2: tool_call → fileProtection + secretCommandBlock + agentFirst + compactionGate + taskRoleClaim ─
  pi.on("tool_call", (event, ctx) => {
    const toolName = (event as any).tool || "";
    const input = (event as any).input || {};
    const filePath = input.file_path || input.path || "";
    const command = input.command || input.cmd || "";
    const globPattern = input.pattern || input.glob || "";

    // ── File Protection (mirrors block-sensitive-files.sh) ─────────────────
    const isFileOp = /^(Read|Edit|Write|Glob|Grep|read_file|edit_file|write_file|view_file|str_replace_editor)$/i.test(toolName);
    if (isFileOp) {
      const candidates = [filePath, globPattern].filter(Boolean);
      for (const candidate of candidates) {
        if (isSensitiveFile(candidate, projectRoot)) {
          return {
            action: "block",
            reason: `FILE PROTECTION: Akses ke '${candidate}' diblokir — file sensitif.\nGunakan secret manager atau wrapper yang sesuai.`,
          };
        }
      }
    }

    // ── Secret Command Block (mirrors block-secret-commands.sh) ────────────
    const isShellOp = /^(Bash|bash|shell|run_bash|run_command|execute|exec|terminal)$/i.test(toolName);
    if (isShellOp && isSecretCommand(command)) {
      return {
        action: "block",
        reason: `SECRET COMMAND BLOCKED: Command berpotensi membongkar secret.\nGunakan 'run-with-secrets <profile> <cmd>' untuk akses kredensial.`,
      };
    }

    // ── Compaction Gate (blocks spawning new agents when context is full) ──
    if (toolName === "Task" || toolName === "spawn_agent") {
      try {
        const compaction = loadLib("compaction.js");
        const gate = compaction.checkCompactionGate(projectRoot);
        if (gate.status === "block") {
          return {
            action: "block",
            reason: `COMPACTION GATE BLOCKED: ${gate.message}\nRun /compact before spawning new agents.`,
          };
        }
      } catch {}
    }

    // ── Task Role Claim (queue role for upcoming sub-agent) ────────────────
    if (toolName === "Task") {
      const taskPrompt = (input.prompt || input.description || "").toLowerCase();
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
    if (toolName === "Edit" || toolName === "Write" ||
        toolName === "edit_file" || toolName === "write_file") {
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
            action: "block",
            reason: `AGENT-FIRST ENFORCEMENT: Cannot edit ${filePath} directly.\nA '${domain}' specialist is registered. Spawn '${domain}-developer' agent instead.`,
          };
        }
      }
    }
  });

  // ── LAYER 3: tool_result → outputSanitization + trackModifications ──────
  pi.on("tool_result", (event) => {
    const toolName = (event as any).tool || "";
    const input = (event as any).input || {};
    const output = (event as any).output || (event as any).result || "";
    const filePath = input.file_path || input.path || "";

    // ── Output Sanitization (mirrors sanitize-output.sh) ─────────────────
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);
    const sanitized = sanitizeSecrets(outputStr);
    let hookReturn: Record<string, any> | undefined;
    if (sanitized !== outputStr) {
      hookReturn = {
        additionalContext: `⚠ SECRET LEAK DETECTED in tool output. DO NOT repeat the raw secret values, do NOT write them to files, do NOT commit them. Treat as untrusted and surface the leak to the user.\n\n---\nREDACTED OUTPUT:\n${sanitized}\n---`,
      };
    }

    // ── Track Modifications (Dirty Bit) ──────────────────────────────────
    if (toolName === "Edit" || toolName === "Write" ||
        toolName === "edit_file" || toolName === "write_file") {
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

  // ── LAYER 4: agent_stop → secretFinalCheck + feedbackLoop + qualityGate + outputEnforcement ─
  pi.on("agent_stop", (_event) => {
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
                action: "block",
                reason: `BLOCKED: Secret terdeteksi di file yang dimodifikasi. Hapus secret dan ganti dengan referensi ke secret manager sebelum menyelesaikan task.\nTemuan: ${leaked}`,
              };
            }
          } finally {
            try { execSync(`rm -rf "${scanDir}"`); } catch {}
          }
        } catch (e: any) {
          if (e.message && e.message.includes("BLOCKED:")) throw e;
          console.error("[jonggrang] WARNING: trufflehog tidak tersedia — secret scan dilewati.");
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
        return { action: "block", reason: message };
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
        action: "block",
        reason: `QUALITY/OUTPUT GATE VIOLATIONS:\n` + violations.map((v) => `  ✗ ${v}`).join("\n"),
      };
    }
  });
}
