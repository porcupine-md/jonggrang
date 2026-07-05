---
feature: append-plan-extend-tasks
branch: feat/append-plan
work_type: LARGE
description: Let a user extend an EXISTING approved plan with additional scope and decompose the extra work as ADDITIONAL tasks appended to that plan's task list — plus fix task numbering so each plan numbers its tasks from 001 (per-feature), while an append continues from the plan's existing task count.
created_at: 2026-07-01
status: design — nothing implemented yet (this doc is for review)
---

# Plan: Append to an Existing Plan + Per-Plan Task Numbering

> **Scope of THIS doc:** design only. Build order, exact touch-points, numbering
> rules, the migration/compat story, and CLI + web surfaces. No code yet.
>
> **Two coupled deliverables** (they must ship together or numbering gets weird):
> 1. **Per-plan task numbering** — each plan/feature numbers its tasks from `task-001`.
> 2. **Append-to-existing-plan** — add scope to an approved plan and decompose
>    *additional* tasks into it, continuing that plan's numbering.

---

## 1. Mental Model — read this first

Today Jonggrang has **one global task counter**. The user wants **per-plan
counters** plus an **append** path:

```
TODAY (global, monotonic):
  feature A:  task-001 task-002 task-003
  feature B:  task-004 task-005          ← continues A's numbers
  feature C:  task-006 …

WANTED (per-plan, resets to 001; append continues within the plan):
  feature A:  task-001 task-002 task-003
  feature B:  task-001 task-002          ← fresh plan → starts at 001
  feature A (after APPEND "also add X"):
              task-001 task-002 task-003  (unchanged, completed → immutable)
              task-004 task-005           ← appended, continue A's own max
```

So there are **two numbering modes**, selected by *which flow ran*:

| Flow | Target feature | Numbering |
|---|---|---|
| **New plan** (`plan "x"` → `approve`) | a brand-new feature | start at **task-001** |
| **Append** (`plan --append <id> "x"` → `approve --feature <id>`) | an existing feature | **continue** from that feature's current max |

> ⚠️ **The catch the user flagged ("penomoran task di check lagi"):** the current
> code makes task IDs *globally unique on purpose* — `findTaskFeature` and the
> `jonggrang task done/show/update/block/remove task-005` auto-lookup all assume a
> bare `task-NNN` resolves to exactly one task across the whole project. Per-plan
> numbering breaks that (two plans can both own `task-001`). §6 reworks resolution
> so nothing silently picks the wrong task.

---

## 2. Current Behavior — audit (with citations)

So we change exactly what's needed and nothing load-bearing breaks.

### 2.1 Numbering is global & monotonic
- `maxTaskNumber(allTasks)` scans **every** task across **all** features for the
  largest `task-(\d+)` (`lib/jonggrang.js:503-510`).
- `addTask` (`lib/jonggrang.js:512-524`) and `addTasksBulk`
  (`lib/jonggrang.js:526-543`) seed the next id from that **global** max —
  `task-${maxTaskNumber(all.tasks)+1}`.
- The decompose prompt **tells the agent to continue the global sequence**:
  > "Task IDs are GLOBALLY unique across all features. Continue numbering from the
  > existing IDs listed above — do NOT restart at task-001. If the last existing ID
  > is task-007, start at task-008." (`lib/jonggrang.js:1006-1008`; the
  > "Existing Task IDs (across all features…)" block is built at `:948-963`.)

### 2.2 Every `approve` makes a NEW feature (no append path)
- `cmdApprove` (`bin/jonggrang.js:1429`) resolves a draft, reads its frontmatter
  feature name, then **always** mints a fresh id:
  `featureId = orchestration.generateFeatureId(featureName)` (`bin/jonggrang.js:1469`)
  — slug + base36 timestamp (`lib/orchestration.js:408-417`), so re-approving the
  "same" feature still yields a new folder.
- It creates `.jonggrang/.output/features/<id>/` + `MANIFEST.yaml` up front
  (`:1474-1479`), runs the decompose agent (`:1493-1494`), then archives the draft
  plan into the feature and discards the draft session (`:1508-1509`).
- **There is no `approve --feature <existing>` and no `plan --append`.** The
  decompose prompt has a latent **"UPDATE MODE"** branch (`lib/jonggrang.js:957-962`,
  "append after the last existing ID, never modify completed") but it only fires
  when the target `featureId` already has completed tasks — which the normal
  `approve` path can never produce, because it always targets a brand-new feature.

### 2.3 Task-id resolution depends on global uniqueness
- `findTaskFeature(projectRoot, taskId)` returns the (single) feature owning a
  bare id by scanning all features (`lib/jonggrang.js:99-104`).
- Per-feature task files were *explicitly* designed around globally-unique ids so
  `jonggrang task done task-005` resolves unambiguously (comment `lib/jonggrang.js:472-482`).
- `makeTask` stores **no separate ordinal** — the only number is inside the id
  string (`lib/jonggrang.js:` `makeTask`). So "the task number" == the `NNN` in `task-NNN`.

### 2.4 Web
- `POST /api/projects/:id/approve` just spawns `approve --session <draft>`
  (`apis/projects/approve.js:10-27`) → always a new feature.
- Plans list / draft grouping is per-feature already (`apis/projects/plan.js`),
  and the kanban is grouped by `feature_id` — so the **web already has a feature
  context** everywhere it touches tasks. This is good news for §6.

---

## 3. The Numbering Decision (the crux)

Three options. **Recommendation: Option C.**

**Option A — keep global ids, fake per-plan display.** Store globally-unique ids,
show a per-feature ordinal in the UI. *Rejected:* the user wants the real `task-001`
per plan ("tiap plan nomornya mulai dari 001"), and tasks are referenced by id in
commits, `blocked_by`, and CLI — a cosmetic-only number is a lie waiting to confuse.

**Option B — composite ids (`<featureId>/task-001`).** Fully unambiguous. *Rejected
for now:* invasive — every id reference (blocked_by, commits, web routes, hooks,
existing data) changes shape; biggest blast radius.

**Option C — per-feature `task-NNN`, feature-scoped resolution (RECOMMENDED).**
- Each feature numbers its own tasks `task-001..task-N`. New plan → starts at 001.
- Ids are unique **within a feature**, not globally.
- Bare `task-NNN` resolves **within a feature context** (active feature / `--feature`),
  with a clear error when genuinely ambiguous (§6).
- Matches the user's literal ask, keeps id shape unchanged, and the web already
  carries feature context. Smallest change that's still correct.

---

## 4. Part A — Per-Plan Task Numbering

### 4.1 `lib/jonggrang.js` numbering becomes per-feature
- New helper `maxTaskNumberInFeature(projectRoot, featureId)` — max `task-(\d+)`
  among tasks **with that `feature_id`** (the per-feature file).
- `addTask` / `addTasksBulk` (`:512-543`) seed from `maxTaskNumberInFeature(featureId)`
  instead of the global `maxTaskNumber(all.tasks)`:
  - a fresh feature's file is empty → max 0 → first id `task-001`.
  - an append into an existing feature → max is that feature's own last → continues.
- Keep the old global `maxTaskNumber` only if still needed by a migration/compat
  reader; otherwise remove to avoid accidental reuse.
- Duplicate-guard changes from "no id collisions globally" (`:517`, `:534`) to "no
  id collisions **within this feature**" (`all.tasks` filtered by `feature_id`).

### 4.2 Decompose prompt becomes per-feature (`buildTasksFromPlanPrompt`)
- The "Existing Task IDs (across all features…)" block (`:948-963`) → show only the
  **target feature's** existing ids (empty for a new plan).
- Rewrite the rule at `:1006-1008`:
  - **New feature:** "This is a NEW plan — number tasks starting at `task-001`."
  - **Append (UPDATE MODE):** "This plan already has tasks `task-001..task-NNN`.
    Continue from `task-(NNN+1)`; NEVER modify or renumber existing/completed tasks."
- The schema example (`:996`, `:1002`) and `blocked_by` guidance stay (`task-NNN`
  shape unchanged) — references are within-feature, which is what decompose already
  produces.

### 4.3 `task import` enforces per-feature numbering
- `task import --feature <id>` (the path decompose uses) already targets a feature;
  ensure auto-id assignment uses the per-feature max so an agent that omits `id`
  still gets correct per-feature numbers, and an agent that *supplies* ids that
  collide within the feature is rejected with a clear message.

---

## 5. Part B — Append to an Existing Plan

### 5.1 CLI surface
- **`jonggrang plan --append <featureId> "<additional scope>"`**
  - Loads the existing feature's archived `plan.md` + its task list as context.
  - Generates a draft that describes ONLY the additional scope (a delta), tagged in
    frontmatter with `append_to: <featureId>` so `approve` knows where it goes.
  - Reuses the normal plan draft session machinery (`.drafts/<session>/plan.md`).
- **`jonggrang approve --feature <featureId>`** (and `approve` auto-detects
  `append_to` in the draft frontmatter)
  - Decomposes the delta plan into **additional** tasks **in the existing feature**,
    numbering continued from that feature's max (Part A), completed tasks untouched.
  - Does NOT mint a new feature id; does NOT create a new feature folder; appends to
    the existing `jonggrang-tasks.json`; appends/links the delta plan into the
    existing `features/<id>/plan.md` (e.g. an `## Appended <date>` section) so the
    feature's plan stays the source of truth.
  - MANIFEST: re-open the relevant phases (or record an append event) rather than
    treating the feature as freshly minted.
- Convenience: `jonggrang plan --append <id> "x" --yes` = append-plan + approve in
  one shot (mirrors `plan "x" --yes`).

### 5.2 Picking the target feature
- `<featureId>` accepted directly; if omitted, fall back to `resolveActiveFeature`
  (most-recent incomplete) and print which feature was chosen.
- `jonggrang plan --append` with no id → list approved features to pick from
  (mirror the no-arg `plan` picker).

### 5.3 Web surface (mirror the plan-ask web shape)
- On an existing plan in `PlanView.vue`, add **"Extend this plan"** → opens the same
  description box but POSTs to a new **`POST /api/projects/:id/plans/:featureId/extend`**
  (or `POST /:id/plan` with an `append_to` field).
- Server spawns `plan --append <featureId> "<desc>"`; the existing draft → questions
  (if plan-ask present) → `approve --feature <id>` round-trip is reused.
- The kanban for that plan then shows the appended tasks continuing its numbering;
  the per-plan board already filters by `feature_id`, so appended tasks land in the
  right board automatically.

---

## 6. Task-ID Resolution Rework (consequence of §3 Option C)

Per-feature ids mean a bare `task-005` can exist in multiple features. Every
bare-id command must resolve within a **feature scope**:

- Affected: `findTaskFeature` (`lib/jonggrang.js:99-104`) and its callers — the
  `jonggrang task show/update/done/block/remove <id>` family (`bin/jonggrang.js`
  task-id commands), `updateTaskMode`, and any `blocked_by` cross-checks.
- New resolution order for a bare id:
  1. If `--feature <id>` is given → resolve within that feature.
  2. Else if a single feature is "active" (`resolveActiveFeature`) and owns the id → use it.
  3. Else if exactly one feature across the project owns the id → use it (keeps old
     globally-unique data working — backward compatible).
  4. Else **error**: "task-005 exists in N plans: <ids>. Disambiguate with
     `--feature <id>`." (No silent wrong-task picks — this is the safety the user wants.)
- `blocked_by` stays **within-feature** (decompose only references sibling tasks),
  so no cross-feature dependency ids are introduced.
- Web: already feature-scoped (routes/kanban carry `feature_id`) — audit the task
  PATCH/done endpoints to pass `feature_id` through to the lib resolver rather than
  relying on a global lookup.

---

## 7. Backward Compatibility & Migration

- **Do NOT renumber existing features.** Their `task-NNN` ids are referenced by real
  git commits ("Task: task-007"), `progress.txt`, and `blocked_by`. Renumbering would
  rewrite history semantics. Existing features keep their current (possibly global)
  numbers; **only new features and new appends use per-feature numbering.**
- The resolver (§6 step 3) keeps legacy globally-unique ids resolving by single-match,
  so old projects keep working with no migration step.
- Mixed projects (old global features + new per-feature features) are fine: ambiguity
  only arises when two features share an id, and then the resolver errors helpfully.
- No on-disk schema migration required. (Optional: a `jonggrang doctor`-style report
  that flags duplicate ids across features so users know when to pass `--feature`.)

---

## 8. Edge Cases (don't miss these)

1. **Append onto a feature with completed tasks** — completed tasks immutable; new
   tasks appended after max; numbering continues (the "WANTED" example in §1).
2. **Append twice** — second append continues from the (now larger) max; no gaps,
   no reuse.
3. **Two plans both have `task-003`, user runs `task done task-003`** — resolver
   errors with the candidate list unless `--feature` / active feature disambiguates.
4. **`blocked_by` in an append** references existing ids in the same feature (e.g.
   appended `task-006 blocked_by task-004`) — must remain valid; cross-feature
   `blocked_by` is rejected/ignored.
5. **Agent ignores numbering instruction** (restarts at 001 inside an append, or
   collides) — `addTasksBulk`/`task import` must reject id collisions *within the
   feature* with a clear error so the agent retries (don't silently overwrite).
6. **Empty append** (agent adds no tasks) — preserve the existing feature + plan,
   error like the new-plan "no tasks created" guard (`bin/jonggrang.js:1500-1504`).
7. **Append target not found / not yet approved** — clear error; suggest `plan` (new)
   instead.
8. **Web concurrent appends to the same feature** — one generation at a time per
   feature (same constraint the plan flow already assumes).
9. **Worktree/branch:** an append reuses the existing feature's branch (frontmatter
   `branch:`), it does NOT cut a new branch — confirm in the parallel-run path.

---

## 9. Build Phases

| Phase | Deliverable | Notes |
|---|---|---|
| **P1** | Per-feature `maxTaskNumberInFeature` + `addTask`/`addTasksBulk` seed from it; per-feature collision guard | Foundation; unit-testable without an agent |
| **P2** | Task-id resolver rework (`findTaskFeature` + callers, `--feature` scope, ambiguity error) | Keeps legacy single-match working |
| **P3** | Decompose prompt: per-feature numbering + real UPDATE MODE wording (`buildTasksFromPlanPrompt`) | New-vs-append branches |
| **P4** | `plan --append <id>` (delta draft + `append_to` frontmatter) and `approve --feature <id>` / auto-detect | Core feature |
| **P5** | Append archive/merge into `features/<id>/plan.md` + MANIFEST re-open; preserve completed tasks | State correctness |
| **P6** | Web: "Extend this plan" in `PlanView.vue` + `POST /:id/plans/:featureId/extend` endpoint | Mirrors plan-ask web shape |
| **P7** | Docs + tests | §11, §12 |

Each phase is independently shippable; P1+P2 are the risky core (numbering +
resolution) and should land + be tested before P4.

---

## 10. Numbering Rules — precise spec (the user's core requirement)

```
NEW PLAN  (plan "x" → approve, fresh feature F):
    next = 1
    tasks: task-001, task-002, …, task-0NN     (per-feature, always from 001)

APPEND    (plan --append F "y" → approve --feature F):
    let maxF = max NNN among F's existing task-NNN          # e.g. 005
    appended: task-(maxF+1), task-(maxF+2), …               # e.g. task-006, task-007
    existing/completed tasks: UNCHANGED, never renumbered

Invariants:
  - id format stays "task-" + zero-padded 3-digit number (padStart(3,'0'))
  - numbers are contiguous within a feature (no gaps from append)
  - a number is never reused within a feature
  - across features, the SAME number may recur (that's the point) → resolve by feature
```

---

## 11. Testing

### CLI (deterministic + agent)
- **P1 unit (no agent):** add tasks to feature A → 001,002; create feature B → resets
  to 001,002; append to A → continues 003,004. Assert via `getAllTasks` + the files.
- **Resolver unit:** bare id unique → resolves; duplicate across features → errors;
  `--feature` disambiguates; legacy single-match still works.
- **Agent e2e:** `plan "X" --yes` → tasks 001…; then `plan --append <id> "Y" --yes`
  → appended tasks continue; completed tasks untouched; `task done <appended-id>`
  works with feature scope.

### Web e2e (browser + headless)
- New plan → kanban shows 001-based tasks. "Extend this plan" → describe scope →
  approve → appended tasks continue numbering in the SAME plan's board.
- Sandbox + non-sandbox.

### Acceptance checklist
- [ ] New plan numbers tasks from `task-001`.
- [ ] Append continues from the plan's own max; completed tasks immutable.
- [ ] No number reused / no gaps within a feature.
- [ ] Bare-id commands resolve by feature scope; ambiguity errors clearly.
- [ ] Legacy projects (global ids) keep working with no migration.
- [ ] Web "Extend this plan" round-trips end to end (CLI + web both verified).

---

## 12. Docs to Update (CLAUDE.md "Iron Rule")

| Change | Update |
|---|---|
| New `plan --append` / `approve --feature` + numbering rule | `README.md` (Commands at a Glance + flags), `docs/WORKFLOW.md` (two-phase + "Modifying a plan after approval"), `docs/QUICKSTART.md`, `docs/EXAMPLE.md` |
| Per-feature numbering + task-id resolution | `docs/JONGGRANG.md` (task state / project structure), `docs/WORKFLOW.md` |
| Web "Extend this plan" | `docs/UI.md` |
| Decompose/approve phase change | `docs/WORKFLOW.md`, `docs/ORCHESTRATION.md` if it touches the phase machine |

---

## 13. Open Decisions (need your call)

1. **Numbering model:** confirm **Option C** (per-feature `task-NNN` + scoped
   resolution) vs Option B (composite `<feature>/task-NNN`, fully unambiguous but
   invasive).
2. **Append command name:** `plan --append <id> "x"` (recommended) vs a dedicated
   `plan extend <id> "x"` subcommand.
3. **Append plan storage:** append a `## Appended <date>` section to the feature's
   existing `plan.md` (recommended — single source of truth) vs keep delta plans as
   separate files under the feature.
4. **Renumber legacy features to per-feature?** Recommended **NO** (keeps git/commit
   task references valid). Confirm.
5. **Scope:** do P1–P3 (numbering + resolution) ship first as a standalone PR, with
   P4–P6 (append flow + web) as a follow-up? Or all together?

---

## 14. Dependencies / Touch-Points (quick index)

- `lib/jonggrang.js`: `maxTaskNumber` (:503), `addTask` (:512), `addTasksBulk` (:526),
  `findTaskFeature` (:99), `buildTasksFromPlanPrompt` (:~938-1013), `makeTask`,
  `getAllTasks` (:61), `resolveActiveFeature`.
- `bin/jonggrang.js`: `cmdApprove` (:1429), `cmdPlan` (plan flags), task-id commands
  (`task show/update/done/block/remove`), `task import` handler.
- `lib/orchestration.js`: `generateFeatureId` (:408), MANIFEST create/complete.
- `apis/projects/`: `approve.js` (:10), `plan.js` (plans list/draft), a new extend
  endpoint, `PlanView.vue` + kanban.
- No new npm deps.
