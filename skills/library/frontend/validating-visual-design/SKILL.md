---
name: validating-visual-design
description: Validate frontend design in a real browser using the agent-browser CLI — screenshots, accessibility snapshots, responsive and contrast checks.
type: workflow
tier: library
domains: [frontend]
trigger: "visual, design check, screenshot, responsive, contrast, layout, browser validation, agent-browser, verify UI, does it look right, render"
---

# Validating Visual Design with agent-browser

Frontend code that typechecks and passes unit tests can still render broken.
This skill uses **`agent-browser`** — a browser-automation CLI preinstalled in the
Jonggrang sandbox — to open the running app in a real (headless) Chrome and verify
the design actually works.

`agent-browser` is available to every agent backend (claude, opencode, codex,
jonggrang). Call it via Bash. Chrome for Testing is already installed in the sandbox
image, so no setup is needed there. On a bare host, run `agent-browser install` once.

## When to use

- After implementing or changing any UI (component, page, layout, styling).
- Before signalling completion on a task that touches the frontend.
- During Phase 10 design verification / interface-quality audits.

## Core commands

```bash
agent-browser open http://localhost:3000       # open a URL (starts the browser)
agent-browser snapshot                          # accessibility tree with @refs (a11y check)
agent-browser screenshot design.png             # capture the rendered page (PNG)
agent-browser set viewport 375 812              # resize (e.g. mobile) before capturing
agent-browser get text @e1                       # read text by ref from snapshot
agent-browser click @e2                          # interact by ref
agent-browser fill @e3 "value"                   # fill an input by ref
agent-browser wait --load networkidle            # wait until the page settles
agent-browser close                              # shut the browser down
```

## Workflow

1. **Start the dev server** for the app (e.g. `npm run dev &`) and note its URL.
   Wait until it is reachable before opening the browser.
2. **Open the page:** `agent-browser open <url>` then `agent-browser wait --load networkidle`.
3. **Capture evidence:** `agent-browser screenshot <feature>.png`. Read the screenshot
   back to inspect layout, spacing, alignment, colors, and dark mode.
4. **Check accessibility & structure:** `agent-browser snapshot` — verify semantic
   roles, labels, and that key elements are present and reachable.
5. **Check responsiveness:** resize to a narrow viewport and screenshot again to
   catch horizontal scroll, overflow, and touch-target sizing.
   ```bash
   agent-browser set viewport 375 812        # mobile portrait
   agent-browser screenshot mobile.png
   agent-browser set viewport 1280 800       # back to desktop
   ```
6. **Exercise interactions** the task depends on (`click`/`fill`) and confirm the
   resulting state via `snapshot`/`screenshot`.
7. **Tear down:** `agent-browser close` and stop the dev server.

## What to look for

- **Layout:** no overlap, no unintended overflow/horizontal scroll, correct alignment.
- **Responsive:** usable at mobile (375px) and desktop widths; touch targets ≥ 44px.
- **Theming:** dark mode renders; colors come from design tokens, not hard-coded values.
- **Accessibility:** headings, labels, ARIA roles, alt text present in the snapshot.
- **Content:** expected text and elements actually appear (not blank / error state).

## Validation

The design is validated when a screenshot + snapshot of the built UI have been
captured and reviewed against the task's acceptance criteria, with no critical
layout, responsive, theming, or accessibility issues outstanding.

## Notes

- `agent-browser` runs headless in the sandbox; no display server is required.
- Reviewers are read-only on source code — `agent-browser` only observes, so it is
  safe to run during audits. Save any screenshots inside the active feature's
  `.jonggrang/.output/features/<feature_id>/` directory.
- Do not put secrets/credentials in command args; use the app's own login flow.
