---
name: anoa
description: Drive a real browser from the command line — open pages, snapshot the interactive elements as refs, click and fill by ref, read text, run JS, screenshot. Use when a task needs a live browser: checking a page renders, walking a login or checkout flow, scraping something that only exists after JavaScript runs, or reproducing a UI bug.
type: tool
tier: core
domains: [frontend, ui, testing, debugging]
trigger: "browser, anoa, screenshot, render, responsive, viewport, dark mode, console errors, network requests, click, fill form, login flow, scrape, verify UI, visual check"
---

# anoa

`anoa` is the browser every Jonggrang agent drives — a single self-contained
binary that carries its own browser, so there is **no Playwright or Chrome
download to wait for**.

In the sandbox it is preinstalled. On a bare host, install it once with
`scripts/install-linux.sh` from the anoa repo; if `anoa` is not on PATH, install
it rather than reaching for another tool.

## The one thing to know

The browser is a **session**. Start it once; every later command attaches to the
running browser and leaves it running, so the page, cookies and scroll position
survive between commands.

```bash
anoa --headless --port 9222 &   # start it once
anoa open example.com           # then drive it
anoa snapshot -i                # see what is interactive, with @refs
anoa click @e2                  # act by ref
```

`anoa status` reports whether a browser is listening; **exit code 3 means none
is** — that, not a wrong command, is why `anoa open` would do nothing.

## Load the full reference before working

The binary carries its own documentation, which is always in step with the
installed version:

```bash
anoa skills get core        # the workflow: start, snapshot, act by ref
anoa skills get commands    # every command with its arguments
```

Read `core` before your first browser task in a session, and `commands` when you
need exact syntax. Do not work from memory of another browser CLI — `anoa` is
session-based, so one-shot recipes from other tools silently do nothing here.

## What it is good for

| Need | Reach for |
|---|---|
| Does the page render, and how does it look | `anoa open`, `anoa screenshot [file]` |
| What can I interact with | `anoa snapshot -i` → `@refs` |
| Responsive / dark mode check | `anoa set viewport <w> <h>`, `anoa set device`, `anoa set media dark\|light` |
| Read what the page says | `anoa get text [@ref]` — cheaper than `get html` |
| Walk a flow | `anoa fill @e3 "…"`, `anoa click @e7`, `anoa wait --url "/dashboard"` |
| Why is the UI broken | `anoa console`, `anoa errors`, `anoa network` |

`--json` on any command gives structured output. Exit codes: `0` ok, `1` failed,
`2` bad usage, `3` no browser listening.

## Rules

- **Re-snapshot after anything that changes the page.** Refs are written onto DOM
  nodes; a navigation or a submit replaces them. `no element for @e4` means the
  snapshot is stale, not that the command is wrong.
- **Prefer `wait --selector` / `--url` / `--text` over `wait --ms`.** They are
  faster on a quick page and more reliable on a slow one.
- **Prefer `get text` over `get html`.** HTML costs far more tokens and rarely
  says more.
- Any CSS selector works wherever a ref does: `anoa click "#submit"`.

## Watching it happen

`anoa terminal` renders the live page in the terminal and forwards clicks and
typing, attached to the same running browser — useful in one pane while commands
run in another.
