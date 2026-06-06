---
feature: parallel-orchestration-worktree-push
branch: feat/parallel-orchestration
work_type: LARGE
description: Web/client parallel orchestration — run each plan (feature) as an isolated git worktree + branch in parallel, respecting intra-plan dependencies, then review changed files per plan and push each branch to remote.
created_at: 2026-06-03
status: draft
---

# Plan: Parallel Orchestration via Worktrees + Per-Branch Push

## 1. Goal (in the user's words)

- When planning/approving, plans + manifests are **tracked in git** (not ignored) so the user can **Push** them to a remote branch.
- When working, **every plan (task group) runs in parallel**. Dependency detection first:
  - A plan's tasks that have `blocked_by` are done **serially** (dependency first).
  - Tasks/plans **without** dependencies run **directly / in parallel**.
- Parallelism uses **git worktrees**, one per plan → **one branch per plan**.
- After work finishes, the user **reviews changed files per plan** and **pushes each branch** to remote independently (no auto-merge).
- The run must **survive page navigation** (same guarantee as today's single work process).
- **Branch name is read from each plan's `plan.md` frontmatter** (`branch:`), already present.
- Worktrees live under **`.jonggrang/.worktree/`**, which must be **gitignored** by `jonggrang init`. `.jonggrang/.output/` must stay **tracked**.
- **Do not change any existing CLI command/experience.**

## 2. Confirmed data model (verified against /tmp/test)

- A single `.jonggrang/jonggrang-tasks.json` holds tasks for **multiple plans**. Each task carries `feature_id`.
- Each plan = one feature dir: `.jonggrang/.output/features/<feature_id>/`.
  - `plan.md` frontmatter has `feature`, **`branch`** (e.g. `feat/version-endpoint`), `work_type`, `description`.
  - `MANIFEST.yaml` holds phase state.
- **"Group" = "plan" = all tasks sharing one `feature_id`.** One group → one worktree → one branch (from that plan's `plan.md`).
- Example today: `simple-api-mpxkai0h` (task-001..005) and `version-endpoint-mpxkd2eb` (task-006..009), branches `feat/simple-api` and `feat/version-endpoint`.

## 3. What already exists (reuse, do not rebuild)

- `lib/jonggrang.js`: `getTaskGroups()` (union-find), `createWorktree()`, `removeWorktree()`, `mergeWorktreeBranch()`, `copyToWorktree()` — **exported but unused** (no callers). Building blocks only.
- CLI worker contract: `jonggrang work --worktree --group-tasks <ids> --branch <name>` already:
  - runs unlimited iterations over the given task ids,
  - **skips branch checkout** (assumes it is already inside the worktree on its branch),
  - **emits JSON signals** to stdout (`{type:"task_status",taskId,status}`) instead of writing `tasks.json` (anti-race). `bin/jonggrang.js:237-244`, `497`, `540-558`.
- Persistence pattern (server): `activeWork` Map (detached child) + `wireProjectProcess` (socket room `project:<id>`) + chokidar watcher on `.jonggrang/`. `apis/projects/index.js`.
- `js-yaml` available for frontmatter parsing (`lib/orchestration.js:8`).
- **Work loop does NOT commit** — no `git add/commit/push` anywhere. The orchestrator must commit.

## 4. Architecture

The orchestration **manager** is new and lives **server-side** (keeps CLI untouched). It reuses the existing CLI worker as-is.

```
POST /api/projects/:id/orchestration/start
  │
  ├─ groupPlans(tasks.json, projectRoot)        # group runnable tasks by feature_id
  │     → [{ featureId, branch, title, taskIds(ordered by blocked_by+priority) }]
  │
  ├─ for each plan (IN PARALLEL):
  │     1. createWorktree(root, featureId, baseBranch, { dir: .jonggrang/.worktree/<featureId>, branch })
  │     2. spawn `jonggrang work --worktree --group-tasks <ids> --branch <branch>`  (cwd = worktree)
  │     3. wire stdout:
  │          • JSON {type:"task_status"} → lib.updateTaskStatus(MAIN tasks.json)   ← single writer
  │          • emit socket `orchestration.group.log` {group_id, line}
  │     4. on child close (exit 0):
  │          • commitWorktree(worktreePath, "feat(<feature>): <title>")  (no-op if clean)
  │          • mark group done, emit `orchestration.group.completed`
  │        on non-zero exit → `orchestration.group.failed`
  │
  └─ when all groups settle → `orchestration.completed`
```

- **Single writer**: only the orchestrator parent writes `tasks.json` (from parsed signals), so parallel workers never race. Writing `tasks.json` triggers the existing watcher → `tasks.update` → kanban updates live.
- **Navigation persistence**: detached children are kept in an in-memory `activeRuns` map; on socket (re)subscribe, the server replays an `orchestration` snapshot — same guarantee as today's `activeWork` (survives page navigation / socket reconnect; not server restart, matching current behaviour). A lightweight `.jonggrang/.ephemeral/orchestration-run.json` mirrors group metadata for snapshot reconstruction.

## 5. Intra-plan dependency handling

- Within a plan, order task ids by topological order of `blocked_by` then `priority`. Pass that ordered list to `--group-tasks`. The worker processes them serially in order, so dependencies are satisfied before dependents.
- A plan whose tasks are fully independent still runs its tasks in priority order (serial within the single worktree worker) — independence **across plans** is what gives parallelism. This matches "tasks with deps → serial; plans without deps → run directly in parallel."

## 6. Commit + diff + push

- **Commit**: after a group worker exits 0, run `git -C <worktree> add -A` then commit if there is anything staged. Message: `feat(<feature>): <plan title>`. (Agents may not commit; orchestrator guarantees the branch has the work.)
- **Diff / changed files** (`GET /:id/orchestration/groups/:featureId/diff`): from the worktree branch vs `baseSha`:
  - `git -C <worktree> diff --name-status <baseSha>` → file list,
  - `git -C <worktree> diff <baseSha> -- <file>` → per-file patch (lazy/on-demand).
- **Push** (`POST /:id/orchestration/groups/:featureId/push`): `git -C <root> push -u origin <branch>`. Creates/updates the **remote branch of the same name**; never touches `main`/`master` directly. Emits `orchestration.group.pushed`. Because `.jonggrang/.output/` is tracked, the plan + manifest travel with the branch — satisfying "push saves plans + manifest".

## 7. File-by-file changes

### Backend — CLI lib (no command/UX change; functions only)
`lib/jonggrang.js`
- `groupPlans(tasksFile, projectRoot)` — group runnable tasks by `feature_id`; read branch from `.output/features/<id>/plan.md` frontmatter (fallback: tasks.json top-level `branch`, then `jonggrang/<featureId>`); order task ids topologically (`blocked_by`) + priority; return `[{ featureId, branch, title, taskIds, tasks }]`.
- `parseFrontmatter(filePath)` — js-yaml parse of `--- … ---` block (branch, feature, title).
- Extend `createWorktree(projectRoot, groupId, baseBranch, opts={})` — `opts.dir` (default `os.tmpdir()` for back-compat) and `opts.branch` (explicit). Path default → `.jonggrang/.worktree/<groupId>`. If branch already exists, checkout instead of `-b`.
- `commitWorktree(worktreePath, message)`, `worktreeChangedFiles(worktreePath, baseSha)`, `worktreeFileDiff(worktreePath, baseSha, file)`, `pushBranch(projectRoot, branch, remote='origin')`.
- All exported. No existing signature is broken (helpers had no callers).

### Backend — server orchestration
- New `apis/projects/orchestration-run.js` (router + run manager) mounted in `apis/projects/index.js`.
- `apis/projects/index.js`: add `activeRuns` Map to `deps`; include orchestration state in the `subscribed` snapshot; mount the new router.
- Routes: `POST /:id/orchestration/start`, `POST /:id/orchestration/cancel`, `GET /:id/orchestration`, `GET /:id/orchestration/groups/:featureId/diff`, `POST /:id/orchestration/groups/:featureId/push`.
- Socket events: `orchestration.started`, `orchestration.group.started`, `orchestration.group.log`, `orchestration.group.completed`, `orchestration.group.failed`, `orchestration.group.pushed`, `orchestration.completed`.

### Backend — init gitignore
`bin/jonggrang.js` (~1732): append `.jonggrang/.worktree/` to the ignore block. **Keep `.jonggrang/.output/` tracked** (never add it). Idempotent: add the worktree line even if the ephemeral block already exists.

### Frontend — Vue client
- `stores/orchestration.js` (new): run state, groups (`featureId, branch, title, status, taskIds`), per-group log tails, diff cache. Lives in pinia → persists across route changes.
- `stores/ws.js`: register `orchestration.*` handlers → mutate the store; handle snapshot `orchestration` on `subscribed`.
- `composables/useJonggrangApi.js` / `useJonggrangActions.js`: `startOrchestration`, `cancelOrchestration`, `fetchOrchestration`, `fetchGroupDiff`, `pushGroup`.
- New view `views/OrchestrationView.vue` + components `components/orchestration/PlanRunCard.vue` (one card per plan: title, **branch badge**, status, live log tail, "View changes", "Push"), `components/orchestration/GroupDiffDrawer.vue` (changed-files list + per-file diff). Add a "Start parallel run" control.
- Router: add child route `/projects/:id/orchestrate`; add sidebar nav entry in `ProjectDetailView.vue`. **Leave existing kanban/plan/work surfaces unchanged.**

### Docs (per CLAUDE.md iron rule)
- `docs/WORKFLOW.md`, `docs/JONGGRANG.md` (team/parallel section), `docs/PHILOSOPHY.md` (worktree/parallel), `README.md` (if a command/flag surfaces), `docs/CONFIG.md` if any config key is added. Update the state-structure docs to note `.jonggrang/.worktree/` (ignored) and `.jonggrang/.output/` (tracked).

## 8. Decisions / assumptions

- **No auto-merge.** Each plan's branch is independent; user reviews + pushes each.
- **Push target**: `origin/<branch>` (same name); never force-push, never touch `main`/`master`.
- **Branch source**: plan.md frontmatter `branch:` (authoritative). Fallback chain defined above.
- **Worktree base**: forked from current `HEAD` (`baseSha`), which includes tracked `.jonggrang/.output/` (plans + manifests travel with each branch).
- **Persistence**: survives page navigation / socket reconnect (matches today). Not server-restart (out of scope; consistent with current `activeWork`).
- **Orchestrator is the sole `tasks.json` writer** during a run (parses worker signals) — prevents races.
- **Commit granularity**: per-task commits are produced by the AGENT (instructed via `templates/CLAUDE.md.template` "Commit with: git commit -m type(scope): description" + `skills/core/orchestrating-feature`), NOT by the orchestrator. The orchestrator's per-group `commitWorktreeCtx` is only a safety-net that sweeps leftover working-tree changes the agent didn't commit (e.g. task board / progress.txt) so they reach the branch + diff.

## 9. Edge cases

- No remote configured → push returns a clear error surfaced in UI.
- Branch already exists locally/remotely → checkout existing; push updates it (no force).
- Worker fails mid-group → group marked failed, partial commit still available for inspection; other groups unaffected.
- Stale worktree from a previous run → `git worktree prune` + reuse/recreate path under `.jonggrang/.worktree/<featureId>`.
- Single-plan project (top-level `branch` set, one `feature_id`) → one group; behaves like a single worktree run.
- Cancel → SIGTERM→SIGKILL each worker; worktrees left in place for inspection (cleanup is a separate explicit action).

## 10. Verification

- `groupPlans` on /tmp/test yields 2 groups with branches `feat/simple-api`, `feat/version-endpoint`, correctly ordered task ids.
- Start run → two worktrees under `.jonggrang/.worktree/`, two workers in parallel, kanban updates live, navigation away/back keeps the run visible.
- After completion → each branch has a commit; diff endpoint lists changed files; push creates the remote branch.
- Existing CLI (`plan`/`approve`/`work`/`status`/`orchestrate`) unchanged — smoke-test each.
- `.gitignore` after `jonggrang init` contains `.jonggrang/.worktree/` and **not** `.jonggrang/.output/`.
