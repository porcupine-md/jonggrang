# Jonggrang

> AI Development Workflow Orchestrator — from project bootstrap to delivery.

Jonggrang is a CLI tool that orchestrates AI coding agents to handle your development workflow. It supports two modes:

- **Work Loop** — decompose a feature into tasks, implement them one-by-one with a fresh agent per task
- **Orchestrate** — full 16-phase deterministic pipeline with specialized roles, quality gates, and persistent state across sessions

Supports [OpenCode](https://opencode.ai/) (default) and [Claude Code](https://claude.ai/code) as the AI agent backend.

Inspired by the [Ralph Loop](https://github.com/snarktank/ralph), [Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) (Addy Osmani), and the [collapsed SDLC](https://boristane.com/blog/the-software-development-lifecycle-is-dead/) (Boris Tane).

---

## How It Works

### Work Loop (simple)

```
You describe what you want
        |
        v
  jonggrang plan  -->  Decomposes into atomic tasks
        |
        v
  jonggrang work  -->  For each task:
        |            1. Fresh context (no accumulated confusion)
        |            2. Read AGENTS.md + .jonggrang/progress.txt (project knowledge)
        |            3. Pick highest priority unblocked task
        |            4. Implement via AI agent (opencode/claude)
        |            5. Validate (typecheck, tests, lint)
        |            6. Commit if pass
        |            7. Log learnings
        |            8. Repeat
        v
  jonggrang review  -->  Comprehensive code review
```

### Orchestrate (deterministic, 16-phase)

```
jonggrang orchestrate "Add payment integration"
        |
        v
  Phase 1-2   Setup + Triage (classify work type, skip irrelevant phases)
        |
        v
  Phase 3-4   Codebase Discovery + Skill Discovery
        |
        v
  Phase 5-7   Lead Agent: Complexity → Brainstorming → Architecture Plan
        |
        v
  Phase 8     Developer Agents implement each atomic task
        |
        v
  Phase 9-11  Reviewer Agents: Design check → Domain compliance → Code quality
        |
        v
  Phase 12    Test Lead designs the test strategy
        |
        v
  Phase 13-15 Tester Agents: Execute → Coverage → Test quality
        |
        v
  Phase 16    Completion: commit + PR
```

State is persisted in `MANIFEST.yaml` — sessions can be interrupted and resumed.

---

## Requirements

- **AI agent** (at least one):
  - [OpenCode](https://opencode.ai/) (default) — `curl -fsSL https://opencode.ai/install | bash`
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
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

# 3a. Simple work loop
jonggrang plan "REST API for todo management"
jonggrang work

# 3b. Full deterministic orchestration
jonggrang orchestrate "REST API for todo management with CRUD and tests"

# 4. Review results
jonggrang review
```

### One-liner Init

```bash
# With OpenCode (default)
jonggrang init --name my-app --type api --stack express-typescript --autonomy balanced --force

# With Claude Code
jonggrang init --name my-app --type api --tool claude --autonomy autonomous --force
```

---

## Commands

### `jonggrang init`

Interactive wizard that sets up your project. Generates:
- `.jonggrang/jonggrang.json` — project configuration
- `AGENTS.md` — project knowledge for AI agents (human-curated)
- `.jonggrang/jonggrang-tasks.json` — task board
- `.jonggrang/progress.txt` — append-only learnings log
- `skills/` — prompt templates filtered by your project type
- `.claude/settings.json` — Claude Code enforcement hooks (if `--tool claude`)
- `.opencode/plugins/jonggrang.js` — OpenCode enforcement plugin (if `--tool opencode`)

**Flags to bypass the wizard:**

| Flag | Values | Description |
|------|--------|-------------|
| `--name` | any string | Project name |
| `--type` | `web-app`, `api`, `library`, `cli`, `tui` | Project type |
| `--work-mode` | `solo`, `team` | Solo or team mode |
| `--team-size` | `2-5` | Team size (if team) |
| `--state` | `new`, `existing` | New or existing project |
| `--stack` | `nextjs-typescript`, `express-typescript`, `go`, `python-fastapi`, `library-typescript`, `rust`, `python`, `node-typescript` | Tech stack |
| `--tool` | `opencode`, `claude` | AI agent tool (default: opencode) |
| `--autonomy` | `supervised`, `balanced`, `autonomous` | Default autonomy mode |
| `--ci` | `github-actions`, `gitlab-ci`, `none` | CI/CD provider |
| `--testing` | `vitest`, `jest`, `go-test`, `pytest`, `none` | Test framework |
| `--force` | — | Overwrite existing config |

### `jonggrang plan <description>`

Decomposes a feature description into atomic tasks. Each task is:
- Small enough for one AI context window
- Has clear acceptance criteria
- Has file ownership (prevents conflicts)
- Has dependency ordering (`blocked_by`)

```bash
jonggrang plan "user authentication with JWT, email registration, and password reset"
```

### `jonggrang work`

Runs the simple development loop. Each iteration is **stateless** — a fresh agent instance with clean context.

```bash
jonggrang work                                    # use config defaults
jonggrang work --mode autonomous                  # override autonomy mode
jonggrang work --tool claude                      # override AI tool
jonggrang work --max-iterations 5
jonggrang work --task task-003                    # work on specific task
jonggrang work --branch feat/auth                 # create/use a branch
jonggrang work --dry-run                          # show prompts, don't execute
```

### `jonggrang orchestrate <description>`

Full 16-phase deterministic orchestration. Classifies the work type, activates the appropriate phases, runs the five-role assembly line, and persists state across sessions.

```bash
jonggrang orchestrate "add Stripe payment integration"
jonggrang orchestrate --resume                   # resume interrupted session
jonggrang orchestrate --dry-run "feature"        # preview phases without executing
jonggrang orchestrate --tool claude "feature"    # force Claude Code backend
jonggrang orchestrate --mode supervised "feature" # pause at brainstorming phase
```

**Phase skipping by work type:**

| Work Type | Trigger | Skipped Phases |
|-----------|---------|----------------|
| `BUGFIX` | "fix", "bug", "issue", "error" | 5, 6, 7, 9, 12 — no architecture, no brainstorming |
| `SMALL` | < 100 lines, single concern | 5, 6, 7, 9 — no complexity analysis |
| `MEDIUM` | Multi-file, some design | None |
| `LARGE` | New subsystem, architectural | None — all 16 phases |

A bug fix runs ~5 phases. A new subsystem gets all 16.

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

### Interactive Menu

Run `jonggrang` without arguments (or `jonggrang menu`) to launch an interactive menu.

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

| Layer | Event | Claude Code | OpenCode | Enforcement |
|-------|-------|-------------|----------|-------------|
| 5 | Pre-tool | `PreToolUse` | `tool.execute.before` | Block direct edits (agent-first) |
| 5 | Pre-tool | `PreToolUse` | `tool.execute.before` | Block agent spawn if context > 85% |
| 6 | Post-tool | `PostToolUse` | `tool.execute.after` | Set dirty bit when files modified |
| 6 | File edit | `PostToolUse` | `file.edited` | Track domain (backend/frontend/testing) |
| 7 | Sub-stop | `SubagentStop` | `session.updated` | Block exit if output in wrong location |
| 8 | Stop | `Stop` | `session.idle` | Block exit until review + tests pass |
| 8 | Stop | `Stop` | `session.idle` | Final quality gate (defense in depth) |

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
jonggrang orchestrate --mode supervised "redesign auth system"
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
| `component` | scaffold | UI component with test and story |
| `migration` | scaffold | Database migration with model update |
| `auth` | scaffold | Authentication flow end-to-end |
| `testing` | generate | Test suite for existing code |
| `deploy` | generate | Dockerfile, CI/CD, environment configs |
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
│   ├── progress.txt         # Auto-generated learnings
│   ├── .output/             # Agent outputs + MANIFEST.yaml
│   ├── .ephemeral/          # Runtime state (feedback loop, compaction)
│   └── locks/               # File ownership locks
├── .claude/
│   └── settings.json        # Claude Code enforcement hooks
└── .opencode/
    └── plugins/
        └── jonggrang.js     # OpenCode enforcement plugin
```

### AGENTS.md

The most important file for output quality. Tells AI agents about your project's conventions, patterns, and gotchas. **Human-curated** — research shows human-written AGENTS.md improves agent success ~4%.

### .jonggrang/progress.txt

Append-only log written by the agent after each task. Captures learnings and prevents repeating mistakes across sessions.

---

## Configuration

See `.jonggrang/jonggrang.json` after init:

```jsonc
{
  "tool": "opencode",
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
