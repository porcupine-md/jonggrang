---
title: Integrate agent-browser for frontend design validation
date: 2026-07-14
status: implemented
branch: feat/browseruse
---

# Plan — Add `vercel-labs/agent-browser` to the sandbox and make every coding agent aware of it

## Goal

Ship [`agent-browser`](https://github.com/vercel-labs/agent-browser) (a native Rust
browser-automation CLI for AI agents) inside the Jonggrang sandbox image, and wire it
into the skill/template layer so that **every** agent backend (`claude`, `opencode`,
`codex`, `jonggrang`) knows the tool exists and uses it to **validate frontend design**
(screenshots, accessibility snapshots, responsive/contrast checks) before signalling
completion.

## Background (research findings)

- `agent-browser` installs via `npm install -g agent-browser`; Chrome is fetched with
  `agent-browser install` (`--with-deps` on Linux to pull system libs). No Node/Playwright
  needed at runtime for the daemon.
- Key commands for design validation: `open <url>`, `snapshot` (a11y tree + `@refs`),
  `screenshot page.png`, `click @ref`, `fill @ref`, `get text @ref`, `wait`, `close`.
  Runs headless — works in the container.
- Two channels make an agent "aware" of a tool in Jonggrang:
  1. **Sandbox image** — `docker/Dockerfile` + `docker/Dockerfile.dev`, "AI tools" block
     (`npm install -g jonggrang @anthropic-ai/claude-code opencode-ai @openai/codex`).
  2. **Skills** — any `skills/**/SKILL.md` is auto-copied on `jonggrang init` into
     `.claude/skills`, `.opencode/skills`, `.jonggrang/skills`, `.codex/skills`
     (`lib/jonggrang.js:2061` `skillTargets`). One skill ⇒ all backends see it. Skills are
     seeded paths, already excluded from feature-branch commits.
- Existing frontend touchpoints to extend: `skills/core/gateway-frontend/SKILL.md` (intent
  router) and `skills/library/frontend/auditing-interface-quality/SKILL.md`
  (Phase 10 Reviewer, read-only).

## Decisions (confirmed)

- **Install:** npm global **+** bundle Chrome via `agent-browser install --with-deps`
  (ready offline; accepts the ~150–300 MB image growth).
- **Scope:** full — skills + agent role templates + project-instruction templates + docs.

## Changes

### 1. Sandbox image
- `docker/Dockerfile` — add `agent-browser` to the global `npm install -g` block, then a
  `RUN agent-browser install --with-deps` step to bundle Chrome + Linux deps.
- `docker/Dockerfile.dev` — mirror the same.

### 2. Skills (primary "all agents know" channel)
- **New:** `skills/library/frontend/validating-visual-design/SKILL.md` — concrete
  agent-browser workflow: start dev server → `open` → `snapshot`/`screenshot` →
  check layout/contrast/responsive/a11y → `close`, with example commands and completion
  signal.
- **Edit:** `skills/core/gateway-frontend/SKILL.md` — add routing row for intents
  (`visual`, `design check`, `screenshot`, `responsive`, `browser validation`) → the new
  skill; add `agent-browser` to the `trigger` keywords.
- **Edit:** `skills/library/frontend/auditing-interface-quality/SKILL.md` — make
  agent-browser the concrete tool for the Diagnostic Scan (screenshot evidence + a11y
  snapshot). Reviewer stays read-only on source; agent-browser only observes.

### 3. Agent role & project templates
- `templates/CLAUDE.md.template` (+ `templates/AGENTS.md.template`) — add a
  "Browser Automation" section (per agent-browser README): when/how to validate frontend
  with agent-browser.
- `templates/agents/developer.md` — in "Validation Before Signaling", add a visual-check
  step with agent-browser when the task touches UI.
- `templates/agents/reviewer.md` — in "Phase 10 — Design Verification", reference
  agent-browser.

### 4. Docs (Iron Rule — CLAUDE.md doc-sync)
- `README.md` (Requirements) — note agent-browser ships in the sandbox.
- `docs/SKILLS.md` — list the new `validating-visual-design` skill.
- `docs/WORKFLOW.md` / `docs/PHILOSOPHY.md` — Phase 10 now has a real visual-validation tool.
- `docs/AGENTTOOLS.md` — short note: agent-browser is a shared agent tool (not a backend).

## Verification (done)
- Built an Ubuntu 24.04 image with the exact agent-browser block and ran the full
  design-validation workflow inside a container: `open → set viewport → snapshot →
  screenshot → click → close`. Snapshot returned the a11y tree (heading/textbox/button
  roles); screenshots were valid PNGs at the requested dimensions (1280×800 and 375×812);
  the captured render was visually correct. All core checks passed.
- Changes left uncommitted / unpushed (user commits themselves).

## Cross-arch finding (fixed during e2e)
`agent-browser install` fetches **Chrome for Testing, which ships Linux amd64 only** — it
fails the image build on ARM64. The Dockerfiles now branch on `dpkg --print-architecture`:
amd64 uses `agent-browser install --with-deps`; arm64 installs Playwright's Chromium
(`npx playwright install --with-deps chromium`), which `agent-browser` auto-detects (no env
var needed). Also corrected the documented CLI syntax: screenshots use `screenshot <path>`
(no `--full-page` flag) and resizing uses `set viewport <w> <h>` (no `--viewport` flag).

## Out of scope
- No new `jonggrang` CLI subcommand or backend integration (`agent-browser` is a tool the
  agents call via Bash, not an agent backend).
- No cloud-browser providers (Browser Use / Kernel) — local headless Chrome only.
