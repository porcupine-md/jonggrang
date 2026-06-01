# Simplify Phase — Diff Budget with Per-File Fallback

**Date:** 2026-05-30
**Status:** Design approved, pending implementation
**Area:** Orchestrate mode — Phase 9 (Simplification)

---

## Problem

The simplify phase (`buildSimplifyPrompt`, `lib/orchestration.js:430`) injects only a
list of changed file paths into the prompt and tells the agent to *"Read each file
listed above"*. The agent then loads the **full content of every changed file** into a
single session.

On small-context backends (e.g. DeepSeek via the jonggrang Pi SDK), the session fills
and **auto-compacts mid-run** — frequently — because the loaded token count equals the
sum of all changed files read in full. This is compaction case **(B)**: it happens
*inside the simplify agent's own session*, not in the orchestrator thread (the
`compaction-gate.sh` hook, which guards the main Claude thread at 200k).

## Goal

Reduce in-agent compaction during simplify by:
1. Feeding the agent the **diff** (changed hunks) instead of making it read whole files
   (Approach 1 — default).
2. Falling back to **one fresh agent per file** when the total diff is large
   (Approach 2 — automatic fallback), so per-session token load is bounded by a single
   file rather than the sum of all files.

The fallback decision is **deterministic, made in code before spawning** — not delegated
to the (small) model, which would already have compacted by the time it "noticed."

## Non-goals

- Not changing any phase other than Simplify.
- Not chunking a single oversized file further (accepted limitation, see Edge Cases).
- Not making the budget user-configurable yet (kept as a code constant).

---

## Design

### Components

| Component | Location | Purpose |
|---|---|---|
| `SIMPLIFY_DIFF_BUDGET = 200_000` | `lib/orchestration.js` (const) | Token threshold: total diff ≤ budget → single mode; otherwise per-file mode. Tunable. |
| `estimateTokens(text)` | `lib/compaction.js` (new, exported) | Rough estimate `Math.ceil(text.length / 4)` (~4 chars/token). Reused for the budget check. |
| `planSimplify(manifest, projectRoot)` | `lib/orchestration.js` (new) | Deterministic brain: gathers diffs, estimates tokens, picks mode, returns a plan. |
| `buildSimplifyPrompt(...)` | `lib/orchestration.js` (modified) | Single-mode prompt — now inlines the diff under `## Changes`. |
| `buildSimplifyPromptForFile(...)` | `lib/orchestration.js` (new) | Per-file-mode prompt — same template scoped to one file + its diff. |
| Simplify special-case | `bin/jonggrang.js` (phase loop) | Calls `planSimplify`; runs one agent (single) or loops per file (per-file). |

### Decision flow (`planSimplify`)

```
1. changedFiles = getChangedFilesForSimplify(manifestPath, projectRoot)   // existing
2. for each file: diff = git diff HEAD -- <file>
                  (if empty → untracked/new file → use full file content as the diff)
3. totalTokens = estimateTokens(join(all diffs))
4. if totalTokens <= SIMPLIFY_DIFF_BUDGET (200_000):
       return { mode: 'single', prompt: buildSimplifyPrompt(... diffs inlined ...) }
   else:
       return { mode: 'per-file',
                units: changedFiles.map(f => ({ file: f, prompt: buildSimplifyPromptForFile(f, diff_f, ...) })) }
```

### Control flow (`bin/jonggrang.js`)

A dedicated branch before the generic phase-prompt block:

```
if (phaseNum === SIMPLIFY_PHASE) {
    plan = orchestration.planSimplify(manifest, PROJECT_ROOT)
    if (plan.mode === 'single') {
        runAgent(plan.prompt, activeTool, activeMode, ...)        // == current behavior
    } else {
        for (const unit of plan.units) {
            runAgent(unit.prompt, activeTool, activeMode, ...)    // fresh session per file
        }
    }
    completePhase(...) once all runs return exitCode 0
    continue
}
```

- Per-file mode runs on **the user's configured backend** (`activeTool`), not locked to
  DeepSeek — same `runAgent` path as single mode.
- Phase completion is gated on `exitCode === 0` per run (existing convention), not on
  parsing any signal.

### Prompt shapes (all English)

**Single mode** — current `buildSimplifyPrompt` template, plus:
- New `## Changes` section containing the inlined diff(s).
- `## Process` step 1 becomes:
  *"Review the diff below. Use the Read tool to open a full file **only if** you need
  more surrounding context."*

**Per-file mode** — identical template, scoped to one file:
- `## Scope` lists only that one file.
- `## Changes` contains only that file's diff.
- Closes with `IMPLEMENTATION_COMPLETE` (the developer role's completion signal).

### Why `IMPLEMENTATION_COMPLETE` is safe in per-file mode

`IMPLEMENTATION_COMPLETE` is the **developer role's `completion_signal`**
(`lib/roles.js:31`), consumed by `detectCompletionSignal` (`lib/roles.js:208`) for
loop/role detection — it is **not** a hard phase gate. Phase completion is driven by
`exitCode` in the work loop (`bin/jonggrang.js:1871-1876`). Each per-file agent is an
independent run that emits the signal at the end of its single-file task; repeating it
across N runs is harmless and consistent with the role convention.

---

## Edge cases

1. **New / untracked files** — `git diff HEAD -- <file>` is empty. Use the **full file
   content** as that file's "changes" (simplifying a new file means reviewing it whole
   anyway). Already captured: `getChangedFilesForSimplify` includes untracked files.
2. **A single file whose diff alone exceeds the budget** — per-file mode still sends that
   one large diff to one agent, which *may* still compact. This is the granularity floor;
   damage is bounded to that file. **Not** split further (YAGNI). Emit a `logWarn` so it
   is visible.
3. **Zero changed files** — preserve current graceful behavior (simplify becomes a no-op).

---

## Docs to update (CLAUDE.md iron rule — pipeline phase behavior change)

- `docs/WORKFLOW.md` — Simplify phase now has two modes + automatic fallback.
- `docs/JONGGRANG.md` — Simplify / 16-phase section.
- `docs/PHILOSOPHY.md` — only if it describes simplify mechanics.
- `docs/CONFIG.md` — **not** needed yet (budget stays a code constant). Revisit only if
  the budget is later exposed in `jonggrang.json`.

---

## Implementation order

1. Add `estimateTokens` to `lib/compaction.js` + export.
2. Add `SIMPLIFY_DIFF_BUDGET`, `getDiffForFile`/diff-gathering helper, `planSimplify`,
   `buildSimplifyPromptForFile` to `lib/orchestration.js`; update `buildSimplifyPrompt`
   to inline diffs.
3. Wire the simplify special-case branch in `bin/jonggrang.js`.
4. Update docs (WORKFLOW, JONGGRANG, PHILOSOPHY as applicable).
5. Verify: run a feature through orchestrate with both a small diff (single mode) and a
   large diff (per-file mode); confirm no mid-run compaction on the small-window backend.
