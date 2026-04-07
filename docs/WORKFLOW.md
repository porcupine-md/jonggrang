# Jonggrang Workflow — Detailed Phase Documentation

---

## Phase 1: Init Wizard — Deep Dive

### Wizard Flow

```
START
  |
  v
[Project Name] --> string input
  |
  v
[Project Type] --> web-app | api | library
  |
  v
[Work Mode] --> solo | team
  |                |
  | (solo)         | (team)
  v                v
  |           [Team Size] --> 2-5
  |                |
  v <--------------+
  |
[Project State] --> new | existing
  |                      |
  | (new)                | (existing)
  v                      v
[Select Template]   [Auto-detect Stack]
  |                      |
  v <--------------------+
  |
[Autonomy Mode] --> supervised | balanced | autonomous
  |
  v
[CI/CD Setup] --> github-actions | gitlab-ci | none | custom
  |
  v
[Testing Setup] --> auto-detect | manual select | skip
  |
  v
[GENERATE]
  ├── jonggrang.json
  ├── AGENTS.md (template)
  ├── skills/ (filtered by project type)
  ├── jonggrang-tasks.json (empty)
  ├── progress.txt (empty)
  └── [template files if new project]
  |
  v
DONE --> "Run `jonggrang work` to start"
```

### Stack Auto-detection (Existing Projects)

Jonggrang automatically detects the stack based on file markers:

| File Detected | Stack Identified |
|--------------|-----------------|
| `package.json` + `next.config.*` | Next.js |
| `package.json` + `express` in deps | Express |
| `go.mod` | Go |
| `requirements.txt` / `pyproject.toml` | Python |
| `Cargo.toml` | Rust |
| `tsconfig.json` + no framework | TypeScript Library |

| File Detected | Test Framework |
|--------------|---------------|
| `vitest.config.*` | Vitest |
| `jest.config.*` | Jest |
| `*_test.go` | Go Test |
| `pytest.ini` / `conftest.py` | Pytest |

| File Detected | CI/CD |
|--------------|-------|
| `.github/workflows/` | GitHub Actions |
| `.gitlab-ci.yml` | GitLab CI |
| `Jenkinsfile` | Jenkins |

---

## Phase 2: Work Loop — Deep Dive

### Iteration Lifecycle

Each iteration is **stateless** — a fresh context window. This prevents accumulated confusion that occurs in long-running sessions.

#### Step 1: Load Context

Agent reads these files at start of every iteration:

```
AGENTS.md          --> Project conventions, gotchas, patterns
progress.txt       --> Learnings from previous iterations
jonggrang-tasks.json   --> Current task state
git log --oneline -20  --> Recent changes for context
jonggrang.json         --> Project config
```

Total context budget: ~30% of window for context, ~70% for work.

#### Step 2: Pick Task

Priority algorithm:
1. Task with `status: "pending"` and the highest `priority` number (1 = highest)
2. If a task has `blocked_by`, skip to the next task
3. If `--task <id>` is specified, override priority

#### Step 3: Plan

Agent generates an implementation plan based on:
- Task description
- Relevant skill template (auto-detected or specified)
- AGENTS.md conventions
- Existing codebase context

Plan format:
```
Task: [task title]
Skill: [matched skill or "custom"]
Files to create/modify:
  - path/to/file1.ts (create)
  - path/to/file2.ts (modify)
Approach:
  1. Step description
  2. Step description
  3. Step description
Tests:
  - Test case 1
  - Test case 2
Risk assessment: low|medium|high
Estimated scope: small|medium|large
```

#### Step 4: Implement

Claude Code executes the plan:
1. Read relevant skill template
2. Follow skill instructions with interpolated variables
3. Execute inline scripts if any
4. Create/modify files as planned

#### Step 5: Validate

Run hooks from `jonggrang.json`:
```bash
# post_implement hooks
npm run typecheck    # or: tsc --noEmit
npm run lint         # or: eslint .

# pre_commit hooks
npm run test         # or: vitest run
```

Validation outcomes:
- **PASS** --> proceed to commit
- **FAIL** -->
  - supervised: immediate pause, show error to human
  - balanced: show error, ask fix/skip/abort
  - autonomous: auto-retry (max 2x), then skip

#### Step 6: Commit

Atomic commit per task:
```
feat(users): add registration endpoint

- Created POST /api/users with email validation
- Added Zod schema for request body
- Added 4 tests (happy path + validation errors)

Task: task-001
Skill: scaffold-api
```

#### Step 7: Update State

```javascript
// jonggrang-tasks.json
task.status = "completed"
task.passes = true
task.completed_at = now()

// progress.txt (append)
`## Session ${timestamp} — Task: ${task.title}
### What was done
...
### What was learned
...
### Patterns discovered
...`

// AGENTS.md (propose update if new pattern found)
// Only human can approve AGENTS.md changes
```

#### Step 8: Loop Decision

```
if (all tasks completed) --> EXIT: COMPLETE
if (iteration >= max_iterations) --> EXIT: PAUSED
if (same task failed 3x) --> EXIT: BLOCKED
else --> next iteration (fresh context)
```

---

### Work Loop Variants

#### Standard: Task-based Loop
```bash
$ jonggrang work
# Picks tasks from jonggrang-tasks.json sequentially
```

#### Skill-only: One-shot Execution
```bash
$ jonggrang work --skill prd
# Runs single skill, no task loop
```

#### Targeted: Specific Task
```bash
$ jonggrang work --task task-003
# Only works on specified task
```

#### Branch-scoped
```bash
$ jonggrang work --branch feat/auth
# Creates/switches to branch, scopes all work to it
```

---

## Phase 3: Review — Deep Dive

### Review Types

#### Full Review (`jonggrang review --full`)
Comprehensive scan of all changes since last review:
- Diff analysis (all commits since last `jonggrang review`)
- Code quality patterns
- Test coverage delta
- Dependency audit
- AGENTS.md compliance

#### Task Review (`jonggrang review --task <id>`)
Focused review on single task's changes.

#### Security Review (`jonggrang review --security`)
- Dependency vulnerability scan
- Hardcoded secrets detection
- SQL injection / XSS patterns
- Auth/authorization gaps
- OWASP Top 10 checklist

#### Performance Review (`jonggrang review --performance`)
- N+1 query detection
- Unnecessary re-renders (React)
- Memory leak patterns
- Bundle size impact
- Database index suggestions

### Review Output

Reports saved to `jonggrang-log/review-{timestamp}.md`:

```markdown
# Jonggrang Review — 2026-04-02T15:30:00Z

## Summary
- Tasks reviewed: 5
- Commits scanned: 8
- Issues found: 3 (1 high, 2 low)

## Issues

### [HIGH] Potential SQL injection in src/routes/search.ts:23
Raw user input passed to query without parameterization.
Recommendation: Use parameterized query or ORM method.

### [LOW] Missing error handling in src/services/email.ts:45
SMTP send has no try-catch. Could crash on network failure.
Recommendation: Add try-catch with retry logic.

### [LOW] Test coverage gap: src/utils/crypto.ts
No tests for edge cases (empty input, unicode).
Recommendation: Add boundary tests.

## Metrics
- Test coverage: 84% (+6% from last review)
- New dependencies: 1 (zod@3.22)
- Bundle size delta: +2.3KB
```

---

## Team Workflow — Deep Dive

### Daily Flow (Team of 3-5)

```
Morning:
  Lead:   $ jonggrang plan "implement payment flow"
          # Decomposes into 5 atomic tasks
          $ jonggrang assign task-001 andi
          $ jonggrang assign task-002 budi
          # task-003..005 unassigned (self-claim)

  Andi:   $ jonggrang work --task task-001 --mode balanced
  Budi:   $ jonggrang work --task task-002 --mode balanced
  Citra:  $ jonggrang work --pick --mode balanced
          # Auto-claims task-003

Mid-day:
  All:    $ jonggrang status
          # View task board, check progress

  Deni:   $ jonggrang work --pick
          # Claims task-004

  Lead:   $ jonggrang sync
          # Review completed tasks, merge if clean

End-of-day:
  Lead:   $ jonggrang review --full
          # Comprehensive review of all day's work
          # Update AGENTS.md with new patterns
```

### Conflict Resolution

```
Scenario: Andi and Budi both need to modify src/routes/index.ts

Option 1 (preferred): Serialize tasks
  task-002.blocked_by = ["task-001"]
  Budi waits until Andi's task completes

Option 2: Split file
  Andi: src/routes/users.ts (new file)
  Budi: src/routes/payments.ts (new file)
  Both: separately register in index.ts (different lines)

Option 3: Lead resolves
  Lead manually merges changes after both complete
```

### Branch Strategy (Team)

```
main
  └── feat/payment-flow          (feature branch)
       ├── task-001/user-auth    (task branch, Andi)
       ├── task-002/payment-api  (task branch, Budi)
       └── task-003/payment-ui   (task branch, Citra)
```

Each task branch merges back to feature branch. Feature branch merges to main via PR (with `jonggrang review`).
