# Philosophy & Architecture

> Why Jonggrang exists, how it's built, and what happens under the hood.

---

## Philosophy

AI agents write code fast. Too fast. The bottleneck is no longer *writing* — it's *knowing when to stop, reflect, and clean up*.

Jonggrang is built around one belief: **a codebase shaped by a disciplined process is cleaner than one shaped by raw speed.** Every feature passes through the same pipeline — not because every step is always necessary, but because skipping steps is how complexity accumulates silently.

An AI agent without structure produces a codebase that looks finished but is made of layers. Each feature adds another layer — slightly different naming conventions, subtly duplicated logic, tests that assert the wrong thing. It works until it doesn't.

The pipeline is the answer to that. It is not bureaucracy — it is the minimum structure required to keep the output coherent over time.

Jonggrang is opinionated because it has to be. The agent will always take the shortest path. The framework's job is to make sure the shortest path is also the right one.

---

## The Pipeline Is the Quality Gate

```
                ┌─────────────────────────────────────┐
                │              Hooks                  │
                │  (active throughout — guards every  │
                │   tool call, file edit, and exit)   │
                └──────┬──────────────────────────────┘
                       │ enforces invariants in real-time
                       ▼
Plan  →  Implement ⟲  →  Simplify  →  Test  →  Review
               ▲____|
          (loops until
          quality gates
             pass)
```

Each stage has a specific job:

### Plan
The agent reads your intent and produces a structured task list. You review it before a single line of code is written. Humans stay in the loop at the point where it costs the least to change course.

### Implement
Each task runs in a *fresh context*. No accumulated confusion, no prompt memory carrying forward wrong assumptions. The agent starts clean every time. **Hooks run here** — blocking secret exposure, enforcing delegation, preventing context overload, and refusing to let the agent exit until the loop conditions are met.

### Simplify
After implementation, before the PR is opened, the agent revisits every changed file with a single mandate: *reduce complexity without changing behavior*. Rename the unclear variable. Collapse the redundant function. Remove the comment that just restates the code. This phase exists because the first pass is never the last word.

To keep this phase from overflowing a small context window, the agent is fed the **diff** of the changed files (not asked to read every file in full) and only opens a whole file when it needs more surrounding context. The orchestrator measures the total diff *before spawning*: if it stays under `SIMPLIFY_DIFF_BUDGET` (a token threshold), one agent handles all files; if it exceeds the budget, the phase splits into **one fresh agent per file**, so each session's load is bounded by a single file rather than the sum of the change. The split is decided deterministically in code — never left to the model to notice mid-run, by which point it would already have compacted.

### Test
The agent writes the tests, runs them, and verifies coverage. Tests are not an afterthought appended at the end; they are part of the definition of done for every task.

### Review
A dedicated review pass reads the implementation as a future maintainer would. It asks: is this correct? is this maintainable? does it match the plan? For frontend work the reviewer does not stop at the source — it drives the *rendered* UI in a real headless browser via the `agent-browser` CLI (preinstalled in the sandbox), checking layout, responsiveness, theming, and accessibility that code inspection and unit tests cannot see.

### Compact Mode (the deliberate exception)
Sometimes the loop *is* the point — you are iterating fast and the gates are a later, separate pass. Compact mode (`jonggrang work --compact`, or `orchestration.pipeline_mode: "compact"`) runs Plan → Implement and stops.

Two properties keep it honest rather than a way to opt out of quality:

- **Memory is still written.** Skipping the gates must not cost the project what it learned. Memory compact runs at the end of the work loop, before any gate; compact mode then runs promote explicitly, because that normally happens in the review phase. A fast run still teaches the next one.
- **The deferral is recorded, not forgotten.** Deferred phases are marked `skipped` with the reason `compact-mode` in the MANIFEST, and `work --resume` reopens exactly those. The dashboard shows the count and offers **Run quality gates**. The pipeline never quietly *looks* finished when it isn't.

What compact mode does not do is pretend the gates ran. That distinction — deferring visibly versus skipping silently — is the whole reason it is safe to have.

### Hooks (Continuous Enforcement)
Not a final stage, but a continuous enforcement layer woven into the implement loop. Every tool call, every file edit, every agent exit passes through hooks first. They police what the agent cannot be trusted to police itself: no secrets leaking into context, no orchestrator making direct edits it should delegate, no agent spawning when the context window is near-full, no exit until review and tests are green.

---

## How It Works

### Work Loop

```
You describe what you want
        |
        v
  jonggrang plan  -->  Phase 1: AI writes .jonggrang/.drafts/<session>/plan.md (high-level, human-editable)
        |              UI work also audits local design evidence and drafts guide/handoff context
        |              Review / edit the plan in your editor
        v
  jonggrang approve  -->  Phase 2: AI reads plan.md → decomposes into tasks
        |                 UI tasks receive bounded ui_context + feature UI_HANDOFF.md
        |                 plan.md archived, per-feature jonggrang-tasks.json written
        v
  jonggrang work  -->  For each task:
        |            1. Fresh context (no accumulated confusion)
        |            2. Read AGENTS.md + .jonggrang/.output/features/{id}/progress.txt (project knowledge)
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
│  Codex hooks · Jonggrang extension           │
│  (.claude / .opencode / .codex / .jonggrang)│
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

| Layer | Event | Claude Code | OpenCode | Codex | Jonggrang (Pi) | Enforcement |
|-------|-------|-------------|----------|-------|----------------|-------------|
| 5 | Pre-tool | `PreToolUse` | `tool.execute.before` | `PreToolUse` | `tool_call` | Block direct edits (agent-first) |
| 5 | Pre-tool | `PreToolUse` | `tool.execute.before` | — (no Task event) | `tool_call` | Block agent spawn if context > 85% |
| 5 | Pre-tool | `PreToolUse` | `tool.execute.before` | `PreToolUse` | `tool_call` | Block `git commit` if agent trailer present but structured fields missing ([COMMIT-CONVENTION.md](COMMIT-CONVENTION.md)) |
| 6 | Post-tool | `PostToolUse` | `tool.execute.after` | `PostToolUse` | `tool_result` | Set dirty bit when files modified |
| 6 | File edit | `PostToolUse` | `file.edited` | `PostToolUse` | `tool_result` | Track domain (backend/frontend/testing) |
| 7 | Sub-stop | `SubagentStop` | `session.updated` | `SubagentStop` | `agent_end` | Block exit if output in wrong location |
| 8 | Stop | `Stop` | `session.idle` | `Stop` | `agent_end` | Block exit until review + tests pass |
| 8 | Stop | `Stop` | `session.idle` | `Stop` | `agent_end` | Final quality gate (defense in depth) |

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
│   ├── compaction-state.json       ← Token usage cache
│   └── orchestration-run.json      ← Parallel-run snapshot (per-plan groups)
└── locks/
    └── {agent}.lock                ← File ownership during parallel runs
```

> **`.output/` is tracked, `.ephemeral/`/`locks/` are gitignored.** Plans and manifests under `.output/` are committed so they travel with each plan's branch when the user pushes it from the web **Work Mode → Changes** view. See [JONGGRANG.md → Parallel Orchestration](JONGGRANG.md).
>
> **Worktrees live outside the repo** at `~/.jonggrang/worktree/{project_id}/{feature_id}/` (kept off the project so it stays clean; persistent across container rebuilds). Sandbox projects bind-mount the per-project dir into the container at `/root/.worktrees`.

---

## Autonomy Modes

| Mode | Behavior | Best for |
|------|----------|----------|
| **supervised** | Pauses at brainstorming (Phase 6) for human design input | Critical systems |
| **balanced** | Auto-runs, pauses on failures or ambiguity | Daily development |
| **autonomous** | Full loop — plans, implements, commits. Human reviews at the end | Well-defined tasks |

---

## Project Files Structure

After `jonggrang init`, your project will have:

```
your-project/
├── AGENTS.md                # Project knowledge (edit this!)
├── skills/
│   ├── core/                # Tier 1 — always loaded
│   └── library/             # Tier 2 — JIT via gateway
├── .jonggrang/
│   ├── jonggrang.json       # Project config
│   ├── UI.md                # Canonical project UI guide (tracked; optional)
│   ├── .drafts/<session>/     # Draft plans (gitignored, per-session — concurrent-safe)
│   │   ├── plan.md            # Pending plan (exists between plan → approve)
│   │   ├── UI.md              # Proposed guide update (UI plans only)
│   │   └── UI_HANDOFF.md      # Feature direction draft (UI plans only)
│   ├── .output/
│   │   └── features/<id>/
│   │       ├── plan.md              # Archived plan (after approve)
│   │       ├── MANIFEST.yaml        # Phase state
│   │       ├── jonggrang-tasks.json # Task board state (per-feature)
│   │       ├── UI_HANDOFF.md        # Approved UI task contracts (optional)
│   │       └── progress.txt         # Auto-generated learnings (per-feature)
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

### .jonggrang/UI.md and feature UI_HANDOFF.md

UI context follows the same thin-agent principle as the rest of Jonggrang. The
project guide stores durable product rules and source paths. The feature handoff
freezes approved intent and state behavior. Each task receives only selected
handoff sections and may read named guide sections or source files on demand.
This prevents both context overload and local design drift. When sources
conflict, agents report `UI_GUIDE_DRIFT` instead of inventing a new rule. See
[UI_CONTEXT.md](UI_CONTEXT.md).

### .jonggrang/.output/features/{id}/progress.txt

Append-only log written by the agent after each task. Captures learnings and prevents repeating mistakes across sessions. Per-feature — each feature has its own progress log alongside its `plan.md` and `MANIFEST.yaml`.
