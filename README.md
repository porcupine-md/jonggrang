# Jonggrang

> AI Development Workflow Orchestrator — from project bootstrap to delivery.

Jonggrang is a CLI tool that orchestrates AI coding agents to handle your development workflow. It uses a **Work Loop** model — decompose a feature into tasks, implement them one-by-one with a fresh agent per task.

Supports three AI agent backends: [OpenCode](https://opencode.ai/), [Claude Code](https://claude.ai/code), and **Jonggrang** (built on the [Pi](https://pi.dev/) SDK — multi-provider, TypeScript-extensible).

Inspired by the [Ralph Loop](https://github.com/snarktank/ralph), [Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) (Addy Osmani), and the [collapsed SDLC](https://boristane.com/blog/the-software-development-lifecycle-is-dead/) (Boris Tane).

---

## How It Works

### Work Loop

```
You describe what you want
        |
        v
  jonggrang plan  -->  Phase 1: AI writes .jonggrang/plan.md (high-level, human-editable)
        |              Review / edit the plan in your editor
        v
  jonggrang approve  -->  Phase 2: AI reads plan.md → decomposes into tasks
        |                 plan.md archived, jonggrang-tasks.json written
        v
  jonggrang work  -->  For each task:
        |            1. Fresh context (no accumulated confusion)
        |            2. Read AGENTS.md + .jonggrang/progress.txt (project knowledge)
        |            3. Pick highest priority unblocked task
        |            4. Implement via AI agent (opencode/claude/jonggrang)
        |            5. Validate (typecheck, tests, lint)
        |            6. Commit if pass
        |            7. Log learnings
        |            8. Repeat
        v
  jonggrang review  -->  Comprehensive code review
```

**Shorthand options:**
```bash
jonggrang plan "feature" --yes           # plan + auto-approve + tasks in one shot
jonggrang plan "feature" --deep          # 3-phase deep analysis → enriched plan (Affected Areas, Risks, Alternatives)
jonggrang work "feature" --yes           # full pipeline: plan → approve → execute
jonggrang work "feature" --deep --yes    # deep mode full pipeline
```

---

## Requirements

- **AI agent** (pick one):
  - [OpenCode](https://opencode.ai/) (`--tool opencode`) — `curl -fsSL https://opencode.ai/install | bash`
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`--tool claude`) — `npm install -g @anthropic-ai/claude-code`
  - **Jonggrang** (`--tool jonggrang`, Pi SDK, multi-provider) — `npm install -g @earendil-works/pi-coding-agent`
- [jq](https://jqlang.github.io/jq/) — `brew install jq`
- git

## Install

```bash
npx jonggrang init
```

Or install globally:

```bash
npm install -g jonggrang
jonggrang init
```

---

## Quick Start

```bash
# 1. Go to your project
cd my-project

# 2. Initialize Jonggrang
jonggrang init

# 3a. Two-phase work loop (review plan before decompose)
jonggrang plan "REST API for todo management"   # generates plan.md for review
jonggrang approve                               # approve → decomposes to tasks
jonggrang work                                  # execute tasks

# 3b. One-shot (skip review)
jonggrang plan "REST API for todo management" --yes   # plan + approve + tasks
jonggrang work                                        # execute tasks

# 3c. Full pipeline in one command
jonggrang work "REST API for todo management" --yes   # plan → approve → execute

# 4. Review results
jonggrang review
```

### One-liner Init

```bash
# With OpenCode (default)
jonggrang init --name my-app --type api --stack express-typescript --autonomy balanced --force

# With Claude Code
jonggrang init --name my-app --type api --tool claude --autonomy autonomous --force

# With Jonggrang (Pi SDK — supports Anthropic, OpenAI, Gemini, DeepSeek, and more)
jonggrang init --name my-app --type api --tool jonggrang --autonomy autonomous --force

```

---

## Commands

### `jonggrang init`

Interactive wizard that sets up your project. Generates:
- `.jonggrang/jonggrang.json` — project configuration
- `AGENTS.md` — project knowledge for AI agents (human-curated)
- `.jonggrang/jonggrang-tasks.json` — task board
- `.jonggrang/progress.txt` — append-only learnings log
- `.claude/skills/`, `.opencode/skills/`, `.jonggrang/skills/` — prompt templates filtered by your project type
- `.claude/settings.json` — Claude Code enforcement hooks
- `.opencode/plugins/jonggrang.js` — OpenCode enforcement plugin
- `.jonggrang/extensions/jonggrang.ts` — Jonggrang (Pi) enforcement extension

**Flags to bypass the wizard:**

| Flag | Values | Description |
|------|--------|-------------|
| `--name` | any string | Project name |
| `--type` | `web-app`, `api`, `library`, `cli`, `tui` | Project type |
| `--work-mode` | `solo`, `team` | Solo or team mode |
| `--team-size` | `2-5` | Team size (if team) |
| `--state` | `new`, `existing` | New or existing project |
| `--stack` | `nextjs-typescript`, `express-typescript`, `go`, `python-fastapi`, `library-typescript`, `rust`, `python`, `node-typescript` | Tech stack |
| `--tool` | `opencode`, `claude`, `jonggrang` | AI agent tool (default: jonggrang) |
| `--autonomy` | `supervised`, `balanced`, `autonomous` | Default autonomy mode |
| `--ci` | `github-actions`, `gitlab-ci`, `none` | CI/CD provider |
| `--testing` | `vitest`, `jest`, `go-test`, `pytest`, `none` | Test framework |
| `--force` | — | Overwrite existing config |

**What `--tool jonggrang` sets up:**
- Installs `.jonggrang/extensions/jonggrang.ts` — TypeScript Pi extension with full enforcement hooks (file protection, secret blocking, output sanitization, feedback loop, quality gates)
- Skills copied to `.jonggrang/skills/` for Pi agent discovery
- Global config at `~/.jonggrang/settings.json`, project config at `.jonggrang/jonggrang.json`
- Supports any provider via env var or `jonggrang login`

After init, configure your AI provider:

```bash
jonggrang login    # add provider credentials (OAuth or API key)
jonggrang model    # select which model to use
```

### `jonggrang plan <description>`

**Phase 1** — AI generates `.jonggrang/plan.md`, a human-readable draft plan with YAML frontmatter (`feature`, `branch`, `work_type`). You review and edit the plan before anything gets decomposed into tasks.

```bash
jonggrang plan "user authentication with JWT, email registration, and password reset"
# → writes .jonggrang/plan.md
# → interactive prompt: Approve / Edit / Open $EDITOR / Save for later / Abort

jonggrang plan "user auth" --yes   # skip interactive prompt, auto-approve
```

### `jonggrang approve`

**Phase 2** — AI reads the approved `plan.md` and decomposes it into atomic tasks in `jonggrang-tasks.json`. Each task is:
- Small enough for one AI context window
- Has clear acceptance criteria
- Has file ownership (prevents conflicts)
- Has dependency ordering (`blocked_by`)

```bash
jonggrang approve
# → reads .jonggrang/plan.md
# → writes .jonggrang/jonggrang-tasks.json
# → archives plan to .jonggrang/.output/features/<id>/plan.md
```

> **Rule: completed tasks are immutable.** They reflect real code. Any correction must be a new task that fixes/replaces the previous implementation.

### `jonggrang work`

Runs the simple development loop. Each iteration is **stateless** — a fresh agent instance with clean context.

```bash
jonggrang work                                    # use config defaults
jonggrang work "feature" --yes                    # plan → approve → execute in one shot
jonggrang work --ignore-plan                      # skip pending plan warning, run existing tasks
jonggrang work --mode autonomous                  # override autonomy mode
jonggrang work --tool claude                      # override AI tool
jonggrang work --max-iterations 5
jonggrang work --task task-003                    # work on specific task
jonggrang work --branch feat/auth                 # create/use a branch
jonggrang work --dry-run                          # show prompts, don't execute
jonggrang work --debug                            # dump raw JSON from opencode/claude to stderr

# Pin model/effort per invocation (--tool and --model compose freely):
jonggrang plan "add auth" --tool claude --model opus --effort xhigh
jonggrang work --tool opencode --model anthropic/claude-opus-4-7 --effort high
jonggrang work --tool jonggrang --model anthropic/claude-sonnet-4-5 --effort medium
```

**`--model` / `--effort` backend mapping:**

| jonggrang flag | `--tool claude` | `--tool opencode` | `--tool jonggrang` |
|---|---|---|---|
| `--model` | `--model <alias\|id>` e.g. `opus`, `claude-opus-4-7` | `--model <provider/model>` e.g. `anthropic/claude-opus-4-7` | `--model <provider/model>` e.g. `anthropic/claude-sonnet-4-5` |
| `--effort` | `--effort low\|medium\|high\|max\|xhigh` | `--variant <level>` | SDK `thinkingLevel`: `off\|minimal\|low\|medium\|high\|xhigh` |

Resolution order: `--model` flag → `JONGGRANG_MODEL` env → `tools.<tool>.model` in `jonggrang.json` → `model` top-level → backend default.

### `jonggrang status`

Shows the task board.

```
==============================
  JONGGRANG Task Board
==============================

Project: my-app
Tasks: 2/5 completed

ID          Status       Role       Title
--------------------------------------------------------------
task-001    completed    lead       Design auth architecture
task-002    completed    developer  Implement JWT tokens
task-003    in_progress  reviewer   Review auth implementation
task-004    pending      test-lead  Plan auth tests
task-005    pending      tester     Execute auth test suite
```

### `jonggrang review`

Runs a comprehensive code review on all changes:
- Code quality and consistency
- Security vulnerabilities
- Test coverage
- Performance patterns

Output goes to `jonggrang-log/review-{timestamp}.md`.

### `jonggrang agent`

Opens a full interactive TUI chat session powered by the Pi engine. Chat with the AI directly — no plan/phase required.

```bash
jonggrang agent
```

Inside the chat, use `/` commands to trigger jonggrang workflow operations without leaving the session:

| Command | Description |
|---------|-------------|
| `/plan <description>` | Generate `.jonggrang/plan.md` for a feature |
| `/approve` | Decompose the current plan into tasks |
| `/work [description]` | Execute the task queue |
| `/status` | Show the project task board |
| `/review` | Run a code review |
| `/config` | Open Jonggrang settings (autonomy mode, agent tool) |
| `/login` | Add provider credentials |
| `/logout` | Remove provider credentials |
| `/model` | Switch AI model |

All other Pi built-in commands (`/compact`, `/help`, Ctrl+P model cycling, etc.) work as normal.

Security hooks (`hooks/pi/jonggrang-extension.ts`) are loaded automatically on every `jonggrang agent` session — no manual installation needed. The extension blocks access to `.env` and credential files, intercepts secret-leaking bash commands, sanitizes sensitive output, and enforces the feedback loop gate.

> Requires the jonggrang engine (`npm install -g @earendil-works/pi-coding-agent`). Run `jonggrang login` first to configure a provider.

### `jonggrang login`

Add provider credentials for the Jonggrang (Pi) engine. Supports OAuth subscriptions and API keys.

```bash
jonggrang login
```

A TUI menu lets you pick the provider:

**OAuth subscriptions** (no API key needed — uses your existing subscription):
- Anthropic Claude Pro/Max
- GitHub Copilot
- ChatGPT Plus/Pro (Codex)

**API key providers** (paste your key):
- Anthropic, OpenAI, Google Gemini, DeepSeek, Mistral, Groq, xAI, OpenRouter, Azure OpenAI, Cloudflare, Fireworks, Together AI, Hugging Face, Cerebras, and more

Credentials are stored in `~/.jonggrang/agent/auth.json`.

### `jonggrang logout`

Remove stored credentials for a provider.

```bash
jonggrang logout
# → shows configured providers → select one to remove
```

### `jonggrang model`

Select which AI model the Jonggrang engine will use. Shows models available for your configured providers.

```bash
jonggrang model
# → TUI list of available models grouped by provider
# → saves selection to .jonggrang/jonggrang.json
```

Requires at least one provider configured via `jonggrang login` (or an API key set as an environment variable).

### Interactive Menu

Run `jonggrang` without arguments (or `jonggrang menu`) to launch a full-screen TUI menu built on Pi TUI. Displays live project status (pending plan, task progress) in the header and lets you navigate with keyboard. Falls back to a plain `@clack/prompts` menu if Pi TUI is unavailable.

---

## Platform Architecture

Jonggrang is built on a **Thin Agent / Fat Platform** model. The AI models are stateless workers — all intelligence, state, and enforcement lives in the platform.

### Five-Layer Stack

```
┌─────────────────────────────────────────────┐
│  AGENT LAYER       Stateless workers (<150L) │
│  Lead · Developer · Reviewer · TestLead · Tester
├─────────────────────────────────────────────┤
│  SKILL LAYER       Two-tier progressive load │
│  Core (BIOS) · Library (JIT via Gateway)    │
├─────────────────────────────────────────────┤
│  ORCHESTRATION     16-phase state machine    │
│  MANIFEST.yaml · Work type · Phase skip     │
├─────────────────────────────────────────────┤
│  HOOK LAYER        Deterministic enforcement │
│  Claude Code hooks · OpenCode plugin        │
│  Jonggrang extension (.jonggrang/extensions)│
├─────────────────────────────────────────────┤
│  INFRASTRUCTURE    Compaction · Feedback     │
│  Token gates · Dirty bits · Lock files      │
└─────────────────────────────────────────────┘
```

### Five-Role Assembly Line

| Role | Agent | Does | Output |
|------|-------|------|--------|
| **Lead** | `*-lead` | Designs architecture, decomposes into tasks. Never writes code. | Architecture Plan JSON |
| **Developer** | `*-developer` | Implements specific tasks from the plan. | Source code + tests |
| **Reviewer** | `*-reviewer` | Validates design, compliance, and quality. Rejects non-compliant work. | Review Report JSON |
| **Test Lead** | `test-lead` | Analyzes implementation, designs test strategy. | Test Plan JSON |
| **Tester** | `*-tester` | Writes and runs tests from the plan. | Test Results JSON |

**Tool restriction boundary:**

| Role | Can Use | Cannot Use |
|------|---------|-----------|
| Lead, Test Lead | `Task`, `Read`, `TodoWrite` | `Edit`, `Write`, `Bash` |
| Developer, Tester | `Edit`, `Write`, `Bash`, `Read` | `Task` |
| Reviewer | `Read`, `Bash` | `Edit`, `Write`, `Task` |

Coordinators plan. Executors implement. Never both.

### Two-Tier Skill System

Skills live in two tiers:

```
skills/
├── core/             ← Tier 1 (BIOS) — always available
│   ├── gateway-backend/
│   ├── gateway-frontend/
│   ├── gateway-api/
│   ├── gateway-testing/
│   ├── gateway-database/
│   ├── orchestrating-feature/
│   ├── iterating-to-completion/
│   ├── dispatching-parallel-agents/
│   ├── persisting-agent-outputs/
│   └── [all standard skills: auth, scaffold-api, testing, ...]
└── library/          ← Tier 2 (Hard Drive) — loaded on-demand via Gateway
    ├── backend/
    │   ├── developing-with-tdd/
    │   ├── debugging-systematically/
    │   └── error-handling-patterns/
    ├── frontend/
    │   ├── debugging-react-hooks/
    │   └── optimizing-react-performance/
    ├── testing/
    │   ├── unit-testing-patterns/
    │   └── fixing-flaky-tests/
    ├── database/
    │   └── safe-migrations/
    ├── api/
    │   └── input-validation/
    └── security/
        └── rate-limiting/
```

**Gateway Pattern** — agents don't hardcode skill paths. They invoke a domain gateway which detects intent and returns the exact skill files to load:

```
Agent: "I need to fix a React infinite loop"
  ↓
Invokes: gateway-frontend
  ↓
Detects: "infinite loop", "useEffect"
  ↓
Returns: Read skills/library/frontend/debugging-react-hooks/SKILL.md
```

### Deterministic Hooks (Universal)

Hooks enforce quality gates outside the LLM's context. The same rules apply regardless of which AI tool is used:

| Layer | Event | Claude Code | OpenCode | Jonggrang (Pi) | Enforcement |
|-------|-------|-------------|----------|----------------|-------------|
| 5 | Pre-tool | `PreToolUse` | `tool.execute.before` | `tool_call` | Block direct edits (agent-first) |
| 5 | Pre-tool | `PreToolUse` | `tool.execute.before` | `tool_call` | Block agent spawn if context > 85% |
| 6 | Post-tool | `PostToolUse` | `tool.execute.after` | `tool_result` | Set dirty bit when files modified |
| 6 | File edit | `PostToolUse` | `file.edited` | `tool_result` | Track domain (backend/frontend/testing) |
| 7 | Sub-stop | `SubagentStop` | `session.updated` | `agent_end` | Block exit if output in wrong location |
| 8 | Stop | `Stop` | `session.idle` | `agent_end` | Block exit until review + tests pass |
| 8 | Stop | `Stop` | `session.idle` | `agent_end` | Final quality gate (defense in depth) |

Jonggrang hooks live in `hooks/pi/jonggrang-extension.ts` and are loaded automatically via `--extension` on every `jonggrang agent` invocation — no separate installation step required.

**Feedback Loop (Level 2 enforcement):**

When a developer modifies files, the dirty bit is set. The agent cannot exit until a reviewer AND tester have passed for every modified domain:

```json
{
  "active": true,
  "modified_domains": ["backend", "frontend"],
  "domain_phases": {
    "backend":  { "review": "PASS", "testing": "PASS" },
    "frontend": { "review": "PASS", "testing": "FAIL" }
  }
}
```
Exit is blocked until ALL domains have review=PASS AND testing=PASS.

### Compaction Gate

Before phases 3, 8, and 13 (heavy execution), the platform checks context usage:

| Usage | Threshold | Action |
|-------|-----------|--------|
| < 75% | — | Proceed |
| 75–80% | `WARN` | Warning, proceed |
| 80–85% | `MUST` | Strong warning, proceed |
| > 85% | `BLOCK` | Hard block — run `/compact` first |

Claude Code: reads `~/.claude/projects/{hash}/*.jsonl` transcripts.
OpenCode: refreshes on `session.compacted` event.
Jonggrang: checks via `before_provider_request` event in Pi extension.

### Persistent State

```
.jonggrang/
├── .output/
│   └── features/{feature-id}/
│       ├── MANIFEST.yaml           ← Phase tracking (survives session resets)
│       ├── 07-lead-architecture-plan.json
│       ├── 08-developer-task-001.json
│       ├── 09-reviewer-design-check.json
│       ├── 12-test-lead-plan.json
│       └── 13-tester-results.json
├── .ephemeral/
│   ├── feedback-loop-state.json    ← Dirty bits (cleared on restart)
│   └── compaction-state.json       ← Token usage cache
└── locks/
    └── {agent}.lock                ← File ownership during parallel runs
```

---

## Autonomy Modes

| Mode | Behavior | Best for |
|------|----------|----------|
| **supervised** | Pauses at brainstorming (Phase 6) for human design input | Critical systems |
| **balanced** | Auto-runs, pauses on failures or ambiguity | Daily development |
| **autonomous** | Full loop — plans, implements, commits. Human reviews at the end | Well-defined tasks |

```bash
jonggrang work --mode supervised
```

---

## Skill System

Skills are **markdown prompt templates** that guide AI agents through specific tasks.

### Built-in Core Skills

| Skill | Type | Description |
|-------|------|-------------|
| `prd` | generate | Generate PRD from feature description |
| `scaffold-api` | scaffold | API endpoint with route, validation, tests |
| `scaffold-webapp` | scaffold | Web app page with components, data fetching |
| `scaffold-library` | scaffold | Library with build config, exports, tests |
| `scaffold-deploy` | scaffold | Dockerfile, CI/CD config, environment configs |
| `component` | scaffold | UI component with test and story |
| `migration` | scaffold | Database migration with model update |
| `auth` | scaffold | Authentication flow end-to-end |
| `testing` | generate | Test suite for existing code |
| `gateway-deploy` | gateway | Route deploy intents to specific library skills |
| `orchestrating-feature` | orchestrate | 16-phase full workflow orchestration |
| `iterating-to-completion` | orchestrate | Completion promises + scratchpads + loop detection |
| `dispatching-parallel-agents` | orchestrate | Independent task parallel dispatch |

### Custom Skills

```bash
mkdir -p skills/core/my-skill
cat > skills/core/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: What this skill does
type: scaffold
tier: core
project_types: [web-app, api]
trigger: "natural language trigger"
---

## Context
Background info.

## Instructions
1. Step one
2. Step two

## Validation
- [ ] Check one
EOF
```

For deep-domain skills (JIT loaded), put them in `skills/library/{domain}/`:

```bash
mkdir -p skills/library/backend/my-pattern
cat > skills/library/backend/my-pattern/SKILL.md << 'EOF'
---
name: my-pattern
description: Deep domain knowledge
type: pattern
tier: library
domains: [backend]
trigger: "specific keywords that trigger gateway routing"
---
...
EOF
```

---

## Project Files

After `jonggrang init`, your project will have:

```
your-project/
├── AGENTS.md                # Project knowledge (edit this!)
├── skills/
│   ├── core/                # Tier 1 — always loaded
│   └── library/             # Tier 2 — JIT via gateway
├── .jonggrang/
│   ├── jonggrang.json       # Project config
│   ├── jonggrang-tasks.json # Task board state
│   ├── plan.md              # Draft plan (exists between plan → approve)
│   ├── progress.txt         # Auto-generated learnings
│   ├── .output/
│   │   └── features/<id>/
│   │       ├── plan.md      # Archived plan (after approve)
│   │       └── MANIFEST.yaml
│   ├── .ephemeral/          # Runtime state (feedback loop, compaction)
│   └── locks/               # File ownership locks
├── .claude/
│   ├── settings.json        # Claude Code enforcement hooks
│   └── skills/              # Skills for Claude Code agent
├── .opencode/
│   ├── plugins/
│   │   └── jonggrang.js     # OpenCode enforcement plugin
│   └── skills/              # Skills for OpenCode agent
└── .jonggrang/
    ├── skills/              # Skills for Jonggrang (Pi) agent
    └── extensions/
        └── jonggrang.ts     # Jonggrang (Pi) enforcement extension
```

### AGENTS.md

The most important file for output quality. Tells AI agents about your project's conventions, patterns, and gotchas. **Human-curated** — research shows human-written AGENTS.md improves agent success ~4%.

### .jonggrang/progress.txt

Append-only log written by the agent after each task. Captures learnings and prevents repeating mistakes across sessions.

---

## Configuration

Jonggrang uses a **two-layer settings** system:

| Layer | File | Scope |
|-------|------|-------|
| Global | `~/.jonggrang/settings.json` | User-wide defaults |
| Project | `.jonggrang/jonggrang.json` | Project overrides (wins over global) |

Edit via `/config` inside `jonggrang agent`, or directly in the files.

See `.jonggrang/jonggrang.json` after init:

```jsonc
{
  "tool": "opencode",          // opencode | claude | jonggrang | pi
  "model": "",                 // default model for --tool (backend-specific format; see docs/CONFIG.md)
  "effort": "",                // default effort/thinking level
  "tools": {                   // optional per-tool overrides for model/effort
    "claude":   { "model": "opus",                             "effort": "high" },
    "opencode": { "model": "anthropic/claude-opus-4-7",        "effort": "max"  },
    "pi":       { "model": "claude-sonnet-4-5",                "effort": "high" }
  },
  "provider": "anthropic",     // set by jonggrang model (jonggrang tool only)
  "mode": {
    "autonomy": "balanced"
  },
  "work": {
    "max_iterations": 10,
    "retry_limit": 2,
    "kill_after_fails": 3
  },
  "hooks": {
    "pre_commit": ["npm test"]
  },
  "orchestration": {
    "compaction": {
      "warn_threshold": 0.75,
      "block_threshold": 0.85
    }
  }
}
```

Full reference: [docs/CONFIG.md](docs/CONFIG.md)

---

## Web Dashboard

```bash
jonggrang web
jonggrang web --port 8080 --no-open
```

The dashboard provides a visual Kanban board, real-time agent logs, parallel group management, diff review, and orchestration phase tracking.

**API endpoints include:**
- `GET  /api/jonggrang/manifests` — list all orchestration runs
- `GET  /api/jonggrang/manifests/:id` — get phase details
- `POST /api/jonggrang/orchestrate` — start new orchestration
- `POST /api/jonggrang/orchestrate/resume` — resume incomplete run
- `GET  /api/jonggrang/compaction` — current context usage
- `GET  /api/jonggrang/feedback-state` — current dirty bit state
- `POST /api/jonggrang/plan` — Phase 1: generate plan.md
- `GET  /api/jonggrang/plan/content` — read current plan.md
- `PUT  /api/jonggrang/plan/content` — save edited plan.md from UI
- `DELETE /api/jonggrang/plan/content` — discard pending plan
- `POST /api/jonggrang/approve` — Phase 2: decompose plan.md → tasks

WebSocket emits `plan_update: { exists, content }` whenever plan.md changes.

---

## Release Workflow

```bash
make install        # install root + client deps
make build          # standard build pipeline
make release        # bump version + rebuild (default: patch)
make release BUMP=minor
make release-major
```

Binary build (Bun):

```bash
make build-binary
make build-binary BIN_OUT=out/jonggrang-darwin
```

---

## Documentation

- [JONGGRANG.md](docs/JONGGRANG.md) — Full specification
- [SKILLS.md](docs/SKILLS.md) — Skill system documentation
- [WORKFLOW.md](docs/WORKFLOW.md) — Detailed workflow documentation
- [CONFIG.md](docs/CONFIG.md) — Configuration reference

---

## License

MIT © Porcupine Team
