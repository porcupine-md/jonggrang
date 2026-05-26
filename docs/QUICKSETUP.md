# Development Setup Guide

> For contributors. Clone, build, and start hacking on Jonggrang itself.

---

## Prerequisites

```bash
node --version     # ≥ 18
npm --version
git --version

# Optional for binary builds:
bun --version      # npm install -g bun
```

---

## Clone & Install

```bash
git clone <repo-url> jonggrang
cd jonggrang
make install        # npm install + cd client && npm install
```

---

## Project Structure

```
jonggrang/
├── bin/
│   └── jonggrang.js          # CLI entry point
├── lib/
│   ├── jonggrang.js          # Core CLI logic
│   ├── orchestration.js      # 16-phase state machine
│   ├── hooks.js              # Hook loader (Claude, OpenCode, Pi)
│   ├── feedback.js           # Feedback loop (dirty bits)
│   ├── compaction.js         # Compaction gate
│   ├── gateway.js            # Skill gateway routing
│   ├── roles.js              # 5-role assembly line
│   ├── settings.js           # Two-layer config management
│   ├── locks.js              # File ownership locks
│   ├── tui.js                # Pi TUI integration
│   ├── bot-reviewer/         # Automated review bot
│   └── tui/                  # TUI components
├── hooks/
│   ├── claude/               # Claude Code hook definitions
│   ├── opencode/             # OpenCode plugin
│   └── pi/                   # Pi SDK extension (jonggrang-extension.ts)
├── skills/
│   ├── core/                 # Tier 1 — always loaded (28 skills)
│   └── library/              # Tier 2 — JIT via gateway
├── client/
│   ├── src/                  # Web dashboard (React + Vite)
│   ├── dist/                 # Built client assets
│   └── package.json
├── scripts/
│   ├── check.sh              # Validation script (syntax, structure)
│   └── ensure-build.sh       # Auto-build client if needed
├── test/
│   └── backend-args.test.js  # Backend argument parsing tests
├── templates/                # Init templates
├── docs/                     # Documentation
└── server.js                 # Express + Socket.IO dashboard server
```

### Key Entry Points

| Entry | What it does |
|-------|-------------|
| `bin/jonggrang.js` | CLI command router — parses args, delegates to lib/ |
| `server.js` | Web dashboard — Express + Socket.IO, serves client/dist |
| `client/` | Dashboard frontend — React app built with Vite |
| `hooks/pi/jonggrang-extension.ts` | Pi SDK extension — loaded via `--extension` on `jonggrang agent` |

---

## Build & Run

```bash
# Standard build (client only — lib/ is plain JS)
make build          # cd client && npm install && npm run build

# Run CLI
node bin/jonggrang.js init
node bin/jonggrang.js plan "test feature"

# Run dashboard
node server.js      # serves at http://localhost:8080

# Dev mode (hot-reload dashboard)
npm run dev:client  # Vite dev server
npm run dev:server  # Express with auto-restart (you'll need nodemon/etc.)
```

---

## Validation

```bash
# Full check (syntax + structure)
npm run check

# Quick syntax-only check
npm run check:quick

# Run tests
npm test
```

---

## Binary Build (Bun)

```bash
make build-binary                            # dist/jonggrang
make build-binary BIN_OUT=out/jonggrang-darwin
```

---

## Release Workflow

```bash
make release                # patch bump + build
make release BUMP=minor
make release-major
```

---

## Architecture Overview

Jonggrang is built on a **Thin Agent / Fat Platform** model:

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
│  Claude Code hooks · OpenCode plugin · Pi   │
├─────────────────────────────────────────────┤
│  INFRASTRUCTURE    Compaction · Feedback     │
│  Token gates · Dirty bits · Lock files      │
└─────────────────────────────────────────────┘
```

### State Machine (`lib/orchestration.js`)

The 16-phase orchestration engine drives the entire workflow. Each phase outputs a structured artifact (JSON/YAML) to `.jonggrang/.output/features/{id}/`. Phases can be skipped based on work type. State persists across session restarts via MANIFEST.yaml.

→ [Full orchestration docs](ORCHESTRATION.md)

### Skill System (`skills/`)

Skills are markdown prompt templates loaded by agents. **Core skills** are always available (like BIOS). **Library skills** are loaded on-demand via domain gateways (`gateway-backend`, `gateway-frontend`, etc.) that detect intent from natural language.

→ [Skill system docs](SKILLS.md)

### Hooks (`hooks/`)

Deterministic enforcement that operates outside the LLM's context. Same rules apply regardless of AI backend. Three layers: pre-tool (block secrets/spawn), post-tool (dirty bits), stop (exit gates).

### Feedback Loop (`lib/feedback.js`)

Tracks which domains (backend/frontend/testing) were modified. When dirty bits are set, the agent cannot exit until both review and testing pass for every modified domain.

### Compaction Gate (`lib/compaction.js`)

Monitors context usage before heavy execution phases. Warns at 75%, hard-blocks at 85%. Each backend reads context differently: Claude Code reads JSONL transcripts, OpenCode listens for `session.compacted`, Jonggrang uses `before_provider_request` in Pi extension.

---

## Key Files to Edit

| Task | File |
|------|------|
| Add a CLI command | `bin/jonggrang.js` → `lib/jonggrang.js` |
| Add an orchestration phase | `lib/orchestration.js` |
| Add a hook | `hooks/{claude\|opencode\|pi}/` |
| Add a core skill | `skills/core/<name>/SKILL.md` |
| Add a library skill | `skills/library/<domain>/<name>/SKILL.md` |
| Modify the dashboard | `client/src/` |
| Change init templates | `templates/` |
| Update the dashboard API | `server.js` |

---

## Testing

```bash
npm test   # runs test/backend-args.test.js
```

The test suite validates backend argument parsing — ensuring `--model`, `--effort`, and `--tool` flags map correctly to each AI backend's native arguments.

---

## Documentation

| Doc | Content |
|-----|---------|
| [PHILOSOPHY.md](PHILOSOPHY.md) | Full philosophy & architecture deep-dive |
| [JONGGRANG.md](JONGGRANG.md) | Full specification |
| [WORKFLOW.md](WORKFLOW.md) | Detailed workflow documentation |
| [ORCHESTRATION.md](ORCHESTRATION.md) | 16-phase state machine reference |
| [SKILLS.md](SKILLS.md) | Skill system reference |
| [CONFIG.md](CONFIG.md) | Configuration reference |
| [AGENTTOOLS.md](AGENTTOOLS.md) | Agent tool integration details |
