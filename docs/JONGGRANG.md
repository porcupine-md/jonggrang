# Jonggrang — AI Development Workflow Orchestrator

> *"Jonggrang, the wise servant-guardian — the unseen puppeteer who orchestrates the entire play of software development."*

Jonggrang is a CLI tool that serves as an **AI development orchestrator** — from project bootstrap to delivery. It operates in two modes: a simple **work loop** (stateless, task-by-task) and a full **deterministic orchestration** (16-phase, role-specialized, persistent state).

Inspired by the Ralph Loop pattern, Agent Orchestra (Addy Osmani), the collapsed SDLC (Boris Tane), and the Thin Agent / Fat Platform architecture from deterministic AI systems research.

---

## Table of Contents

1. [Philosophy](#philosophy)
2. [Architecture Overview](#architecture-overview)
3. [The Two Modes](#the-two-modes)
4. [Five-Role Assembly Line](#five-role-assembly-line)
5. [Autonomy Modes](#autonomy-modes)
6. [Skill System](#skill-system)
7. [Deterministic Hooks](#deterministic-hooks)
8. [Team Mode](#team-mode)
9. [Quality Gates](#quality-gates)
10. [Compound Learning](#compound-learning)
11. [Config Reference](#config-reference)
12. [Comparison with Ralph](#comparison-with-ralph)

---

## Philosophy

### Core Principles

1. **Thin Agent / Fat Platform** — AI models are ephemeral workers. All intelligence, state, and enforcement lives in the platform (hooks, skills, orchestration engine). Agents are reduced to stateless workers; the platform holds all the knowledge.

2. **Context Engineering > Prompt Engineering** — Token usage alone explains 80% of performance variance in agent tasks. Jonggrang manages context aggressively: JIT skill loading, compaction gates, fresh context per iteration.

3. **Deterministic Enforcement > Probabilistic Guidance** — Hooks enforce rules outside the LLM's context. The agent cannot rationalize around a bash script that blocks its exit.

4. **Verification > Generation** — The bottleneck is no longer writing code, but verifying it. Every layer is designed to catch errors early: reviewer agents, tester agents, quality gate hooks.

5. **Stateless Execution, Persistent Memory** — Each iteration starts with a clean context window. Memory persists via MANIFEST.yaml, git history, progress.txt, and AGENTS.md.

6. **Right-sized Tasks** — Every task must fit in a single context window. Atomic, testable, committable.

7. **Human in the Loop (Adjustable)** — From fully supervised to fully autonomous.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: AGENT LAYER                                   │
│  Lead · Developer · Reviewer · Test Lead · Tester       │
│  Stateless workers, <150 lines each                     │
├─────────────────────────────────────────────────────────┤
│  LAYER 2: SKILL LAYER                                   │
│  Core (BIOS) — always loaded                            │
│  Library (Hard Drive) — JIT via Gateway                 │
├─────────────────────────────────────────────────────────┤
│  LAYER 3: ORCHESTRATION LAYER                           │
│  16-phase state machine · MANIFEST.yaml · Work types    │
│  Phase skip logic · Compaction gates                    │
├─────────────────────────────────────────────────────────┤
│  LAYER 4: HOOK LAYER (deterministic enforcement)        │
│  Claude Code: PreToolUse · PostToolUse · Stop           │
│  OpenCode:    tool.execute.before/after · file.edited   │
├─────────────────────────────────────────────────────────┤
│  LAYER 5: INFRASTRUCTURE                                │
│  Token tracking · Dirty bits · File locks               │
│  MANIFEST persistence · Session resume                  │
└─────────────────────────────────────────────────────────┘
```

### Project File Structure

```
project-root/
├── jonggrang.json              # Project config
├── AGENTS.md                   # Human-curated knowledge
├── progress.txt                # Append-only agent learnings
├── jonggrang-tasks.json        # Task board state
├── skills/
│   ├── core/                   # Tier 1: always loaded
│   │   ├── gateway-backend/
│   │   ├── gateway-frontend/
│   │   ├── orchestrating-feature/
│   │   ├── iterating-to-completion/
│   │   └── [all standard skills]
│   └── library/                # Tier 2: JIT loaded via Gateway
│       ├── backend/
│       ├── frontend/
│       ├── testing/
│       ├── database/
│       ├── api/
│       └── security/
├── templates/
│   └── agents/                 # Role definitions
│       ├── lead.md
│       ├── developer.md
│       ├── reviewer.md
│       ├── test-lead.md
│       └── tester.md
├── .jonggrang/
│   ├── .output/
│   │   └── features/{id}/
│   │       ├── MANIFEST.yaml   # Phase state (persistent)
│   │       └── [phase outputs]
│   ├── .ephemeral/             # Cleared on restart
│   │   ├── feedback-loop-state.json
│   │   └── compaction-state.json
│   └── locks/                  # File ownership
├── .claude/
│   └── settings.json           # Claude Code enforcement hooks
└── .opencode/
    └── plugins/
        └── jonggrang.js        # OpenCode enforcement plugin
```

---

## The Two Modes

### Mode 1: Work Loop (`jonggrang work`)

Simple stateless loop. Each iteration gets a fresh context window.

```
jonggrang plan "feature"
    |
    v
Decompose into atomic tasks (jonggrang-tasks.json)
    |
    v
jonggrang work
    |
    v
For each task:
  1. Load AGENTS.md + progress.txt + task state
  2. Pick highest-priority unblocked task
  3. Implement via AI agent
  4. Validate (typecheck, lint, tests)
  5. Commit if pass, log learnings
  6. Repeat
    |
    v
jonggrang review  →  Comprehensive scan
```

Best for: well-understood tasks, boilerplate, incremental work.

### Mode 2: Orchestrate (`jonggrang orchestrate`)

Full 16-phase deterministic pipeline with the five-role assembly line.

```
jonggrang orchestrate "feature"
    |
    v
Phase 1-2   Setup + Triage
            Classify BUGFIX/SMALL/MEDIUM/LARGE → skip irrelevant phases
    |
    v
Phase 3-4   Codebase Discovery + Skill Discovery
            ⚠ Compaction gate check
    |
    v
Phase 5-7   Lead: Complexity → Brainstorming → Architecture Plan
    |
    v
Phase 8     Developer: Implement atomic tasks
            ⚠ Compaction gate check
    |
    v
Phase 9-11  Reviewer: Design check → Domain compliance → Code quality
    |
    v
Phase 12    Test Lead: Design test strategy
    |
    v
Phase 13-15 Tester: Execute → Coverage → Test quality
            ⚠ Compaction gate check
    |
    v
Phase 16    Completion: commit + optional PR
```

State persists in `MANIFEST.yaml`. Interrupt and resume across sessions:
```bash
jonggrang orchestrate --resume
```

**Phase skipping by work type:**

| Work Type | Trigger | Phases skipped |
|-----------|---------|----------------|
| `BUGFIX` | "fix", "bug", "issue", "error", "crash" | 5, 6, 7, 9, 12 |
| `SMALL` | <100 lines, single concern | 5, 6, 7, 9 |
| `MEDIUM` | Multi-file, some design | None |
| `LARGE` | New subsystem, architectural | None |

A bug fix runs ~5 phases. A new subsystem gets all 16.

---

## Five-Role Assembly Line

Complex work flows through a specialized assembly line. Each role has a restricted toolset, preventing them from doing work outside their expertise.

```
User → Orchestrator
         |
         ├──► Lead Agent          "Design the architecture"
         │        └──► Architecture Plan JSON
         │
         ├──► Developer Agent     "Implement task-001"
         │        └──► Source code
         │
         ├──► Reviewer Agent      "Review task-001"
         │        └──► Review Report JSON (approved/rejected)
         │
         ├──► Test Lead Agent     "Plan tests for this implementation"
         │        └──► Test Plan JSON
         │
         └──► Tester Agent        "Execute the test plan"
                  └──► Test Results JSON
```

### Role Definitions

| Role | Responsibility | Tools | Forbidden |
|------|---------------|-------|-----------|
| **Lead** | Architecture & strategy. Never writes code. | Task, Read, TodoWrite | Edit, Write, Bash |
| **Developer** | Implementation. Executes tasks from the plan. | Edit, Write, Bash, Read | Task |
| **Reviewer** | Validates code against specs and patterns. | Read, Bash | Edit, Write, Task |
| **Test Lead** | Analyzes implementation, designs test strategy. | Task, Read, TodoWrite | Edit, Write, Bash |
| **Tester** | Writes and runs tests from the plan. | Edit, Write, Bash, Read | Task |

**Key constraint:** Coordinators (Lead, Test Lead) can spawn sub-agents via `Task` but cannot touch files. Executors (Developer, Tester) can modify files but cannot spawn agents. This enforces the Thin Agent / Fat Platform model.

### Completion Signals

Each agent outputs a completion signal only when success criteria are genuinely met:

| Agent | Signal |
|-------|--------|
| Lead | `ARCHITECTURE_PLAN_COMPLETE` |
| Developer | `IMPLEMENTATION_COMPLETE` |
| Reviewer | `REVIEW_COMPLETE` |
| Test Lead | `TEST_PLAN_COMPLETE` |
| Tester | `ALL_TESTS_PASSING` |

The orchestrator blocks on these signals. Hooks enforce that `ALL_TESTS_PASSING` cannot be output if tests are actually failing.

---

## Autonomy Modes

### Supervised Mode

> *"Agent proposes, human decides."*

Best for: learning, critical systems, architectural work.

- Pauses at Phase 6 (Brainstorming) for design input
- Validates plan before implementation
- Requires human approval at commit

### Balanced Mode

> *"Agent runs, pauses at checkpoints."*

Best for: daily development, trusted codebase.

- Auto-approves plans
- Pauses only on validation failure or ambiguity
- Human reviews at end of batch

### Autonomous Mode

> *"Full loop — human reviews at the end."*

Best for: well-defined tasks, boilerplate, confident specs.

- Runs all phases without interruption
- Skips Phase 6 (brainstorming) automatically
- Retries up to 2x on failure, then skips
- Human reviews final result

| Behavior | Supervised | Balanced | Autonomous |
|----------|-----------|----------|------------|
| Plan approval | Human | Auto | Auto |
| Phase 6 (brainstorm) | Human pause | Human pause | Auto-skip |
| Commit approval | Human | Auto | Auto |
| Pause on fail | Immediate | After fail | After 2x retry |
| Human touchpoints | Every step | On exception | End only |

---

## Skill System

Skills are **markdown prompt templates** that guide agents through specific tasks. They live in a two-tier architecture.

### Tier 1: Core Skills (BIOS)

Location: `skills/core/`

Always available to agents. Includes:
- All standard scaffold/generate skills (scaffold-api, testing, auth, etc.)
- Domain gateways (gateway-backend, gateway-frontend, gateway-api, gateway-testing, gateway-database)
- Orchestration skills (orchestrating-feature, iterating-to-completion, dispatching-parallel-agents, persisting-agent-outputs)

### Tier 2: Library Skills (Hard Drive)

Location: `skills/library/{domain}/`

Invisible to agents until explicitly loaded via a Gateway. Loaded JIT when intent is detected. Prevents context bloat from skills the agent doesn't need.

### Gateway Pattern

Agents don't hardcode skill paths. They invoke a gateway which detects intent and returns the right files to load:

```
Agent: "I need to fix a React infinite loop"
    ↓
Invokes: gateway-frontend
    ↓
Detects keywords: "infinite loop", "useEffect"
    ↓
Returns: "Read skills/library/frontend/debugging-react-hooks/SKILL.md"
```

This implements **intent-based context loading** — agents only load knowledge relevant to the task at hand.

### Skill File Format

```markdown
---
name: skill-name
description: One-line description
type: scaffold | transform | validate | generate | gateway | orchestrate | pattern | workflow
tier: core | library
domains: [backend, frontend, api, testing, database, deploy, security]
trigger: "natural language triggers"
---

## Context
Background. Variables: {{project_name}}, {{stack}}, {{test_framework}}

## Instructions
1. Step one

## Validation
- [ ] Check one
```

See [SKILLS.md](./SKILLS.md) for full documentation.

---

## Deterministic Hooks

While skills provide guidance, **hooks provide enforcement**. They run outside the LLM's context and cannot be bypassed.

### Eight-Layer Defense

| Layer | Mechanism | Tool |
|-------|-----------|------|
| 1 | CLAUDE.md / AGENTS.md | Full ruleset loaded at session start |
| 2 | Core Skills | Procedural workflows (how to do X) |
| 3 | Agent Definitions | Role behavior, tool restrictions, output formats |
| 4 | UserPromptSubmit / session.created | Inject reminders every prompt |
| 5 | PreToolUse / tool.execute.before | Block BEFORE action (agent-first, compaction gate) |
| 6 | PostToolUse / tool.execute.after | Track modifications (dirty bit) |
| 7 | SubagentStop / session.updated | Block premature exit (output enforcement) |
| 8 | Stop / session.idle | Block exit until review + tests pass (feedback loop) |

### Compaction Gate

Before heavy phases (3, 8, 13), the platform checks token usage:

| Usage | Status | Action |
|-------|--------|--------|
| < 75% | `ok` | Proceed |
| 75–80% | `warn` | Warning, proceed |
| 80–85% | `must` | Strong warning, proceed |
| > 85% | `block` | Hard block — run `/compact` first |

### Feedback Loop

When a developer agent modifies files, the dirty bit is set. The agent cannot exit until a reviewer AND tester have both passed for every modified domain:

```json
{
  "active": true,
  "dirty_bit": true,
  "modified_domains": ["backend", "frontend"],
  "domain_phases": {
    "backend":  { "review": "PASS", "testing": "PASS" },
    "frontend": { "review": "PASS", "testing": "FAIL" }
  }
}
```

Exit is blocked until ALL domains pass ALL phases. If any domain fails, ALL domains reset.

### Universal: Claude Code + OpenCode

The same enforcement logic runs on both tools:

| Hook | Claude Code | OpenCode |
|------|-------------|----------|
| Agent-first (block direct edit) | `PreToolUse` | `tool.execute.before` |
| Compaction gate (block Task) | `PreToolUse` | `tool.execute.before` |
| Dirty bit (file modified) | `PostToolUse` | `tool.execute.after` + `file.edited` |
| Output enforcement (exit) | `SubagentStop` | `session.updated` |
| Feedback loop (exit) | `Stop` | `session.idle` |
| Quality gate (exit) | `Stop` | `session.idle` |

---

## Team Mode

Team mode allows multiple developers to work in parallel on a single project with coordination via a shared task board.

### Parallel Execution

Jonggrang detects independent task groups using a Union-Find algorithm on the `blocked_by` dependency graph. Independent groups run in separate git worktrees simultaneously.

```
Task A (independent)         → Group 1 → worktree-1
Task B → blocked_by A  \
Task C → blocked_by B   → Group 2 → worktree-2 (serial within group)
Task D (independent)         → Group 3 → worktree-3
```

### File Ownership

**Rule: One file, one owner.** Lock files in `.jonggrang/locks/` prevent race conditions. When an agent writes a file, it registers a lock. Other agents check locks before writing.

### Team Commands

```bash
jonggrang plan "feature description"    # decompose into tasks
jonggrang work --pick                   # self-claim next available task
jonggrang status                        # view task board
```

Via web dashboard:
```bash
jonggrang web
# → parallel groups UI, diff review, merge/revise controls
```

---

## Quality Gates

### Gate Layers

```
Layer 1: PLAN GATE
  Before implementation begins.
  supervised:  Human review + approve plan
  balanced:    Auto-approved, logged
  autonomous:  Auto-approved, logged

Layer 2: HOOK ENFORCEMENT (deterministic)
  During work.
  - PreToolUse: agent-first + compaction gate
  - PostToolUse: dirty bit tracking
  - Stop: feedback loop + quality gate

Layer 3: ASSEMBLY LINE REVIEW
  After implementation.
  - Reviewer agent: design verification
  - Reviewer agent: domain compliance
  - Reviewer agent: code quality
  - Tester agent: test execution + coverage

Layer 4: SESSION REVIEW
  After all work completes.
  jonggrang review → comprehensive scan
  - Code quality, test coverage, security, performance
```

### Failure Recovery

| Failure Type | Recovery |
|---|---|
| Single task failure | Retry up to `retry_limit` times |
| 3 consecutive failures | Mark task `blocked`, notify human |
| Reviewer rejects | Developer re-implements, reviewer re-checks |
| Tests fail | Developer fixes, tester re-runs |
| Context > 85% | Compaction gate blocks, human runs /compact, resume |
| Agent stuck (>3 blocked exits) | Escalation advisor triggers |

### Escalation Advisor

When an agent is stuck in a loop (blocked exit >3 times), an out-of-band LLM analyzes the session transcript and injects a hint:

> "Hint: The developer agent is writing to auth.ts but has not spawned a reviewer. The feedback loop requires review before exit."

---

## Compound Learning

### Memory Channels

| Channel | Type | Who Writes | Purpose |
|---------|------|-----------|---------|
| `AGENTS.md` | Curated | Human (reviewed) | Conventions, gotchas, patterns |
| `progress.txt` | Append-only | Agent | Per-task learnings, surprises |
| `jonggrang-tasks.json` | Structured | Agent + Human | Task state and history |
| `.jonggrang/.output/` | Structured JSON | Agent | Phase outputs, architecture plans |
| `MANIFEST.yaml` | YAML | Orchestrator | Phase state, resume point |
| Git history | Immutable | Agent | Code changes with context |

### AGENTS.md

Human-curated project knowledge. Research shows human-written AGENTS.md improves agent success ~4%. LLM-generated ones can decrease quality by ~3% and increase cost 20%+.

**Agent proposes, human curates.**

### progress.txt

Append-only log written after each task:

```
## Session 2026-04-11 — Task: user-registration

### What was done
- Created POST /api/users with Zod validation
- Added Prisma unique constraint error handling

### What was learned
- Prisma P2002 error needs explicit catch (not caught by generic handler)
- Test database requires explicit cleanup between runs
```

---

## Config Reference

```jsonc
{
  "name": "my-app",
  "version": "1.0.0",
  "tool": "opencode",           // "opencode" | "claude"

  "project": {
    "type": "api",              // web-app | api | library | cli | tui
    "stack": "express-typescript"
  },

  "mode": {
    "work": "solo",             // solo | team
    "autonomy": "balanced",     // supervised | balanced | autonomous
    "max_team_size": 5
  },

  "work": {
    "max_iterations": 10,
    "retry_limit": 2,
    "kill_after_fails": 3,
    "branch_prefix": "feat/",
    "commit_prefix": "feat|fix|refactor|test|docs|chore"
  },

  "orchestration": {
    "compaction": {
      "warn_threshold": 0.75,   // 75% — warn
      "block_threshold": 0.85   // 85% — hard block
    }
  },

  "hooks": {
    "pre_implement": [],
    "post_implement": ["npm run typecheck", "npm run lint"],
    "pre_commit": ["npm run test"],
    "post_commit": [],
    "task_complete": ["npm run test -- --coverage"],
    "session_end": []
  },

  "testing": {
    "framework": "vitest",
    "command": "npm run test",
    "coverage_threshold": 80
  },

  "ci": {
    "provider": "github-actions",
    "auto_setup": true
  },

  "skills": {
    "directory": "./skills",
    "custom": []
  },

  "review": {
    "security": true,
    "performance": true,
    "coverage": true
  }
}
```

See [CONFIG.md](./CONFIG.md) for a complete reference.

---

## Comparison

| Aspect | Ralph | Jonggrang v1 | Jonggrang (current) |
|--------|-------|-------------|---------------------|
| **Model** | Thick agent | Thick agent | Thin Agent / Fat Platform |
| **Orchestration** | Single loop | Task loop | 16-phase state machine |
| **Roles** | None | None | Lead / Dev / Reviewer / TestLead / Tester |
| **Skill system** | PRD prompt | 9 flat skills | Two-tier: Core (BIOS) + Library (JIT) |
| **State** | progress.txt | tasks + progress | MANIFEST.yaml + dual ephemeral/persistent |
| **Enforcement** | None | Pre-commit hooks | 8-layer deterministic hooks (Claude + OpenCode) |
| **Feedback loop** | None | None | Dirty bits + domain-level review/test gates |
| **Context mgmt** | None | None | Compaction gates (75/80/85%) |
| **Resume** | None | None | MANIFEST.yaml persists across sessions |
| **Tools** | Amp/Claude | Claude + OpenCode | Claude + OpenCode (universal hooks) |
| **Team** | Solo | Solo + team | Solo + team + parallel worktrees |

---

## Roadmap

### Done
- Two-mode operation: work loop + orchestrate
- 16-phase state machine with intelligent phase skipping
- Five-role assembly line (Lead/Dev/Reviewer/TestLead/Tester)
- Two-tier skill system (Core BIOS + Library JIT + Gateways)
- Universal hook layer (Claude Code hooks + OpenCode plugin)
- Compaction gate (token tracking from session transcripts)
- Feedback loop (dirty bits + multi-domain pass tracking)
- MANIFEST.yaml persistent state + session resume
- Parallel worktree execution + merge workflow

### Next
- Heterogeneous LLM routing per phase (DeepSeek for reasoning, etc.)
- Self-annealing: auto-patch skills/hooks when agent fails repeatedly
- Agent-to-agent negotiation for dynamic API contracts
- Web dashboard: orchestration phase visualization
