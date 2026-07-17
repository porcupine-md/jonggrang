# Quick Start Guide

> For beginners. Get Jonggrang running and build your first feature in 5 minutes.

---

## Prerequisites

Make sure you have these installed:

```bash
node --version     # ≥ 18
git --version
jq --version       # brew install jq (macOS) or apt install jq (Linux)
```

Pick and install an AI agent backend:

```bash
# Option A: OpenCode (free, recommended)
curl -fsSL https://opencode.ai/install | bash

# Option B: Claude Code (requires Anthropic account)
npm install -g @anthropic-ai/claude-code

# Option C: Jonggrang / Pi (multi-provider, most flexible)
npm install -g @earendil-works/pi-coding-agent
```

---

## Step 1: Initialize Your Project

```bash
cd your-project
jonggrang init
```

This launches an interactive wizard. It will ask you:
- Project name
- Project type (web-app, api, cli, etc.)
- Tech stack
- Which AI tool to use

Or skip the wizard:

```bash
jonggrang init --name my-app --type api --stack express-typescript --tool opencode --force
```

After init, you'll see new files:
- `AGENTS.md` — edit this! Tell the AI about your project conventions
- `.jonggrang/` — config, task board, progress log
- `skills/` — AI prompt templates

---

## Step 2: Plan Your Feature

Tell Jonggrang what you want to build:

```bash
jonggrang plan "user authentication with JWT and password reset"
```

The AI writes a draft plan to `.jonggrang/.drafts/<session>/plan.md` (a per-session draft folder, gitignored). **Read and edit it** before continuing — this is your chance to correct the AI's assumptions before any code is written. Each `jonggrang plan` call creates its own session, so concurrent planning doesn't overwrite.

For UI work, Jonggrang also audits existing tokens, components, screens, and
verification tools. The draft may include a proposed `UI.md` and always includes
feature direction in `UI_HANDOFF.md`. Before a new project uses a built-in
starter, answer the preference question: provide your own direction/reference,
accept the recommendation, or decline starter packs. Do not use `--yes` until
that choice is explicit.

---

## Step 3: Approve the Plan

```bash
jonggrang approve
```

`approve` defaults to the most-recent draft. If you have multiple pending drafts, run `jonggrang approve --session <id>` (the session id is shown by `jonggrang plan` / the web dashboard).

The AI decomposes your plan into atomic tasks. Each task is small enough for one AI context window, with clear acceptance criteria and dependency ordering. UI approval also writes `.jonggrang/UI.md`, a feature `UI_HANDOFF.md`, and bounded `ui_context` on UI tasks. See [UI planning context](UI_CONTEXT.md).

Check the task board:

```bash
jonggrang status
```

---

## Step 4: Execute

```bash
jonggrang work
```

Jonggrang works through the task queue. Each task gets a **fresh AI agent** — no accumulated confusion between tasks.

Watch it:
- Implement the task
- Run type checks and tests
- Commit if everything passes
- Log what it learned
- Move to the next task

---

## Step 5: Review

```bash
jonggrang review
```

A comprehensive code review across all changes. The report is saved to `jonggrang-log/review-{timestamp}.md`.

---

## Common Workflows

### I want to skip plan review (one-shot)

```bash
jonggrang work "add REST API for todos" --yes
```

This runs plan → approve → execute in one command. Good for well-defined, low-risk features.

### I already approved a plan and want to add more scope

Instead of creating a whole new plan, **extend** the existing one — the new tasks are appended to it, numbering continues from where it left off, and completed tasks stay untouched:

```bash
jonggrang status                    # grab the feature id you want to extend
jonggrang plan --append feat-abc123 "also add rate limiting to the login endpoint"
# review the extension draft, then:
jonggrang approve --feature feat-abc123
# or one-shot: jonggrang plan --append feat-abc123 "..." --yes
```

The web dashboard has an **"Extend this plan"** button on any approved plan for the same flow.

### I want to use Claude Code instead of OpenCode

```bash
jonggrang work --tool claude
```

Or set it permanently in `.jonggrang/jonggrang.json`:
```json
{ "tool": "claude" }
```

### I want more control (supervised mode)

```bash
jonggrang work --mode supervised
```

The agent will pause and ask for your input at key decision points.

### I want full autonomy

```bash
jonggrang work --mode autonomous
```

The agent plans, implements, and commits everything. You review at the end.

### I want to use the TUI chat

```bash
jonggrang agent
```

Opens a full interactive chat session. Use `/plan`, `/work`, `/review`, `/status` commands without leaving the chat.

### I want a visual dashboard

```bash
jonggrang web
```

Runs the dashboard in the foreground on **http://127.0.0.1:7777**, exactly like
`node server.js` — logs stream to your terminal and **Ctrl+C** stops it. Open
that URL for a Kanban board, real-time agent logs, and diff viewer. Override the
bind with `--port <n>` / `--host <addr>` if needed.

---

## Troubleshooting

### "command not found: jonggrang"

Install globally:
```bash
npm install -g jonggrang
```

Or use npx:
```bash
npx jonggrang init
```

### "No AI tool configured"

Run `jonggrang init` first, or install one of the supported tools:
```bash
curl -fsSL https://opencode.ai/install | bash
```

### Task fails repeatedly

```bash
jonggrang work --task task-003   # Retry specific task
jonggrang work --max-iterations 3  # Limit retries
```

Check `.jonggrang/.output/features/<id>/progress.txt` for what the agent learned from failures.

### Plan looks wrong

Edit the draft plan directly before running `jonggrang approve`. The AI only reads it at approval time — you have full control until then. (`jonggrang approve` defaults to the most-recent draft; use `--session <id>` to pick a specific one.)

---

## Next Steps

- [Configure your project](CONFIG.md) — autonomy mode, hooks, CI
- [Understand the philosophy](PHILOSOPHY.md) — why the pipeline exists
- [Learn the skill system](SKILLS.md) — create custom AI behaviors
- [Full command reference](../README.md#commands-at-a-glance)
