---
feature: main-base-branch-and-push-plans
branch: feat/main-base-branch
work_type: MEDIUM
description: Make jonggrang use a deterministic `main` base branch (create it for repos that have no ref yet), and let plans/tasks/manifest be committed + pushed to that base branch on every update — across repos that already have main/master and repos that are empty.
created_at: 2026-06-03
status: draft
---

# Plan: `main` Base Branch + Push Plans/Tasks to It

## 1. Goal (user's words)

- Test across cases: repos that **already have a ref `main`/`master`**, and repos that **don't have any ref/main yet**.
- For a repo with **no ref/main**: **create `main` first**, so jonggrang's **plan + tasks (+ manifest) can be pushed there on every update**.
- `jonggrang init` currently creates a **`master`** branch → **change it to `main`**.
- Write the plan first, before executing.

## 2. Current behavior / facts

- Host `git config init.defaultBranch` is **unset** → a fresh `git init` ("Fresh Start" projects) creates **`master`**. The agent image also defaults to `master`.
- A clone of an empty GitHub repo adopts the remote's default (`main`), which is why earlier cloned test projects showed `main` — but this is **not guaranteed** (depends on the remote/host config).
- `cmdInit`'s initial-commit block (added for empty repos) does **not** force a branch name → the commit lands on whatever HEAD points to (`master` for fresh `git init`).
- Plans + manifests live in `.jonggrang/.output/` (tracked); the task board in `.jonggrang/jonggrang-tasks.json`. These are the "plan/task state" to push to the base branch.
- Feature branches (per plan) already fork from `HEAD` and push fine (host + in-container).

## 3. Design

### A. Deterministic `main` on init
In `cmdInit`:
- When we create the **initial commit** (empty/fresh repo, no HEAD): make it land on `main`.
  - Prefer `git init -b main` when jonggrang itself initializes the repo; for an already-initialized repo, after the first commit run `git branch -M main` (renames the current unborn/first branch → `main`).
  - Optionally set repo-local `git config init.defaultBranch main`.
- When the repo **already has history** (HEAD exists): **do not rename** — respect the existing branch (`main` or `master`). That existing branch is the base.

### B. Resolve the base (integration) branch
New `lib.resolveBaseBranch(projectRoot)`:
1. current branch if it is `main` or `master`,
2. else `main` if it exists,
3. else `master` if it exists,
4. else `main` (to be created).
This is the branch that carries plans/tasks/manifest. Feature-branch worktrees keep forking from `HEAD` (= base after checkout).

### C. Commit + push plans/tasks/manifest to the base branch
The "save plans to main" capability (original requirement #1):
- `lib.commitBaseState(projectRoot, message, { run })` — on the base branch, `git add` the tracked plan/task state (`.jonggrang/.output/`, `.jonggrang/jonggrang-tasks.json`, `.jonggrang/progress.txt`) and commit if dirty.
- Push the base branch to `origin` (creates remote `main` if absent). Reuse the existing push path: host `lib.pushBranch`, or in-container `pushBranchCtx` for sandbox (in-container ssh when available, else host fallback).
- **When**:
  - **Local auto-commit** of plan/task state on each update (after `plan`, `approve`, and task status changes) — cheap, keeps history.
  - **Push** is an explicit **"Push plans" button** (base/main) — avoids push-spam on every keystroke. (Open question §6.)
- For a **no-ref repo**: ensure `main` exists (from §A), then the first push creates `origin/main`.

### D. Web surface
- New endpoint `POST /api/projects/:id/base/push` → ensures base branch, commits plan/task state, pushes it. Returns `{ branch, pushed }`.
- New endpoint `GET /api/projects/:id/base` → `{ branch, ahead, has_remote, last_pushed? }` for the UI.
- UI: a **"Push plans → main"** button (Plan view header and/or Parallel Run header), with the base branch name shown. Socket event `base.pushed`.

## 4. Testing matrix (host + sandbox)

| # | Repo state | Expected |
|---|---|---|
| 1 | Existing **`main`** (with history) | base = `main`; push plans updates `origin/main` (fast-forward) |
| 2 | Existing **`master`** (no main) | base = `master`; push updates `origin/master`; **no forced rename** |
| 3 | **Empty remote** (no ref) | init creates initial commit on **`main`**; push creates `origin/main`; plans/tasks pushable |
| 4 | **Fresh Start** (no remote) | `main` created locally; "Push plans" reports "no remote" cleanly |

For each: run a parallel run, then push plans to base + push a feature branch; verify on remote (gh). Do case 3 in **sandbox** too (in-container push to `main`).

## 5. File changes
- `bin/jonggrang.js` `cmdInit`: force `main` (init `-b main` / `git branch -M main` after initial commit; set repo `init.defaultBranch`). Only when jonggrang creates the commit; never rename a populated repo.
- `lib/jonggrang.js`: `resolveBaseBranch(projectRoot)`, `commitBaseState(projectRoot, message)`; reuse `pushBranch`/`gitHead`.
- `apis/projects/orchestration-run.js` (or a small new `base.js`): `GET/POST /:id/base[/push]`, sandbox-aware push (reuse `pushBranchCtx`).
- Client: "Push plans → main" button + store/socket wiring.
- Auto-commit hook on plan/approve/task-update (server-side post-step, local commit).
- Docs: `docs/JONGGRANG.md` (base-branch + state push), `docs/CONFIG.md` if a setting is added (e.g., default base branch name), `README` if a command/flag surfaces.

## 6. Decisions (confirmed by user 2026-06-03)
1. **Push cadence** → **explicit "Push plans" button**. Plan/task/manifest are **auto-committed locally** on each update (plan/approve/task change); **push to `origin/main` is manual** via the button. No auto-push.
2. **Existing `master` repos** → **use `master` as-is**. Plans/tasks push to `master`. Never force-rename populated history.
3. **Base branch name** for new/empty/Fresh-Start repos → **always `main`** (forced; not configurable in v1).

## RESULT (implemented + E2E 2026-06-03)
Implemented: `bin/jonggrang.js` forces `main` on the initial commit (`git branch -M main`); `lib/jonggrang.js` adds `resolveBaseBranch` + `commitBaseState` + `baseStateDirty`; `apis/projects/base.js` exposes `GET /:id/base` and `POST /:id/base/push`; `OrchestrationView.vue` has a **"Push plans → <branch>"** button. E2E across 4 repos (created via gh):
- **Case 1** `jg-main-test` (existing main) → base=main; "Push plans" committed `.jonggrang/.output`+tasks.json and pushed to `origin/main`. ✅
- **Case 2** `jg-master-test` (existing master) → base=**master** (no main forced); pushed to `origin/master`. ✅
- **Case 3** `jg-empty-test` (empty, no ref) → init created initial commit on **main**; "Push plans" created `origin/main` with the plan state. ✅
- **Case 4** Fresh Start (no remote) → init created **main**; "Push plans" button **disabled** (no remote), base resolved as main. ✅

## 7. Assumptions
- New/empty/fresh repos → base branch is **`main`** (forced via init).
- Existing repos → respect their `main`/`master` (resolveBaseBranch); never rename.
- Plans/tasks/manifest committed to the base branch (auto, local) and pushed there only on the button; feature branches stay separate (no auto-merge).
- Push reuses existing host/in-container logic (in-container ssh when available, host fallback); never force-push.
