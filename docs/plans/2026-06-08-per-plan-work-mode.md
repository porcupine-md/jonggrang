---
feature: per-plan-work-mode
branch: feat/per-plan-work-mode
work_type: LARGE
description: Restructure web UI — remove the global "Parallel Run" menu and fold orchestration into a per-plan Work Mode (Pipeline / Tasks / Logs / Changes scoped to one plan), with Agent & Terminal following the plan's worktree. Backend parallelism is unchanged; only the surface becomes per-plan.
created_at: 2026-06-08
status: draft
---

# Plan: Per-Plan Work Mode (fold Parallel Run into plan detail)

## 1. Goal (in the user's words)

- Tasks and Pipeline are **part of each plan** — a separate "Parallel Run" menu is confusing because everything it shows is about the tasks of one plan anyway.
- **The parallel process stays** — multiple plans still run concurrently in the backend (worktree + branch per plan). Only the navigation changes.
- In plan detail, after a plan is approved, the **"Check Progress"** button becomes **"Work Mode"** and leads into a per-plan work mode.
- Work Mode (per plan) has menus:
  - **Pipeline** — the phases of *that* plan's MANIFEST.
  - **Tasks** — only the tasks worked by that pipeline (that plan).
  - **Logs** — the logs of that plan's pipeline/tasks while it runs.
  - **Changes** — changed files of that plan's worktree, with the **Push** button that today lives in the Orchestration view.
- **Agent & Terminal**: in plan mode they target the container / project root (as today); in Work Mode they target **that plan's worktree**.

## 2. Decisions (confirmed in discussion, 2026-06-08)

| Question | Decision |
|---|---|
| How does a plan's run start? | **"Run" button inside Work Mode** — per plan. Other plans can be run from their own Work Mode; backend keeps them parallel. |
| Agent/Terminal before the run starts? | **Worktree is created on entering Work Mode** (if missing). The later run reuses it. Agent/Terminal usable immediately. |
| Changes tab actions | **Push only** (push branch to remote), same behavior as today's Orchestration push — just relocated. Merge happens via PR on the remote. |
| Overview of all running plans | **Status badge per plan in the plan list** (running/done/failed + live chip). No separate overview page. |

## 3. Current state (verified)

- **Tasks carry `feature_id`** — `lib/jonggrang.js:1696-1726` (`groupPlans`) groups runnable tasks by `task.feature_id`; branch comes from the plan's `plan.md` frontmatter. Per-plan filtering is therefore cheap.
- **Manifest is already per plan**: `.jonggrang/.output/features/<feature_id>/MANIFEST.yaml`.
- **Worktrees are per plan**: `.jonggrang/.worktree/<feature_id>/`, created by `apis/projects/orchestration-run.js` (`git worktree add -b <branch> <path>`); container mode uses `docker exec --workdir`.
- **Orchestration run state** lives in `apis/projects/orchestration-run.js` (`run.groups[featureId]` → status/log/pushed), streamed via `orchestration.group.*` socket events; client store `client/src/stores/orchestration.js`.
- **Diff + Push** are in `client/src/views/OrchestrationView.vue` (`GET .../groups/:featureId/diff`, `POST .../groups/:featureId/push`).
- **"Check Progress"** button: `client/src/components/plan/PlanView.vue:224-228`, gated by `canGoToWork` (`:374`), navigates to `/projects/:id/tasks`.
- **Sidebar / routes**: `client/src/views/ProjectDetailView.vue:9-35`, `client/src/router/index.js` — work-mode items (`pipeline`, `tasks`, `orchestrate`, `logs`) are project-global, toggled by project-level `derived_state` (`lib/web-state.js:177-209`).
- **PTY (Agent/Terminal)**: `apis/projects/pty.js` spawns in `project.path` (or container project root); session keys are `'terminal'`/`'agent'` per project — **no worktree awareness**.
- **Tasks API** (`apis/projects/tasks.js`) returns all tasks unfiltered; Kanban store (`client/src/stores/tasks.js`) has no plan filter.
- **"Push plans → base branch"** button also lives in OrchestrationView (`POST /api/projects/:id/base/push`).

## 4. Target UX

### Routes

```
/projects/:id/plan                      Plan list + editor (unchanged home)
/projects/:id/changelog                 unchanged
/projects/:id/agent                     project-scope agent  (container / project root)
/projects/:id/terminal                  project-scope terminal
/projects/:id/settings                  unchanged

/projects/:id/plans/:featureId/         → redirect to pipeline
/projects/:id/plans/:featureId/pipeline Work Mode: phases of this plan's MANIFEST
/projects/:id/plans/:featureId/tasks    Work Mode: Kanban filtered to feature_id
/projects/:id/plans/:featureId/logs     Work Mode: this plan's group log stream
/projects/:id/plans/:featureId/changes  Work Mode: changed files + diff + Push
/projects/:id/plans/:featureId/agent    Work Mode: agent PTY, cwd = worktree
/projects/:id/plans/:featureId/terminal Work Mode: terminal PTY, cwd = worktree
```

Removed: `/projects/:id/orchestrate`, project-level `/pipeline`, `/tasks`, `/logs` (all are plan-scoped now).

### Sidebar

- **Project scope** (always): Plan, Changelog · Agent, Terminal, Settings · sandbox panel + meta (unchanged).
- **Work Mode scope** (when route matches `/plans/:featureId/...`): header shows plan title + branch + run status; nav = `← Plans`, Pipeline (chip `done/active`), Tasks, Logs (chip `live` when running), Changes (chip = changed-file count), Agent, Terminal. Sandbox panel stays visible.

### Plan list (PlanView)

- Each approved plan row: status badge (`approved` / `running` ⟶ live chip / `done` / `failed`, from manifest status + active run state) and a **"Work Mode"** button (replaces "Check Progress") → `/projects/:id/plans/:featureId/pipeline`.
- Draft plan: unchanged (edit / approve flow).
- **"Push plans → base branch"** button moves from OrchestrationView to PlanView header (it's about plan files, not a run).

### Work Mode behavior

- On enter: `POST /api/projects/:id/plans/:featureId/worktree` (idempotent ensure — create worktree + branch if missing, reuse orchestration's existing helper incl. container path mapping).
- **Run button** in the Work Mode header: `POST /api/projects/:id/orchestration/groups/:featureId/start` — starts *this* group only. While running: Cancel button (`.../groups/:featureId/cancel`). Run survives navigation (same in-memory run registry as today).
- Logs view subscribes to `orchestration.group.log` filtered by `feature_id` (history replayed from `run.groups[fid].log` on fetch).
- Changes view = extracted diff drawer from OrchestrationView (file list, per-file diff, Push button + pushed state).

## 5. Implementation tasks

### Phase A — Backend (per-group orchestration + worktree ensure)

- [ ] **A1** `apis/projects/orchestration-run.js`: refactor `startRun` so a run is a registry that groups can join incrementally. Add `POST /orchestration/groups/:featureId/start` (start one group; 409 if already running) and `POST /orchestration/groups/:featureId/cancel`. Keep `GET /orchestration` (now also reports per-group status for badges). The old all-groups `POST /orchestration/start` endpoint and `cancel` may stay for compat but the UI stops calling them.
- [ ] **A2** Extract a `ensureWorktree(project, featureId)` helper (host + container modes) from the current run path; expose `POST /api/projects/:id/plans/:featureId/worktree` (idempotent). Group start reuses it.
- [ ] **A3** `apis/projects/plan.js`: plans list response includes per-plan `run_status` (from active run registry) + `branch`, so PlanView can render badges without an extra call.
- [ ] **A4** `apis/projects/tasks.js`: support `?feature_id=` filter (and ensure `feature_id` is in the returned task objects).
- [ ] **A5** `apis/projects/pty.js`: accept optional `feature_id` on `/terminal/start` & `/agent/start`. When present: cwd = worktree path (container: mapped path via `docker exec --workdir`), and the session key becomes `'<session>:<feature_id>'` so project-scope and per-plan PTYs coexist.
- [ ] **A6** Manifest endpoint: ensure manifest fetch takes `feature_id` (today the client fetches one manifest per project — verify and parameterize: `GET /api/projects/:id/manifest?feature_id=...`).

### Phase B — Client (routing + Work Mode shell)

- [ ] **B1** `client/src/router/index.js`: add `plans/:featureId` children (pipeline/tasks/logs/changes/agent/terminal); remove `orchestrate` and project-level `pipeline`/`tasks`/`logs` routes.
- [ ] **B2** `client/src/views/ProjectDetailView.vue`: sidebar switches on route (`/plans/:featureId/` ⇒ Work Mode nav) instead of `derived_state`; Work Mode header (plan title, branch, run status, Run/Cancel button); on entering Work Mode call the worktree-ensure endpoint.
- [ ] **B3** `client/src/components/plan/PlanView.vue`: rename "Check Progress" → "Work Mode" (per approved plan row, navigate to its work mode); add per-plan status badges; move the base-branch "Push plans" button here.
- [ ] **B4** New `client/src/views/plan-work/ChangesView.vue`: extract file list + diff + Push from OrchestrationView (per `:featureId`).
- [ ] **B5** Logs: reuse `LogStream`/group log rendering scoped by `feature_id` (live + replay).
- [ ] **B6** Tasks: `stores/tasks.js` + KanbanBoard accept a `feature_id` filter (route param).
- [ ] **B7** Pipeline: `stores/manifest.js` + PipelineView fetch by `feature_id` from the route.
- [ ] **B8** Agent/Terminal views: pass `feature_id` from route (if present) to PTY start; keep separate xterm instances per scope so project terminal and plan terminal don't fight over one socket session.
- [ ] **B9** Delete `OrchestrationView.vue` + the `orchestrate` nav entry; prune now-unused parts of `stores/orchestration.js` (keep group state/socket handling — Work Mode uses it).

### Phase C — Cleanup + docs

- [ ] **C1** `derived_state` (`lib/web-state.js`): still used for plan-list badges/init flow; remove the now-dead work-mode menu switching semantics if nothing else consumes them.
- [ ] **C2** Docs per CLAUDE.md iron rule: `docs/UI.md` (menu structure, routes, Work Mode), `docs/JONGGRANG.md` (web dashboard / orchestration section), `docs/WORKFLOW.md` if it references the web Parallel Run flow, `README.md` only if it mentions the dashboard menus.
- [ ] **C3** Manual verification: approve 2 plans → enter Work Mode of each → Run both → confirm parallel execution, scoped logs/tasks/pipeline, per-plan terminal cwd (host + sandbox container), diff + push per branch, badges in plan list, run survives page navigation.

## 6. Non-goals / unchanged

- No CLI changes; `jonggrang work`/`approve` behavior untouched.
- Backend parallel mechanics (worktree-per-plan, branch-per-plan, dependency ordering inside a plan) unchanged.
- No auto-merge; Push-to-remote only (PR happens on the remote).
- Sandbox lifecycle (gate, start/stop/rebuild) unchanged.

## 7. Risks / notes

- **PTY session keys**: changing the key scheme (A5) must not break existing project-scope sessions — default (no `feature_id`) keeps today's keys.
- **Worktree on enter** can create branches the user never runs — acceptable; `git worktree remove`/prune flow already exists for completed runs (verify cleanup path still triggers only after push or explicit cleanup, never on navigation).
- **Run registry refactor (A1)** is the riskiest piece — preserve the "run survives navigation" guarantee and the rate-limiter/commit behavior from `fix/simplify-sandboxworktree`.
- Old links/bookmarks to `/projects/:id/tasks` etc. will 404 — optional: redirect project-level `tasks`/`pipeline` to the plan list.
