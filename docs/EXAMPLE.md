# Jonggrang Examples

Two complete walkthroughs: the **Work Loop** (iterative, task-based) and **Orchestrate Mode** (deterministic 16-phase pipeline).

---

## Example 1: Todo API — Work Loop

Build a Todo REST API from scratch using the task-based work loop.

### Prerequisites

```bash
jonggrang version    # verify jonggrang is installed
opencode -v          # or: claude --version
```

### Step 1: Create Project Directory

```bash
mkdir /tmp/jonggrang-example-todo
cd /tmp/jonggrang-example-todo
```

### Step 2: Init Jonggrang

With OpenCode (default):

```bash
jonggrang init \
  --name todo-api \
  --type api \
  --stack express-typescript \
  --autonomy autonomous \
  --testing vitest \
  --ci none \
  --state new \
  --force
```

With Claude Code:

```bash
jonggrang init \
  --name todo-api \
  --type api \
  --stack express-typescript \
  --tool claude \
  --autonomy autonomous \
  --testing vitest \
  --ci none \
  --state new \
  --force
```

Expected output:

```
[jonggrang] Generated .jonggrang/jonggrang.json
[jonggrang] Generated AGENTS.md
[jonggrang] Task & progress state: per-feature (created on demand at `jonggrang approve`)
[jonggrang] Copied skills (core + library)
[jonggrang] Installed Claude Code hooks → .claude/settings.json
[jonggrang] Installed OpenCode plugin  → .opencode/plugins/jonggrang.js
[jonggrang] Created .jonggrang/ runtime dirs
[jonggrang] Initialized git repository
[jonggrang] Project ready!
```

### Step 3: Plan Feature

Planning is a two-phase process. Phase 1 generates a human-readable draft that you review before tasks are created.

**Option A — interactive (recommended):**

```bash
jonggrang plan "Todo REST API with Express. CRUD endpoints for todos (list, get, create, update, delete) using in-memory storage. TypeScript, Vitest tests, supertest for integration testing."
# AI writes .jonggrang/.drafts/<session>/plan.md
# Interactive prompt:
#   ◆ What would you like to do?
#   ● Approve — decompose into tasks now
#   ○ Edit in $EDITOR first
#   ○ Save draft and exit
#   ○ Abort
```

Once approved (or after editing), run Phase 2:

```bash
jonggrang approve
# Reads the most-recent draft plan.md → writes jonggrang-tasks.json
# Use: jonggrang approve --session <id> when multiple drafts are pending
# Archives plan.md to .jonggrang/.output/features/<id>/plan.md
```

**Option B — one-shot (skip review):**

```bash
jonggrang plan "Todo REST API ..." --yes   # plan + approve in one shot
```

**Option C — full pipeline:**

```bash
jonggrang work "Todo REST API ..." --yes   # plan → approve → execute
```

**Option D — plan from a BRD/PRD document:**

```bash
jonggrang plan "Todo REST API ..." --src docs/brd.md   # reference source document for the agent to read
```

**Option E — extend an approved plan (append):**

```bash
jonggrang plan --append feat-abc123 "also add input validation to the todo endpoints" --yes
# generates an extension draft, approves it into the existing feature (task-006, task-007, ...),
# and re-opens the execution phases so `jonggrang work` runs the new tasks.
```

**UI feature — guide and handoff:**

```bash
jonggrang plan "operations dashboard for triaging failed todo jobs"
# audits local tokens/components/screens first
# when no project UI system exists, recommends dashboard-operational@1
# draft session also contains UI.md + UI_HANDOFF.md for review

jonggrang approve
# writes tracked .jonggrang/UI.md
# writes .jonggrang/.output/features/<id>/UI_HANDOFF.md
# adds bounded ui_context only to UI tasks
```

A brand-new UI request cannot silently accept a starter pack. Run the interactive
plan once to provide a preference/reference, accept the recommended pack, or
decline starters. For automation, explicitly name the approved baseline id in
the request. See [UI_CONTEXT.md](UI_CONTEXT.md).

### Step 4: Check Task Board

```bash
jonggrang status
```

```
  JONGGRANG Task Board

Project: todo-api
Tasks: 0/3 completed

ID          Status       Owner      Title
--------------------------------------------------------------
task-001    pending      -          Initialize Express TypeScript project with Vitest
task-002    pending      -          Add Todo CRUD endpoints with in-memory storage
task-003    pending      -          Add integration tests for Todo endpoints
```

### Step 5: Run Work Loop

```bash
jonggrang work --max-iterations 3
```

Or one at a time:

```bash
jonggrang work --max-iterations 1   # task-001: init project
jonggrang work --max-iterations 1   # task-002: CRUD endpoints
jonggrang work --max-iterations 1   # task-003: integration tests
```

Dry run — preview the prompt without executing:

```bash
jonggrang work --dry-run --max-iterations 1
```

Override tool at runtime:

```bash
jonggrang work --tool claude --max-iterations 1
jonggrang work --tool opencode --max-iterations 1
```

### Step 6: Verify Results

```bash
jonggrang status
```

```
Project: todo-api
Tasks: 3/3 completed

ID          Status       Owner      Title
--------------------------------------------------------------
task-001    completed    -          Initialize Express TypeScript project with Vitest
task-002    completed    -          Add Todo CRUD endpoints with in-memory storage
task-003    completed    -          Add integration tests for Todo endpoints
```

```bash
git log --oneline
```

```
c976de1 test(todos): add integration coverage
de00afd feat(todos): add in-memory CRUD endpoints
10527b6 feat(app): enable express typescript baseline
d1903a0 chore: initial jonggrang setup with todo-api tasks
```

```bash
npx vitest run
```

```
 ✓ tests/health.test.ts  (1 test)
 ✓ tests/todos.test.ts   (8 tests)

 Test Files  2 passed (2)
      Tests  9 passed (9)
```

### Generated File Tree

```
.
├── AGENTS.md
├── package.json
├── src/
│   ├── app.ts
│   ├── index.ts
│   ├── routes/todos.ts
│   └── types/todo.ts
├── tests/
│   ├── health.test.ts
│   └── todos.test.ts
├── tsconfig.json
└── .jonggrang/
    ├── jonggrang.json
    ├── jonggrang-tasks.json
    └── progress.txt
```

---

## Example 2: Payment Flow — Orchestrate Mode

Add a payment flow to an existing API using the full 16-phase deterministic pipeline.

### Prerequisites

```bash
cd /path/to/existing-project
jonggrang version
```

The project must already have `.jonggrang/jonggrang.json`. If not, run `jonggrang init` first.

### Step 1: Run Orchestrate

```bash
jonggrang orchestrate "add Stripe payment flow: checkout session creation, webhook handler for payment.succeeded, and order status update"
```

Jonggrang will:
1. Auto-classify work type (MEDIUM or LARGE for a payment flow)
2. Generate a feature ID and create `MANIFEST.yaml`
3. Run the 16-phase pipeline with the five-role assembly

Expected output (first few phases):

```
[jonggrang] Feature ID: feat-20260411-d4e5f6
[jonggrang] Work type: MEDIUM (running all 16 phases)
[jonggrang] MANIFEST: .jonggrang/.output/features/feat-20260411-d4e5f6/MANIFEST.yaml

[jonggrang] Phase 1/16: Setup (Lead)
  ✓ Read AGENTS.md, .jonggrang/.output/features/<id>/progress.txt, git log
  ✓ Context loaded

[jonggrang] Phase 2/16: Triage (Lead)
  ✓ Classified: MEDIUM
  ✓ Active phases: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]

[jonggrang] Phase 3/16: Discovery (Lead)  [HEAVY — checking compaction]
  ✓ Context at 12% — safe to proceed
  ✓ Identified affected areas: src/routes/payments.ts, src/services/stripe.ts, src/webhooks/

[jonggrang] Phase 6/16: Brainstorm (Lead)  [PAUSED — human input requested]
  Lead has generated 3 alternative approaches.
  Review and press Enter to continue with the chosen approach...
```

At phase 6, jonggrang pauses (in `supervised` or `balanced` autonomy) to show the Lead's brainstorm output and wait for your confirmation.

To skip this pause:

```bash
jonggrang orchestrate "..." --autonomy autonomous
# or set in .jonggrang/jonggrang.json: orchestration.pause_for_brainstorm = false
```

Continuing:

```
[jonggrang] Phase 7/16: Architect (Lead)
  ✓ ARCHITECTURE_PLAN_COMPLETE

[jonggrang] Phase 8/16: Implement (Developer)  [HEAVY — checking compaction]
  ✓ Context at 34% — safe to proceed
  ✓ Gateway resolved: backend → developing-with-tdd, error-handling-patterns
  ✓ Created src/routes/payments.ts
  ✓ Created src/services/stripe.ts
  ✓ Created src/webhooks/payment.ts
  ✓ typecheck: PASS
  ✓ lint: PASS
  ✓ tests: PASS
  ✓ IMPLEMENTATION_COMPLETE

[jonggrang] Phase 9/16: DesignVerify (Reviewer)
  ✓ REVIEW_COMPLETE

[jonggrang] Phase 10/16: Compliance (Reviewer)
  ✓ REVIEW_COMPLETE

[jonggrang] Phase 11/16: Quality (Reviewer)
  ✓ REVIEW_COMPLETE

[jonggrang] Phase 12/16: TestPlan (TestLead)
  ✓ TEST_PLAN_COMPLETE (12 test cases across 3 groups)

[jonggrang] Phase 13/16: Test (Tester)  [HEAVY — checking compaction]
  ✓ Context at 67% — safe to proceed
  ✓ Ran 12 tests
  ✓ ALL_TESTS_PASSING

[jonggrang] Phase 14/16: Coverage (Tester)
  ✓ Coverage: 87% (threshold: 80%)
  ✓ ALL_TESTS_PASSING

[jonggrang] Phase 15/16: TestQuality (Reviewer)
  ✓ REVIEW_COMPLETE

[jonggrang] Phase 16/16: Complete (Lead)
  ✓ .jonggrang/.output/features/<id>/progress.txt updated
  ✓ MANIFEST status: completed

[jonggrang] Orchestration complete! Feature: feat-20260411-d4e5f6
```

### Step 2: Resume After Session Reset

If the session was interrupted (compaction, crash, network), resume from where it left off:

```bash
jonggrang orchestrate --resume
```

Output:

```
[jonggrang] Found in-progress MANIFEST: feat-20260411-d4e5f6
[jonggrang] Resuming from phase 13 (Test)
...
```

### Step 3: Check MANIFEST

```bash
cat .jonggrang/.output/features/feat-20260411-d4e5f6/MANIFEST.yaml
```

```yaml
feature_id: feat-20260411-d4e5f6
description: "add Stripe payment flow..."
work_type: MEDIUM
status: completed
current_phase: 16
active_phases: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
phases:
  "1":  { status: completed }
  "2":  { status: completed }
  ...
  "16": { status: completed }
validation:
  typecheck: true
  lint: true
  tests: true
context_usage:
  current_tokens: 134000
  percentage: 0.67
```

### Step 4: Verify

```bash
git log --oneline
```

```
a1b2c3d test(payments): verify webhook idempotency
d4e5f6g feat(payments): add Stripe checkout + webhook handler
```

```bash
npm run test
```

```
 ✓ tests/payments/checkout.test.ts  (4 tests)
 ✓ tests/payments/webhook.test.ts   (5 tests)
 ✓ tests/payments/order.test.ts     (3 tests)

 Test Files  3 passed (3)
      Tests  12 passed (12)
 Coverage:   87%
```

---

## Bugfix Example — Fast Track

For a bug, orchestrate uses fast-track (skips architecture phases):

```bash
jonggrang orchestrate "fix: auth middleware crashes when Authorization header is missing"
```

```
[jonggrang] Work type: BUGFIX
[jonggrang] Skipping phases: [5, 6, 7, 9, 12]
[jonggrang] Active phases: [1, 2, 3, 4, 8, 10, 11, 13, 14, 15, 16]

[jonggrang] Phase 8/11 (effective): Implement (Developer)
  ✓ Gateway: backend → debugging-systematically
  ✓ Fixed src/middleware/auth.ts:23
  ✓ IMPLEMENTATION_COMPLETE

...done in 11 phases instead of 16
```

---

## Quick Reference

### Work Loop

| Command | What it does |
|---------|-------------|
| `jonggrang init` | Interactive setup wizard |
| `jonggrang init --name x --type api --force` | Non-interactive setup |
| `jonggrang status` | Show task board |
| `jonggrang work` | Run work loop (all tasks) |
| `jonggrang work --max-iterations 1` | Run one task only |
| `jonggrang work --task task-002` | Run specific task |
| `jonggrang work --tool claude` | Override AI tool |
| `jonggrang work --dry-run` | Preview prompt, don't execute |
| `jonggrang work --mode supervised` | Override autonomy mode |
| `jonggrang plan "feature description"` | Decompose feature into tasks |
| `jonggrang review` | Comprehensive code review |

### Orchestrate Mode

| Command | What it does |
|---------|-------------|
| `jonggrang orchestrate "description"` | Start 16-phase pipeline |
| `jonggrang orchestrate --resume` | Resume from saved MANIFEST |
| `jonggrang orchestrate "..." --dry-run` | Preview phases, no execution |
| `jonggrang orchestrate "..." --autonomy autonomous` | Skip human pause at phase 6 |
| `jonggrang orchestrate "..." --tool claude` | Override AI tool |

### Utilities

| Command | What it does |
|---------|-------------|
| `jonggrang version` | Show version |
| `jonggrang help` | Show all commands |
| `jonggrang web` | Run dashboard (port 7777, foreground; Ctrl+C to stop) |
