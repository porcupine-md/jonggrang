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
│   ├── src/                  # Web dashboard (Vue + Vite)
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
| `client/` | Dashboard frontend — Vue app built with Vite |
| `hooks/pi/jonggrang-extension.ts` | Pi SDK extension — loaded via `--extension` on `jonggrang agent` |

---

## Build & Run

```bash
# Standard build (client only — lib/ is plain JS)
make build          # cd client && npm install && npm run build

# Run CLI
node bin/jonggrang.js init
node bin/jonggrang.js plan "test feature"

# Run dashboard (production: serves built client/dist on port 7777)
node server.js      # serves at http://127.0.0.1:7777

# Dev mode (single process: Express + Vite middleware + auto-restart)
npm run dev         # = nodemon server.js  (nodemon.json sets NODE_ENV=development)
```

> `npm run dev` runs Vite in middleware mode in-process, so the client hot-reloads
> and the API is served from the same port (7777) — no separate `dev:client` needed.
> `NODE_ENV=development` is set via `nodemon.json` (cross-platform, no inline shell
> env in the npm script), which also restarts the server on changes to `server.js`,
> `lib/`, and `apis/`. Mode is chosen by `NODE_ENV`: `development` → Vite middleware;
> anything else (including `jonggrang web` / `npm start`) → static `client/dist`.

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
make release                # patch bump + build, no tag (local check)
make release BUMP=minor
make release-major

make publish                # patch bump + build + commit + push tag  → CI releases
make publish BUMP=minor
```

**The tag is the release.** Pushing `vX.Y.Z` runs `.github/workflows/docker.yml`,
which does two things in this order:

1. `npm-release` — verifies the tag matches `package.json`, builds `client/dist`
   (gitignored, but in the published `files`), runs the test suite, and publishes
   `jonggrang@X.Y.Z` to npm. Re-running is safe: an already-published version is
   skipped, not failed.
2. `publish` — builds `jonggrang-agent` and `jonggrang-tunnel` for amd64 + arm64,
   **pinned** to `jonggrang@X.Y.Z` via the `JONGGRANG_VERSION` build arg, and
   tags them `X.Y.Z`, `X.Y` and `latest`.

Nothing publishes to npm by hand. Two publishers race, and the loser is the
image: the tag was pushed first and npm published afterwards, so
`jonggrang-agent:0.19.2` was built while npm still served 0.19.1 and shipped it
under the new tag. Projects then ran a CLI a release behind their dashboard.
The pin now fails that build instead of publishing a tag that lies.

### One-time setup

Publishing uses npm **trusted publishing** (OIDC): npm trusts a named workflow in
a named repository, so there is no token stored anywhere and nothing to rotate.

On npmjs.com → package `jonggrang` → *Settings* → **Trusted publisher**:

| Field | Value |
|---|---|
| Organization or user | `porcupine-md` |
| Repository | `jonggrang` |
| Workflow filename | `docker.yml` |
| Environment | *(leave empty)* |

That is the whole npm-side setup — `jonggrang` is already public and owned by
`anak10thn` + `ans4175`, and no GitHub secret is involved.

Two things this couples to the filename and the job:

- **Renaming `.github/workflows/docker.yml` breaks publishing** until the trusted
  publisher setting is updated to the new name. Same for moving the
  `npm-release` job into another file.
- The job needs **npm >= 11.5.1** for OIDC, and Node 22 still ships npm 10.x, so
  it upgrades npm before publishing.

**Provenance.** `--provenance` needs `id-token: write` on the job, a public
repository, and a `repository` field in `package.json` — all three are in place.
It is what makes the npm page show the commit and workflow a tarball came from.

**Repairing a mis-tagged image** (built before its npm version existed) — run the
workflow manually with the version, no new release needed. A repair writes the
`X.Y.Z` tag **only**: `:latest` and `:X.Y` float, and moving them to an older
version would hand every project a downgrade.

```bash
gh workflow run docker.yml -f version=0.19.2
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
