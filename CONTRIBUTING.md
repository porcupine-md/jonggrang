# Contributing to Jonggrang

Thank you for your interest in contributing to Jonggrang! This guide covers everything you need to get started.

---

## Quick Setup

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** (comes with Node.js)
- **git**
- **jq** (`brew install jq` on macOS, `apt install jq` on Ubuntu)
- An AI coding agent (at least one):
  - [OpenCode](https://opencode.ai/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

### Install & Build

```bash
# Clone the repo
git clone https://github.com/porcupine/jonggrang.git
cd jonggrang

# Install root + client dependencies
make install

# Or manually:
npm install && cd client && npm install

# Build the web dashboard client
npm run build
```

### Verify

```bash
# Check the CLI works
node bin/jonggrang.js version

# Run the dev server
npm run dev:server    # starts Express + Socket.io on :3001

# Run the dashboard client (optional, for web UI development)
npm run dev:client    # starts Vite dev server for client/
```

### Release Process

```bash
make release          # bump patch version + rebuild (default)
make release BUMP=minor     # bump minor
make release-major    # bump major
make build-binary     # compile standalone binary with Bun
```

---

## Architecture Overview

Jonggrang is built on a **Thin Agent / Fat Platform** model. Understanding this distinction is fundamental to contributing effectively.

### The Five-Layer Stack

```
LAYER 1: AGENT          — Stateless workers (<150 lines each)
LAYER 2: SKILL           — Two-tier progressive knowledge loading
LAYER 3: ORCHESTRATION   — 16-phase state machine with MANIFEST.yaml
LAYER 4: HOOK            — Deterministic enforcement (8 layers of defense)
LAYER 5: INFRASTRUCTURE  — Token gates, dirty bits, file locks
```

### Key Architectural Principle

**Coordinators plan. Executors implement. Never both.**

- Roles with `Task` tool (Lead, TestLead) cannot edit files
- Roles with `Edit`/`Write` (Developer, Tester) cannot spawn sub-agents
- Reviewer is strictly read-only

### Codebase Map

| Path | What it is |
|------|-----------|
| `bin/jonggrang.js` | CLI entry point — parses commands, dispatches to lib/ |
| `server.js` | Express + Socket.io server for web dashboard |
| `lib/jonggrang.js` | Core logic: `init`, `plan`, `work`, `status`, `review` commands |
| `lib/orchestration.js` | 16-phase pipeline engine — the "kernel" |
| `lib/gateway.js` | Skill routing: maps task intent to skill file paths |
| `lib/feedback.js` | Dirty bit tracking + feedback loop state machine |
| `lib/compaction.js` | Context usage measurement + compaction gate thresholds |
| `lib/hooks.js` | Hook installation for Claude Code and OpenCode |
| `lib/roles.js` | Five role definitions (lead, developer, reviewer, test-lead, tester) |
| `lib/locks.js` | File ownership locking for parallel worktree execution |
| `hooks/claude/*.sh` | Eight enforcement layers as bash scripts for Claude Code |
| `hooks/opencode/plugin.js` | Same enforcement logic as OpenCode plugin (JavaScript) |
| `skills/core/*/SKILL.md` | Tier 1 skills — always loaded into agent prompts |
| `skills/library/*/SKILL.md` | Tier 2 skills — JIT loaded via Gateway routing |
| `templates/agents/*.md` | Role templates: lead.md, developer.md, reviewer.md, test-lead.md, tester.md |
| `templates/AGENTS.md.template` | Template for the project AGENTS.md |
| `templates/CLAUDE.md.template` | Template for Claude Code CLAUDE.md |
| `client/src/` | Vue.js web dashboard (Kanban board, logs, phase tracking) |
| `docs/` | Full documentation |

---

## How to Contribute

### 1. Fork and Branch

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR_USERNAME/jonggrang.git
cd jonggrang
git checkout -b feat/my-feature
```

Use conventional branch prefixes:

| Prefix | Use for |
|--------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation changes |
| `refactor/` | Code restructuring |
| `skill/` | New or updated skills |
| `hook/` | New or updated hooks |

### 2. Make Changes

#### Changing Core Logic (`lib/`)

The `lib/` modules are plain Node.js (no TypeScript, no build step). Key points:

- `lib/jonggrang.js` is the main orchestrator. Commands like `plan`, `work`, `review` are defined here.
- `lib/orchestration.js` handles the 16-phase pipeline. Each phase is numbered (1-16) and has a defined role.
- `lib/gateway.js` uses keyword-based routing to map task descriptions to skill paths. If you add a new library skill, you must update the routing table here.
- `lib/feedback.js` manages the domain-based dirty bit state machine. Domains are detected by file path patterns.
- `lib/compaction.js` reads session transcripts to calculate token usage.

#### Adding a New Skill

Skills are markdown prompt templates. There are two tiers:

**Core Skill** (loaded into every agent prompt):

```bash
mkdir -p skills/core/my-skill
cat > skills/core/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: What this skill does (one line)
type: scaffold | transform | validate | generate | orchestrate
tier: core
project_types: [web-app, api, library, cli, tui]
trigger: "natural language trigger phrases"
---

## Context
Background information for the agent. Use {{variable}} for interpolation.
Available variables: {{project_name}}, {{project_type}}, {{stack}}, {{test_framework}}

## Instructions
1. Step one
2. Step two

## Validation
- [ ] Check one
- [ ] Check two
EOF
```

**Library Skill** (JIT loaded via Gateway):

```bash
mkdir -p skills/library/backend/my-pattern
cat > skills/library/backend/my-pattern/SKILL.md << 'EOF'
---
name: my-pattern
description: Deep domain knowledge about X
type: pattern
tier: library
domain: backend
trigger: "specific keywords that trigger gateway routing"
---

## Context
Deep domain knowledge here.

## Instructions
1. Step one

## Validation
- [ ] Check one
EOF
```

After adding a library skill, update the corresponding Gateway:

1. Add the skill to the routing table in `skills/core/gateway-{domain}/SKILL.md`
2. Update the keyword matching in `lib/gateway.js`

**Skill Design Rules:**

- Core skills: keep under 500 lines
- Library skills: as deep as needed (they're loaded on-demand)
- Every skill MUST have frontmatter, Context, Instructions, and Validation sections
- Use `{{variable}}` interpolation for project config values
- Triggers should be specific enough to avoid false positives

#### Adding or Modifying Hooks

Hooks are the enforcement layer. There are two hook platforms:

- **Claude Code**: Bash scripts in `hooks/claude/*.sh`
- **OpenCode**: JavaScript plugin in `hooks/opencode/plugin.js`

The eight enforcement layers:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| 1 | CLAUDE.md / AGENTS.md | Full ruleset loaded at session start |
| 2 | Core Skills | Procedural workflows |
| 3 | Agent Definitions | Role behavior, tool restrictions |
| 4 | PromptSubmit hooks | Pre-validate prompts |
| 5 | PreToolUse hooks | Block before action (agent-first, compaction gate) |
| 6 | PostToolUse hooks | Track modifications (dirty bit) |
| 7 | SubagentStop hooks | Block premature exit (output enforcement) |
| 8 | Stop hooks | Block exit until review + tests pass |

When modifying hooks, ensure behavioral parity between Claude Code and OpenCode implementations.

#### Adding Agent Role Templates

Edit files in `templates/agents/`. Key rules:

- Agent prompts must be strictly under 150 lines
- Must include role-specific tool restrictions
- Must include the completion signal protocol
- Must reference the Gateway for skill resolution

### 3. Test Your Changes

Jonggrang uses a manual validation approach for most changes. For each change:

1. **Core logic changes**: Run the relevant command end-to-end:

```bash
# Test init
node bin/jonggrang.js init --name test-project --type api --stack express-typescript --autonomy balanced --force

# Test work loop
node bin/jonggrang.js plan "simple feature"
node bin/jonggrang.js work --dry-run

# Test orchestrate
node bin/jonggrang.js orchestrate --dry-run "fix a bug"

# Test dashboard
node bin/jonggrang.js web --port 8080 --no-open
```

2. **Skill changes**: Test via the Gateway:

```bash
node -e "
const gw = require('./lib/gateway');
const r = gw.buildGatewayResponse('YOUR TEST DESCRIPTION', './skills');
console.log(r);
"
```

3. **Hook changes**: Create a test project and verify the hook fires correctly:

```bash
# Install hooks to a test project
node bin/jonggrang.js init --name hook-test --type api --tool claude --force
# Check the generated settings
cat .claude/settings.json
# Verify hook scripts are executable
ls -la hooks/claude/
```

### 4. Commit

Use conventional commit messages:

```
feat(orchestration): add phase skip logic for BUGFIX work type
fix(gateway): correct keyword routing for React hooks
docs(readme): add web dashboard section
skill(auth): add JWT refresh token flow
hook(feedback): fix domain detection for monorepo paths
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `skill`, `hook`

### 5. Push and Create PR

```bash
git push origin feat/my-feature
```

Create a Pull Request with:

- **Description**: What changed and why
- **Testing**: How you verified the change
- **Docs**: Whether documentation needs updating (and which files)

---

## Code Conventions

### General

- **Language**: Plain Node.js for `lib/` and `server.js`. No TypeScript transpilation step — the project runs directly with `node`.
- **Client**: Vue 3 with Vite for the web dashboard (`client/src/`).
- **Style**: 4-space indentation, semicolons, single quotes.
- **No `any` types** (when migrating to TypeScript in future).
- **Error handling**: Always include meaningful error messages. Never swallow errors silently.

### Module Structure

Each module in `lib/` exports functions or a single object. No classes — prefer functional style:

```javascript
// lib/something.js
const fs = require('fs');
const path = require('path');

function doSomething(input) {
  // ...
  return result;
}

module.exports = { doSomething };
```

### Skill Markdown Conventions

- Frontmatter must be valid YAML between `---` delimiters
- Use `{{variable}}` interpolation for dynamic values (resolved from `.jonggrang/jonggrang.json`)
- Validation sections use `- [ ]` checklist syntax
- Keep core skills focused; deep domain knowledge goes in library skills

### Hook Conventions

- Bash hooks must be executable (`chmod +x`)
- Exit code 0 = allow, exit code 2 = block
- Output JSON to stdout for structured feedback
- OpenCode plugin mirrors all Claude Code hook behavior
- Never put business logic in hooks that belongs in skills or lib/

---

## Project Files Understanding

When contributing, you'll encounter these key files in any Jonggrang-managed project:

| File | Who writes | Purpose |
|------|-----------|---------|
| `AGENTS.md` | Human (curated) | Project conventions, patterns, gotchas — the single most important file for output quality |
| `.jonggrang/jonggrang.json` | `jonggrang init` | Project config: tool, mode, work settings, hooks, testing |
| `.jonggrang/jonggrang-tasks.json` | `jonggrang plan` | Task board state with dependencies, files, and status |
| `.jonggrang/progress.txt` | Agent (auto) | Append-only learnings log — prevents repeating mistakes |
| `.jonggrang/.output/features/*/MANIFEST.yaml` | Orchestrator | Phase state for orchestrate mode — survives session resets |

**Golden Rule**: Agents propose changes to `AGENTS.md` via `.jonggrang/progress.txt`, but humans curate `AGENTS.md`. Never let an agent write directly to `AGENTS.md`.

---

## Common Contribution Scenarios

### "I want to add a new library skill"

1. Create `skills/library/{domain}/{skill-name}/SKILL.md` with proper frontmatter
2. Add keyword entries to the appropriate gateway (`skills/core/gateway-{domain}/SKILL.md`)
3. Update the routing table in `lib/gateway.js`
4. Test via Gateway resolution: `node -e "const gw = require('./lib/gateway'); ..."`
5. Update `docs/SKILLS.md` catalog

### "I want to add a new hook enforcement"

1. Write the bash script in `hooks/claude/your-hook.sh`
2. Write the equivalent JavaScript logic in `hooks/opencode/plugin.js`
3. Register the hook in `hooks/claude/settings.json`
4. Update the enforcement layer documentation in:
   - `README.md` (Platform Architecture section)
   - `docs/WORKFLOW.md` (Hook System section)
   - `docs/ORCHESTRATION.md` (Eight-Layer Defense section)
5. Test by creating a test project and verifying the hook fires

### "I want to add a new orchestration phase"

1. Update `lib/orchestration.js` — add phase definition
2. Update `lib/roles.js` — add role mapping for the phase
3. Update `templates/agents/` — add role template if new role
4. Update phase skipping logic for work types
5. Update `MANIFEST.yaml` schema in docs
6. Update `docs/WORKFLOW.md` and `docs/JONGGRANG.md` phase tables
7. Update `SKILL.md` role mapping section

### "I want to add a new command"

1. Add the command handler in `lib/jonggrang.js`
2. Wire it up in `bin/jonggrang.js`
3. Add it to the CLI help text
4. Update `README.md` Commands section
5. Add it to `SKILL.md` Commands Reference

### "I want to fix a bug in the feedback loop"

1. Understand the state machine in `lib/feedback.js`
2. The dirty bit state lives in `.jonggrang/.ephemeral/feedback-loop-state.json`
3. Domain detection is pattern-based: file path -> domain mapping
4. The feedback loop hooks are in `hooks/claude/feedback-loop.sh`
5. Ensure both Claude Code and OpenCode implementations stay in sync

---

## Debugging Tips

- **Dry run first**: `jonggrang work --dry-run` shows the prompt without executing
- **Verbose mode**: Set `JONGGRANG_VERBOSE=1` for detailed logging
- **Check MANIFEST**: `cat .jonggrang/.output/features/*/MANIFEST.yaml` for orchestration state
- **Check feedback state**: `cat .jonggrang/.ephemeral/feedback-loop-state.json` for dirty bits
- **Check compaction**: `cat .jonggrang/.ephemeral/compaction-state.json` for token usage
- **Check locks**: `ls .jonggrang/locks/` for file ownership in team mode
- **Read progress**: `cat .jonggrang/progress.txt` for agent learnings log
- **Resume orchestrate**: `jonggrang orchestrate --resume` picks up from last MANIFEST state

---

## Resources

| Doc | Content |
|-----|---------|
| [README.md](README.md) | Overview, commands, platform architecture |
| [docs/JONGGRANG.md](docs/JONGGRANG.md) | Full specification, philosophy, five-role model |
| [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) | Deep architecture: thin agents, hooks, state management |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Detailed workflow: work loop, orchestrate, hooks, compaction |
| [docs/SKILLS.md](docs/SKILLS.md) | Skill system: two-tier, gateway, creating custom skills |
| [docs/CONFIG.md](docs/CONFIG.md) | Configuration reference for `jonggrang.json` |
| [docs/EXAMPLE.md](docs/EXAMPLE.md) | End-to-end walkthroughs (Work Loop + Orchestrate) |
| [SKILL.md](SKILL.md) | Agent instructions — what every agent reads first |

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
