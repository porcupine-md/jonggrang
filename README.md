# Jonggrang

> AI Development Workflow Orchestrator — from project bootstrap to delivery.

Jonggrang is a CLI tool that orchestrates AI coding agents to handle your development workflow: initialize projects, decompose features into tasks, implement them autonomously, and review the results.

Supports [OpenCode](https://opencode.ai/) (default) and [Claude Code](https://claude.ai/code) as the AI agent backend.

Inspired by the [Ralph Loop](https://github.com/snarktank/ralph), [Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) (Addy Osmani), and the [collapsed SDLC](https://boristane.com/blog/the-software-development-lifecycle-is-dead/) (Boris Tane).

## How It Works

```
You describe what you want
        |
        v
  jonggrang plan  -->  Decomposes into atomic tasks
        |
        v
  jonggrang work  -->  For each task:
        |            1. Fresh context (no accumulated confusion)
        |            2. Read AGENTS.md + progress.txt (project knowledge)
        |            3. Pick highest priority unblocked task
        |            4. Implement via AI agent (opencode/claude)
        |            5. Validate (typecheck, tests, lint)
        |            6. Commit if pass
        |            7. Log learnings
        |            8. Repeat
        v
  jonggrang review  -->  Comprehensive code review
```

## Requirements

- **AI agent** (at least one):
  - [OpenCode](https://opencode.ai/) (default) — `curl -fsSL https://opencode.ai/install | bash`
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
- [jq](https://jqlang.github.io/jq/) — `brew install jq`
- git

## Install

```bash
npx @porcupine/jonggrang init
```

Or install globally:

```bash
npm install -g @porcupine/jonggrang
jonggrang init
```

This package is npm-only (no shell installer).

## Quick Start

```bash
# 1. Go to your project (or create a new directory)
cd my-project

# 2. Initialize Jonggrang
jonggrang init

# 3. Create a plan from a feature description
jonggrang plan "REST API for todo management with CRUD endpoints and tests"

# 4. Let Jonggrang work through the tasks
jonggrang work

# 5. Review the results
jonggrang review
```

### One-liner Init (skip the wizard)

```bash
# With OpenCode (default)
jonggrang init --name my-app --type api --stack express-typescript --autonomy balanced --force

# With Claude Code
jonggrang init --name my-app --type api --tool claude --autonomy autonomous --force
```

## Commands

### `jonggrang init`

Interactive wizard that sets up your project. Generates:
- `jonggrang.json` — project configuration
- `AGENTS.md` — project knowledge for AI agents (human-curated)
- `jonggrang-tasks.json` — task board
- `progress.txt` — append-only learnings log
- `skills/` — prompt templates filtered by your project type

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

For existing projects, Jonggrang auto-detects your stack, test framework, and CI/CD provider.

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

Runs the development loop. Each iteration is **stateless** — a fresh Claude Code instance that reads project context from files.

```bash
jonggrang work                                    # use config defaults
jonggrang work --mode autonomous                  # override autonomy mode
jonggrang work --tool claude                      # override AI tool for this session
jonggrang work --mode autonomous --max-iterations 5
jonggrang work --task task-003                    # work on specific task
jonggrang work --branch feat/auth                 # create/use a branch
jonggrang work --dry-run                          # show prompts, don't execute
```

### `jonggrang status`

Shows the task board.

```
==============================
  JONGGRANG Task Board
==============================

Project: my-app
Tasks: 2/5 completed

ID          Status       Owner      Title
--------------------------------------------------------------
task-001    completed    -          Initialize project
task-002    completed    -          Add user model
task-003    in_progress  -          Add auth endpoints
task-004    pending      -          Add auth middleware
task-005    pending      -          Add auth tests
```

### `jonggrang review`

Runs a comprehensive code review on all changes:
- Code quality and consistency
- Security vulnerabilities
- Test coverage
- Performance patterns

Output goes to `jonggrang-log/review-{timestamp}.md`.

## Autonomy Modes

| Mode | Behavior | Best for |
|------|----------|----------|
| **supervised** | Agent proposes plan, waits for human approval at every step | Learning, critical systems |
| **balanced** | Agent runs automatically, pauses on failures or ambiguity | Daily development |
| **autonomous** | Full loop — agent plans, implements, commits. Human reviews at the end | Well-defined tasks, boilerplate |

Override at runtime:

```bash
jonggrang work --mode supervised
jonggrang work --mode autonomous
```

## Skill System

Skills are **markdown prompt templates** that guide Claude Code through specific tasks. They live in `skills/<name>/SKILL.md` and are copied to your project during `jonggrang init`.

### Built-in Skills

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

### Custom Skills

Create your own:

```bash
mkdir -p skills/my-skill
cat > skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: What this skill does
type: scaffold
project_types: [web-app, api]
trigger: "natural language trigger"
---

## Context
Background info. Use {{project_name}}, {{stack}}, etc.

## Instructions
1. Step one
2. Step two

## Validation
- [ ] Check one
- [ ] Check two
EOF
```

## Project Files

After `jonggrang init`, your project will have:

```
your-project/
├── jonggrang.json           # Project config
├── jonggrang-tasks.json     # Task board state
├── AGENTS.md            # Project knowledge (edit this!)
├── progress.txt         # Auto-generated learnings
└── skills/              # Prompt templates
    ├── prd/SKILL.md
    ├── scaffold-api/SKILL.md
    └── ...
```

### AGENTS.md

This is the most important file for output quality. It tells AI agents about your project's conventions, patterns, and gotchas. **Human-curated** — research shows LLM-generated AGENTS.md can reduce quality, but human-written ones improve it ~4%.

### progress.txt

Append-only log written by the agent after each task. Captures learnings, discovered patterns, and surprises. Creates compound learning across iterations.

## Configuration

See `jonggrang.json` after init. Key settings:

```jsonc
{
  "tool": "opencode",               // or "claude"
  "mode": {
    "autonomy": "balanced"           // default autonomy mode
  },
  "work": {
    "max_iterations": 10,            // max loop iterations
    "retry_limit": 2,                // retries before skipping
    "kill_after_fails": 3            // consecutive fails before blocking
  },
  "hooks": {
    "pre_commit": ["npm test"]       // quality gates
  }
}
```

Full reference: [docs/CONFIG.md](docs/CONFIG.md)

## Documentation

- [JONGGRANG.md](docs/JONGGRANG.md) — Full specification
- [SKILLS.md](docs/SKILLS.md) — Skill system documentation
- [WORKFLOW.md](docs/WORKFLOW.md) — Detailed workflow documentation
- [CONFIG.md](docs/CONFIG.md) — Configuration reference

## Release Workflow

Use the provided Make targets to bump versions and produce a fresh build:

```bash
# defaults to patch bump
make release

# explicit bump level
make release BUMP=minor
make release-major
```

`make release` updates versions in both `package.json` files (root and client), refreshes `package-lock.json`, and runs `npm run build` so the dist assets stay in sync with the new release.

## License

MIT © Porcupine Team
