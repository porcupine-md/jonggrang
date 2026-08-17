---
name: validating-visual-design
description: Validate frontend design in a real browser using the anoa CLI — screenshots, interactive snapshots, responsive, dark-mode and contrast checks.
type: workflow
tier: library
domains: [frontend]
trigger: "visual, design check, screenshot, responsive, contrast, layout, browser validation, anoa, verify UI, does it look right, render"
---

# Validating Visual Design with anoa

Frontend code that typechecks and passes unit tests can still render broken.
This skill uses **`anoa`** — the browser CLI preinstalled in the Jonggrang sandbox
— to open the running app in a real headless browser and verify the design
actually works.

`anoa` is available to every agent backend (claude, opencode, codex, jonggrang).
Call it via Bash. In the sandbox it is already there — start with the session
step below.

On a bare host, install the binary once:

```bash
curl -fsSL https://raw.githubusercontent.com/porcupine-md/anoa-browser/master/scripts/install-linux.sh | bash
```

That is one binary carrying its own browser, so there is **no second download
for a browser** — but the binary itself does have to exist. If `anoa` is not on
PATH, install it rather than reaching for another tool.

## The browser is a session

This is the one thing to get right. Start the browser **once**; every command
after that attaches to the running browser and leaves it running, so the page,
cookies and scroll position survive between commands.

```bash
anoa --headless --port 9222 &     # start once, in the background
anoa status                       # exit code 3 = nothing listening
```

A command that seems to do nothing almost always means no browser is running —
check `anoa status` before assuming the command is wrong.

## When to use

- After implementing or changing any UI (component, page, layout, styling).
- Before signalling completion on a task that touches the frontend.
- During Phase 10 design verification / interface-quality audits.

## Core commands

```bash
anoa open http://localhost:3000    # go to a url (scheme optional)
anoa wait --load                   # or --text/--url/<css>: name what you expect
anoa screenshot design.png         # PNG of the viewport
anoa snapshot -i                   # interactive elements, each with an @ref
anoa get text                      # all visible text (cheaper than get html)
anoa click @e2                     # act by ref — or by any CSS selector
anoa fill @e3 "value"              # fires input/change, so React sees it
anoa set viewport 375 812          # resize the page
anoa set media dark                # emulate prefers-color-scheme
anoa console                       # what the page logged
anoa errors                        # uncaught exceptions
```

Run `anoa skills get commands` for the full reference — it ships with the binary
and is always in step with the installed version.

## Workflow

1. **Start the dev server** for the app (e.g. `npm run dev &`) and note its URL.
   Wait until it is reachable.
2. **Start the browser once:** `anoa --headless --port 9222 &`.
3. **Open the page:** `anoa open <url>` then `anoa wait --load`. When you know what
   should appear, `anoa wait --text "…"` is faster and more honest than `--load`.
4. **Capture evidence:** `anoa screenshot <feature>.png`. Read the screenshot back
   to inspect layout, spacing, alignment and colour.
5. **Check structure:** `anoa snapshot -i` — verify the key elements are present,
   labelled and reachable. Re-snapshot after anything that changes the page.
6. **Check responsiveness:**
   ```bash
   anoa set viewport 375 812        # mobile portrait
   anoa screenshot mobile.png
   anoa set viewport 1280 800       # back to desktop
   ```
7. **Check dark mode:** `anoa set media dark` → screenshot → `anoa set media light`.
8. **Exercise interactions** the task depends on (`click` / `fill`) and confirm the
   resulting state via `snapshot` / `screenshot`.
9. **Check the console:** `anoa errors` and `anoa console` — a page can look right
   and still be throwing.

Leave the browser running; the next task attaches to it. There is no teardown
step to forget.

## What to look for

- **Layout:** no overlap, no unintended overflow/horizontal scroll, correct alignment.
- **Responsive:** usable at mobile (375px) and desktop widths; touch targets ≥ 44px.
- **Theming:** dark mode renders; colours come from design tokens, not hard-coded values.
- **Accessibility:** headings, labels, roles present in the snapshot.
- **Content:** expected text and elements actually appear (not blank / error state).
- **Console:** no uncaught errors behind a page that looks fine.

## Validation

The design is validated when a screenshot + snapshot of the built UI have been
captured and reviewed against the task's acceptance criteria, with no critical
layout, responsive, theming, accessibility or console issues outstanding.

## Notes

- `anoa` runs headless; no display server is required.
- Reviewers are read-only on source code — `anoa` only observes, so it is safe to
  run during audits. Save screenshots inside the active feature's
  `.jonggrang/.output/features/<feature_id>/` directory.
- Do not put secrets/credentials in command args; use the app's own login flow.
- `anoa terminal` renders the live page in your terminal if you want to watch a
  flow rather than infer it from screenshots.
