//
// JONGGRANG — Pi Extension
// Implements the same enforcement as Claude Code hooks and OpenCode plugin
// using Pi's TypeScript extension API.
//
// Events used:
//   session_start        → session role init (claim pending role from queue)
//   resources_discover   → redirect skill/prompt discovery to .jonggrang/
//   tool_call            → agent-first enforcement + compaction gate + task role claim
//   tool_result          → track modifications (dirty bit)
//   agent_stop           → feedback loop gate + quality gate + output enforcement
//
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const path = require("path") as typeof import("path");
const fs = require("fs") as typeof import("fs");
const { execSync } = require("child_process") as typeof import("child_process");

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

  // ── LAYER 2: tool_call → agentFirst + compactionGate + taskRoleClaim ─────
  pi.on("tool_call", (event, ctx) => {
    const toolName = (event as any).tool || "";
    const input = (event as any).input || {};
    const filePath = input.file_path || input.path || "";

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

  // ── LAYER 3: tool_result → trackModifications ────────────────────────────
  pi.on("tool_result", (event) => {
    const toolName = (event as any).tool || "";
    const input = (event as any).input || {};
    const filePath = input.file_path || input.path || "";

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
  });

  // ── LAYER 4: agent_stop → feedbackLoop + qualityGate + outputEnforcement ─
  pi.on("agent_stop", (_event) => {
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
