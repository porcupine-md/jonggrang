# Jonggrang Workflow — Deep Dive

Jonggrang runs in two distinct modes. The **Work Loop** is the original iterative mode: one agent, one task at a time, stateless iterations. The **Orchestrate Mode** is the new deterministic multi-phase pipeline: five specialist agents, 16 phases, persistent MANIFEST state.

---

## Mode 1: Work Loop

### Iteration Lifecycle

Each iteration is **stateless** — a fresh context window. This prevents accumulated confusion from long-running sessions.

#### Step 1: Load Context

Agent reads these files at start of every iteration:

```
AGENTS.md                        --> Project conventions, gotchas, patterns
.jonggrang/progress.txt          --> Learnings from previous iterations
.jonggrang/jonggrang-tasks.json  --> Current task state
git log --oneline -20            --> Recent changes for context
.jonggrang/jonggrang.json        --> Project config
```

Total context budget: ~30% of window for context, ~70% for work.

#### Step 2: Pick Task

Priority algorithm:
1. Task with `status: "pending"` and the highest `priority` number (1 = highest)
2. If a task has `blocked_by`, skip to the next task
3. If `--task <id>` is specified, override priority
4. If task has `role` field, only match if current agent's inferred role matches

#### Step 3: Plan

Agent generates an implementation plan based on:
- Task description
- Relevant skill (auto-detected via Gateway routing or explicit `skill` field)
- AGENTS.md conventions
- Existing codebase context

#### Step 4: Implement

Claude Code or OpenCode executes the plan:
1. Invoke gateway to resolve the right skill tier (core or library)
2. Read skill instructions
3. Follow step-by-step, creating/modifying files

#### Step 5: Validate

Run hooks from `.jonggrang/jonggrang.json`:
```bash
npm run typecheck
npm run lint
npm run test
```

#### Step 6: Commit

Atomic commit per task:
```
feat(users): add registration endpoint

- Created POST /api/users with email validation
- Added Zod schema for request body
- Added 4 tests

Task: task-001
Skill: scaffold-api
```

#### Step 7: Update State

```
.jonggrang/jonggrang-tasks.json  --> task.status = "completed"
.jonggrang/progress.txt          --> append session learnings
AGENTS.md                        --> propose update if new pattern found (human approval required)
```

#### Step 8: Test Feedback Loop

After the agent finishes and marks the task `completed`, the orchestrator runs `testing.command` from `jonggrang.json` automatically. If tests pass, the task is done. If tests fail, the agent gets another chance — with the test output injected into its prompt.

```
Agent selesai + task marked completed
    │
    ▼
Run testCmd
    │
    ├── pass → task completed ✓ (exit iteration)
    │
    └── fail
         │
         attempt 1 → inject test output into prompt → re-run agent
         attempt 2 → inject test output into prompt → re-run agent
         attempt 3 → show test output to user:
                     "Provide feedback for the agent (or Enter to block): "
                     ├── user types feedback → inject feedback + reset counter → loop again
                     └── Enter (empty)       → task marked blocked
```

**Key details:**

- **Max auto-retries: 3** — the agent gets 3 attempts to fix failing tests without human intervention. Configurable via `TEST_RETRY_LIMIT` constant.
- **Feedback injection** — on each retry, the full test output (capped at 4000 chars, tail-end preserved) is injected into the prompt under a `## Test Failure Feedback` section with the raw output in a code block.
- **Human escalation** — after 3 failures, the test output is displayed and the user is prompted. User feedback is combined with the last test output and injected into the next prompt. The retry counter resets, giving the agent another 3 attempts.
- **Blocked exit** — if the user presses Enter without typing feedback, the task is marked `blocked` and the work loop moves to the next task.
- **No test command** — if `testing.command` is not configured (empty string), the test step is skipped entirely and the task completes immediately after the agent finishes.

The prompt structure on retry looks like:

```markdown
# Jonggrang Work Session

## Test Failure Feedback
The previous implementation attempt failed validation. Fix the issues below before marking the task complete.

\`\`\`
  ✗ add(2, 3) === 5: expected 5, got -1
  ✓ add(0, 0) === 0
  ✗ add(-1, 1) === 0: expected 0, got -2

1 passed, 2 failed
\`\`\`

## Current Task
...
```

When escalated to the user, the feedback includes both sources:

```
User feedback: the bug is in the subtract helper, not the add function itself

Last test output:
  ✗ add(2, 3) === 5: expected 5, got -1
  ...
```

#### Step 9: Loop Decision

```
all tasks completed          --> EXIT: COMPLETE
iteration >= max_iterations  --> EXIT: PAUSED
same task failed 3x          --> EXIT: BLOCKED
else                         --> next iteration (fresh context)
```

### Work Loop Variants

```bash
jonggrang work                          # all pending tasks
jonggrang work --skill prd              # one-shot skill execution
jonggrang work --task task-003          # specific task
jonggrang work --branch feat/auth       # branch-scoped
jonggrang work --dry-run                # preview prompt only
jonggrang work --tool claude            # override AI tool
jonggrang work --mode supervised        # override autonomy
```

---

## Mode 2: Orchestrate — 16-Phase Pipeline

### Overview

```
jonggrang orchestrate "add payment flow"
jonggrang orchestrate --resume          # resume from saved MANIFEST
```

The orchestrate command runs a deterministic 16-phase pipeline. Each phase is executed by a specific specialist agent. State is persisted in `MANIFEST.yaml` so the pipeline can survive session resets.

### Phase Table

| # | Phase | Role | Description | Skipped For |
|---|-------|------|-------------|-------------|
| 1 | Setup | Lead | Read context files, load AGENTS.md | — |
| 2 | Triage | Lead | Classify complexity, plan active phases | — |
| 3 | Discovery | Lead | Explore codebase, identify affected areas | — |
| 4 | SkillMap | Lead | Map tasks → skills via gateway | — |
| 5 | Complexity | Lead | Deep complexity analysis, risk assessment | BUGFIX, SMALL |
| 6 | Brainstorm | Lead | Generate alternative approaches **(human pause)** | BUGFIX, SMALL |
| 7 | Architect | Lead | Output architecture_plan_json → ARCHITECTURE_PLAN_COMPLETE | BUGFIX, SMALL |
| 8 | Implement | Developer | Execute plan, typecheck+lint+test → IMPLEMENTATION_COMPLETE | — |
| 9 | DesignVerify | Reviewer | Verify design matches architecture plan | BUGFIX, SMALL |
| 10 | Compliance | Reviewer | AGENTS.md compliance, security patterns | — |
| 11 | Quality | Reviewer | Code quality, test coverage gaps → REVIEW_COMPLETE | — |
| 12 | TestPlan | TestLead | Output test_plan_json → TEST_PLAN_COMPLETE | BUGFIX |
| 13 | Test | Tester | Execute test plan, run all tests | — |
| 14 | Coverage | Tester | Enforce coverage thresholds | — |
| 15 | TestQuality | Reviewer | Test quality review → REVIEW_COMPLETE | — |
| 16 | Complete | Lead | Final summary, update `.jonggrang/progress.txt`, MANIFEST → done | — |

### Phase Skipping by Work Type

```
BUGFIX  → skip phases [5, 6, 7, 9, 12]    (fast track, no architecture)
SMALL   → skip phases [5, 6, 7, 9]         (skip architecture, keep test plan)
MEDIUM  → run all 16 phases
LARGE   → run all 16 phases
```

Work type is auto-classified by the Lead agent in phase 2 based on the description and discovered scope.

### MANIFEST.yaml — Persistent State

Located at `.jonggrang/.output/features/{id}/MANIFEST.yaml`, it survives session resets:

```yaml
feature_id: feat-20260411-abc123
description: "add payment flow"
work_type: MEDIUM
status: in_progress
current_phase: 8
active_phases: [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
phases:
  "1": { status: completed, completed_at: "2026-04-11T10:00:00Z", agent_output: "..." }
  "2": { status: completed, completed_at: "2026-04-11T10:01:00Z", agent_output: "..." }
  "8": { status: in_progress, started_at: "2026-04-11T10:05:00Z" }
agents:
  lead: { model: claude-sonnet-4-5, started_at: "..." }
  developer: { model: claude-sonnet-4-5 }
validation:
  typecheck: false
  lint: false
  tests: false
context_usage:
  current_tokens: 45000
  percentage: 0.23
```

To resume after a session reset:

```bash
jonggrang orchestrate --resume
# Finds the latest in_progress MANIFEST and resumes from current_phase
```

---

## Five-Role Assembly Line

Each phase is handled by exactly one specialist agent. Agents are stateless — they receive a crafted prompt, do their work, and signal completion.

```
Phase 1-7, 16 → Lead
Phase 8       → Developer
Phase 9-11,15 → Reviewer
Phase 12      → TestLead
Phase 13-14   → Tester
```

### Role Boundaries

| Role | Has Task Tool | Has Edit/Write | Completion Signal |
|------|:---:|:---:|-------------------|
| Lead | YES | no | ARCHITECTURE_PLAN_COMPLETE |
| Developer | no | YES | IMPLEMENTATION_COMPLETE |
| Reviewer | no | no (read-only) | REVIEW_COMPLETE |
| TestLead | YES | no | TEST_PLAN_COMPLETE |
| Tester | no | YES | ALL_TESTS_PASSING |

**Coordinator roles** (Lead, TestLead) can spawn sub-agents via the Task tool, but cannot directly edit files. They plan and delegate.

**Executor roles** (Developer, Tester) have full Edit/Write/Bash access, but cannot spawn sub-agents. They implement.

**Reviewer** is read-only — no edit tools at all. This prevents the reviewer from "just fixing it" instead of raising issues.

### Completion Signal Protocol

Each role must emit its completion signal as the final output line. The orchestration engine waits for this signal before advancing the phase:

```
# Developer finishes phase 8:
IMPLEMENTATION_COMPLETE

# Tester finishes phase 13-14:
ALL_TESTS_PASSING
```

If the signal is not emitted, the phase is marked as `failed` and the orchestration loop retries (up to 2x by default).

---

## The Hook System — Eight-Layer Defense

Both Claude Code and OpenCode share the same enforcement logic. The implementation differs by platform but the behavior is identical.

### Enforcement Layers

| Layer | Mechanism | Enforces |
|-------|-----------|----------|
| 1 | CLAUDE.md / AGENTS.md | Project conventions, role instructions |
| 2 | Core Skills | Gateway routing, orchestration patterns |
| 3 | Agent Templates | Role boundaries, completion signals |
| 4 | UserPromptSubmit | Pre-validates prompt before agent starts |
| 5 | PreToolUse | agent-first delegation, compaction gate |
| 6 | PostToolUse | dirty bit tracking per domain |
| 7 | SubagentStop | Output location enforcement |
| 8 | Stop | Feedback loop gate, quality gate |

### Per-Platform Hook Mapping

| Universal Event | Claude Code | OpenCode |
|----------------|-------------|----------|
| Before file edit | PreToolUse (Edit\|Write) | tool.execute.before |
| After file edit | PostToolUse (Edit\|Write) | tool.execute.after + file.edited |
| Before spawning sub-agent | PreToolUse (Task) | tool.execute.before (Task) |
| Sub-agent finished | SubagentStop | session.updated (completed) |
| Session ending | Stop | session.idle |
| Context compacted | — | session.compacted |

Hooks are installed via:

```bash
jonggrang init        # installs hooks during project init
```

This writes:
- `.claude/settings.json` — Claude Code hook registrations pointing to `hooks/claude/*.sh`
- `.opencode/plugins/jonggrang.js` — OpenCode plugin with identical enforcement

---

## Compaction Gate

The compaction gate prevents agents from exhausting context mid-phase. It is checked **before heavy phases** (3: Discovery, 8: Implement, 13: Test).

### Thresholds

| Level | Token % | Action |
|-------|---------|--------|
| WARN | 75% | Log warning, continue |
| MUST | 80% | Log strong warning, continue |
| BLOCK | 85% | Halt with exit code 2, tell agent to compact |

Token usage is read from Claude JSONL session transcripts:
```
~/.claude/projects/<hashed-path>/<session>.jsonl
```

The hash replicates Claude Code's naming scheme: project path with `/` replaced by `-`.

```bash
# Example: /home/user/my-project → -home-user-my-project
```

Usage is summed across:
- `cache_read_input_tokens`
- `cache_creation_input_tokens`
- `input_tokens`

---

## Feedback Loop — Dirty Bits

The feedback loop tracks which code domains have been modified and whether those modifications have been reviewed and tested.

### Domain Detection

File paths are mapped to domains by pattern:
```
src/routes/**, src/controllers/** → backend
src/components/**, src/pages/**   → frontend
src/api/**, src/services/**       → api
src/db/**, migrations/**          → database
tests/**, *.test.*, *.spec.*      → testing
```

### State Machine

```
1. Developer edits src/routes/users.ts
   → feedback.setDirtyBit("backend") → backend: PENDING

2. Reviewer reviews and passes
   → feedback.recordPhaseResult("reviewer", "backend", "pass") → backend: REVIEWER_PASSED

3. Tester runs tests and passes
   → feedback.recordPhaseResult("tester", "backend", "pass") → backend: COMPLETE

4. Exit gate: ALL domains COMPLETE?
   → YES: allow session exit
   → NO: block with message showing pending domains
```

If reviewer OR tester FAILS any domain, **all domains reset to PENDING**. The loop must run again.

### Loop Detection

Jaccard similarity is tracked across output hashes. If the same output appears >90% similar to a previous attempt, the stuck counter increments. After 3 stuck iterations, the **Escalation Advisor** injects a diagnostic hint:

```
[JONGGRANG ESCALATION] Stuck after 3 attempts. Try:
1. Check if test environment is properly configured
2. Verify that fixture data matches expected schema
3. Consider breaking this task into smaller subtasks
```

---

## Init Wizard

### Stack Auto-detection

| File Detected | Stack |
|--------------|-------|
| `package.json` + `next.config.*` | Next.js |
| `package.json` + `express` dep | Express |
| `go.mod` | Go |
| `requirements.txt` / `pyproject.toml` | Python |
| `Cargo.toml` | Rust |
| `tsconfig.json` (no framework) | TypeScript Library |

| File | Test Framework |
|------|---------------|
| `vitest.config.*` | Vitest |
| `jest.config.*` | Jest |
| `*_test.go` | Go Test |
| `pytest.ini` / `conftest.py` | Pytest |

### What `jonggrang init` Creates

```
AGENTS.md                    → project conventions
skills/core/                 → core skills (always loaded)
skills/library/              → library skills (JIT loaded)
.claude/settings.json        → Claude Code hooks
.opencode/plugins/           → OpenCode plugin
.jonggrang/                  → runtime state + config dir
  jonggrang.json             → project config
  jonggrang-tasks.json       → task board state
  progress.txt               → append-only learning log
  .output/                   → feature manifests + agent outputs
  .ephemeral/                → feedback/compaction state (cleared on restart)
```

---

## Review — Deep Dive

### Review Types

| Command | Scope |
|---------|-------|
| `jonggrang review` | Full scan of all changes since last review |
| `jonggrang review --task <id>` | Focused review on single task |
| `jonggrang review --security` | OWASP Top 10, hardcoded secrets, auth gaps |
| `jonggrang review --performance` | N+1 queries, re-renders, memory leaks |

In orchestrate mode, review is handled by the **Reviewer role** at phases 9, 10, 11, and 15 — no separate CLI call needed.

### Review Output Format

```markdown
# Jonggrang Review — 2026-04-11T15:30:00Z

## Summary
- Phases reviewed: 9, 10, 11
- Issues found: 2 (1 high, 1 low)

## Issues

### [HIGH] SQL injection risk in src/routes/search.ts:23
Raw user input passed to query without parameterization.
Fix: Use parameterized query.

### [LOW] Missing error handling in src/services/email.ts:45
SMTP send has no try-catch.
Fix: Add try-catch with retry logic.

## Verdict
REVIEW_COMPLETE
```
