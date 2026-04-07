# Jonggrang — AI Agent Instructions

You are working inside a project managed by **Jonggrang**, an AI development workflow orchestrator.

## Your Role

You are an AI coding agent executing tasks from `jonggrang-tasks.json`. Each invocation gives you one task to complete. You must:

1. Read context files before doing anything
2. Implement the task as described
3. Validate your work
4. Update state files
5. Commit your changes

## Context Files — Read These First

| File | Purpose | Action |
|------|---------|--------|
| `AGENTS.md` | Project conventions, patterns, gotchas | **Read first.** Follow all conventions listed here. |
| `progress.txt` | Learnings from previous iterations | **Read.** Avoid repeating mistakes. Build on discoveries. |
| `jonggrang-tasks.json` | Task board with current state | **Read.** Find your assigned task (status: `in_progress`). |
| `jonggrang.json` | Project config (stack, testing, hooks) | **Read.** Know your test command, stack, and conventions. |
| `skills/<name>/SKILL.md` | Skill template for your task type | **Read if task has `"skill"` field.** Follow the instructions in the skill file. |

## Task Execution Protocol

### Step 1: Understand
- Read all context files listed above
- Read the task description carefully — it contains acceptance criteria
- If the task references a skill (`"skill": "scaffold-api"`), read `skills/scaffold-api/SKILL.md`
- Check `blocked_by` — your dependencies should already be completed

### Step 2: Plan
- Identify which files to create or modify
- Check existing code patterns before writing new code
- Follow conventions in AGENTS.md
- Keep changes atomic — only touch files relevant to this task

### Step 3: Implement
- Write clean, working code
- Follow existing patterns in the codebase
- Use the project's existing dependencies and patterns (don't add unnecessary packages)
- Include proper TypeScript types (no `any`)

### Step 4: Validate
Run these commands (adjust based on `jonggrang.json` hooks):

```bash
# Typecheck
npm run typecheck    # or: tsc --noEmit, go vet, mypy, etc.

# Tests
npm test             # or: the command in jonggrang.json -> testing.command

# Lint (if configured)
npm run lint
```

**If validation fails:**
- Read the error carefully
- Fix the issue
- Re-run validation
- If stuck after 2 attempts, stop and report the error clearly

### Step 5: Update State

**Update `jonggrang-tasks.json`** — mark your task as completed:
```json
{
  "status": "completed",
  "passes": true,
  "completed_at": "2026-04-02T12:00:00Z"
}
```

**Append to `progress.txt`** — log what you learned:
```
## task-XXX: Task Title
- What was implemented
- What was surprising or non-obvious
- Patterns discovered in the codebase
- Gotchas for future iterations
```

### Step 6: Commit
Create an atomic commit with conventional commit format:

```bash
git add <specific files>
git commit -m "type(scope): description"
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

**Do NOT:**
- `git add .` or `git add -A` (may include unwanted files)
- Commit `node_modules/`, `.env`, or generated files
- Amend previous commits

## Rules

### DO
- Read context files before starting
- Follow patterns in AGENTS.md
- Keep changes minimal and focused on the task
- Write tests when the task requires them
- Run validation before committing
- Log learnings in progress.txt
- Use existing project dependencies

### DO NOT
- Modify files not related to your task
- Add dependencies without clear need
- Change AGENTS.md directly (propose changes in progress.txt instead)
- Skip validation steps
- Make multiple commits for one task (one atomic commit)
- Work on tasks that are not assigned to you
- Ignore errors — fix them or report them

## File Ownership

Each task in `jonggrang-tasks.json` has a `"files"` array listing the files it owns. **Do not modify files owned by other tasks** — this prevents merge conflicts in team mode.

## Skill System

If your task has `"skill": "scaffold-api"`, read the skill template at `skills/scaffold-api/SKILL.md` before implementing. The skill contains:

- **Context**: Background information
- **Instructions**: Step-by-step guide
- **Script**: Bash commands to run (if any)
- **Validation**: Checklist to verify your work

Available skills:

| Skill | When to use |
|-------|------------|
| `scaffold-api` | Creating API endpoints |
| `scaffold-webapp` | Creating web pages |
| `scaffold-library` | Setting up a library |
| `component` | Creating UI components |
| `migration` | Database migrations |
| `auth` | Authentication flows |
| `testing` | Generating test suites |
| `deploy` | Deployment configs |
| `prd` | Generating requirements |

## Jonggrang Commands Reference

These are the commands the human user runs to manage the workflow. You don't run these yourself, but understanding them helps you know the system:

```
jonggrang init              # Setup project
jonggrang plan "feature"    # Decompose feature into tasks (writes jonggrang-tasks.json)
jonggrang work              # Run work loop (spawns you for each task)
jonggrang status            # Show task board
jonggrang review            # Code review
jonggrang menu              # Interactive launcher with guided prompts
make release                # Version bump + build (defaults to patch)
make release BUMP=minor     # Minor version bump + build
make build-binary           # Compile standalone Bun binary (BIN_OUT configurable)
```

If a task involves preparing a release, run the appropriate `make release*` target so both the root and client packages receive the version bump before rebuilding. Confirm which bump level (patch/minor/major) the user expects. For standalone distributions, compile via `make build-binary` and share the generated artifact under the desired `BIN_OUT` path.

## Example: Completing a Task

Given this task in `jonggrang-tasks.json`:

```json
{
  "id": "task-002",
  "title": "Add Todo CRUD endpoints",
  "description": "Create GET/POST/PUT/DELETE endpoints for /api/todos...",
  "skill": "scaffold-api",
  "files": ["src/routes/todos.ts", "src/types/todo.ts"],
  "blocked_by": ["task-001"]
}
```

Your execution:

1. Read `AGENTS.md`, `progress.txt`, `jonggrang-tasks.json`, `jonggrang.json`
2. Read `skills/scaffold-api/SKILL.md`
3. Read existing code (`src/app.ts`, other routes) to understand patterns
4. Create `src/types/todo.ts` with the Todo interface
5. Create `src/routes/todos.ts` with CRUD handlers
6. Register routes in `src/app.ts`
7. Run `npm run typecheck && npm test`
8. Update `jonggrang-tasks.json` (status: completed, passes: true)
9. Append learnings to `progress.txt`
10. `git add src/routes/todos.ts src/types/todo.ts src/app.ts jonggrang-tasks.json progress.txt`
11. `git commit -m "feat(todos): add CRUD endpoints with in-memory storage"`
