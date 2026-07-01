---
feature: per-feature-task-state
branch: feat/per-feature-task-state
work_type: MEDIUM
description: Move jonggrang-tasks.json and progress.txt from the flat global location (.jonggrang/) into .jonggrang/.output/features/<feature_id>/, replacing in-memory feature_id filtering with per-feature file isolation. Implements the proposal agreed in issue #64.
created_at: 2026-06-23
status: draft
---

# Plan: Per-Feature Task & Progress State

Implements the proposal posted in [issue #64](https://github.com/porcupine-md/jonggrang/issues/64#issuecomment-4777318326).

## 1. Goal

Today `jonggrang-tasks.json` and `progress.txt` live once at the repo root and hold state for **all** features, separated only by a `feature_id` field on each task. This plan moves both files to be **per-feature**, colocated with the artifacts that already live under `.jonggrang/.output/features/<feature_id>/` (plan.md, MANIFEST.yaml, bugs.md, phase outputs).

After this change:
- One feature = one `jonggrang-tasks.json` + one `progress.txt`, scoped to that feature's folder.
- The defensive `feature_id == null` / `__legacy__` / `__default__` filtering is deleted — a feature's file *is* its filter.
- Multiple features can coexist in one repo without overwriting each other's task board (in addition to the existing worktree isolation).

## 2. Decisions (confirmed in discussion, 2026-06-23)

| Question | Decision |
|---|---|
| Folder convention | `.jonggrang/.output/features/<feature_id>/jonggrang-tasks.json` and `.../progress.txt` — colocated with plan.md/MANIFEST. |
| Resolver style | **Option A** — a `tasksFileFor(featureId)` / `progressFileFor(featureId)` resolver function. No implicit "active feature" state. Every call site passes the feature id explicitly. |
| Aggregate reads | A new `getAllTasks(projectRoot)` helper globs `features/*/jonggrang-tasks.json` and merges for cross-feature views (status, list). |
| `progress.txt` | **Per-feature** — moves into the feature folder alongside tasks. |
| Counts (pending/total/completed) | **Per-feature**. The work loop reports progress for the feature it is executing, not a global aggregate. |
| `feature_id` field on tasks | Kept on the task object (redundant with the folder, but cheap, stable, and already referenced by prompts/manifest). Not used for filtering anymore. |
| #49 (closed) | Left closed. This plan supersedes its intent and is tracked under #64. |
| #64 original spec (`plans/<plan-id>/` + per-plan numbering + 1-plan-multi-feature) | **Deferred.** This plan only does the per-feature isolation. The plan-vs-feature model split is a separate, larger change. |
| Task-id commands (show/update/done/block/remove) feature resolution | **Auto-lookup via `getAllTasks`.** Find the task across all feature files, read its `feature_id`, then operate on that feature's file. UX stays backward-compatible (`jonggrang task done task-005` works with no flag). |
| `task add` / `task next` (no task-id) | **Default to most-recent-incomplete feature** (mirror `findIncompleteManifest` ordering: MANIFEST status running/paused/failed, newest `updated_at`). `--feature <id>` overrides. |
| Migration trigger | **Only in `jonggrang init`.** No dedicated `migrate` subcommand, no lazy auto-migrate. `init` detects a stale root `jonggrang-tasks.json`/`progress.txt` and splits it per-feature in place. Other commands do NOT warn or auto-convert. |

## 3. Current state (verified)

- **Tasks file is flat and global.** `lib/jonggrang.js:35` — `tasksFile: path.join(jonggrangDir, 'jonggrang-tasks.json')`. Consumed once as `TASKS_FILE` at `bin/jonggrang.js:46` and passed to ~40 call sites.
- **`progress.txt` is flat and global.** `lib/jonggrang.js:37` — `progressFile: path.join(jonggrangDir, 'progress.txt')`.
- **lib layer is already parametrized.** Every task function (`getTasks`, `addTask`, `updateTaskStatus`, `countPending`, `groupPlans`, …) takes `tasksFile` as a parameter. No global read inside lib. → zero changes needed to the function bodies; only the *path passed in* changes.
- **`plan.md` already follows the target convention.** Archived to `.jonggrang/.output/features/<feature_id>/plan.md` at approve time (`bin/jonggrang.js:1391-1393`). The folder pattern we want for tasks already exists.
- **MANIFEST already follows the target convention.** `lib/orchestration.js:120-121` `getManifestPath(projectRoot, featureId)` → `.jonggrang/.output/features/{featureId}/MANIFEST.yaml`. `findIncompleteManifest` (`lib/orchestration.js:427`) already `readdir`s `features/*/MANIFEST.yaml` — the exact glob pattern we will reuse for tasks.
- **Defensive filtering that becomes obsolete:**
  - `bin/jonggrang.js:802-805` — `cmdStatus` groups by `task.feature_id || '__legacy__'`.
  - `bin/jonggrang.js:1344-1349` — `cmdApprove` purges orphan tasks (`feature_id == null`) before decompose.
  - `bin/jonggrang.js:1369-1378` — `cmdApprove` stamps `feature_id` onto newly created tasks (because the agent may set the bare slug).
  - `lib/jonggrang.js:1825` — `groupPlans` uses `task.feature_id || '__default__'`.
- **Agent prompts that name the tasks file path:** `buildDraftPlanPrompt` (`lib/jonggrang.js:526`), `buildTasksFromPlanPrompt` (`:638`), `buildPlanPrompt` (`:710`), `buildBugsToTasksPrompt` (`:2046`). Plus `buildWorkPrompt` (`:441`) names `.jonggrang/progress.txt` and the feature's `plan.md` path.
- **Git base-state tracking.** `lib/jonggrang.js:1945` — `BASE_STATE_PATHS = ['.jonggrang/.output', '.jonggrang/jonggrang-tasks.json', '.jonggrang/progress.txt']`. The `.output` glob already covers the new locations, so the two explicit entries become redundant once files move.
- **Init / validate.** `lib/jonggrang.js:1541` writes a root `jonggrang-tasks.json` on `init`; `:109` `validateTasksFile` returns invalid if missing; `:129` `validateProjectState` requires it.
- **Web dashboard.** `lib/web-state.js:246` and `:301` hardcode `path.join(projectPath, '.jonggrang', 'jonggrang-tasks.json')`.
- **Work loop feature resolution.** `bin/jonggrang.js:543-549` resolves the active `feature_id` from the first task in `GROUP_TASK_IDS` (explicitly *not* via `findIncompleteManifest`). This is the hook point for resolving the per-feature tasks path during `jonggrang work`.

## 4. Target convention

```
.jonggrang/.output/features/<feature_id>/
├── jonggrang-tasks.json     ← NEW (moved from .jonggrang/)
├── progress.txt             ← NEW (moved from .jonggrang/)
├── plan.md                  ← existing
├── MANIFEST.yaml            ← existing
├── bugs.md                  ← existing
└── {phase}-{role}-output.json   ← existing
```

The root `.jonggrang/jonggrang-tasks.json` and `.jonggrang/progress.txt` are **no longer created or read** by new code. A migration step (§5.9) handles legacy repos.

## 5. Implementation

### 5.1 Resolver layer — `lib/jonggrang.js`

Add three functions near `getProjectPaths`:

```js
// Per-feature state paths. featureId is required (callers resolve it before calling).
function tasksFileFor(projectRoot, featureId) {
  return path.join(projectRoot, '.jonggrang', '.output', 'features', featureId, 'jonggrang-tasks.json');
}
function progressFileFor(projectRoot, featureId) {
  return path.join(projectRoot, '.jonggrang', '.output', 'features', featureId, 'progress.txt');
}

// Merge every feature's tasks file into one view, keyed by feature_id.
// Used only by cross-feature views (cmdStatus, cmdList, dashboard).
function getAllTasks(projectRoot) {
  const featuresDir = path.join(projectRoot, '.jonggrang', '.output', 'features');
  if (!fileExists(featuresDir)) return { tasks: [] };
  const merged = { tasks: [] };
  for (const name of fs.readdirSync(featuresDir)) {
    const p = tasksFileFor(projectRoot, name);
    if (!fileExists(p)) continue;
    const data = readJSON(p);
    if (Array.isArray(data?.tasks)) merged.tasks.push(...data.tasks);
  }
  return merged;
}
```

Keep `paths.tasksFile` / `paths.progressFile` in `getProjectPaths` **only** for the legacy migration read in `cmdInit` (§5.7). All other code stops using them.

Export the three new functions.

### 5.2 Call-site migration — `bin/jonggrang.js`

Remove the module-level `const TASKS_FILE = paths.tasksFile;` and `const PROGRESS_FILE = paths.progressFile;` constants. Replace each usage with a resolver call that takes the feature id known at that point.

Feature id is already resolvable at every call site:

| Command | How feature id is known |
|---|---|
| `cmdWork` | `firstTask.feature_id` (already resolved at `:549`). For worktree planning, iterate `groupPlans` results — each carries `featureId`. |
| `cmdApprove` | `featureId` generated at `:1341` before decompose. |
| `cmdStatus` / `cmdList` | Cross-feature — use `getAllTasks`. Per-feature drilldown uses the group key. |
| `cmdTask show/update/done/block/remove` (task-id present) | **Auto-lookup**: `getAllTasks` finds the task, read `task.feature_id`, resolve `tasksFileFor(root, fid)`. No `--feature` flag needed. |
| `cmdTask add` / `cmdTask next` (no task-id) | Default to most-recent-incomplete feature (mirror `findIncompleteManifest`). `--feature <id>` overrides. |
| `cmdBug` | `feat.featureId` (already resolved). |
| `cmdReview` | Task's `feature_id` (auto-lookup like task-id commands). |

For `cmdTask add`/`next` without a task-id, add a `--feature <id>` flag whose default is the most-recent-incomplete feature (same ordering as `findIncompleteManifest`: MANIFEST status in `running|in_progress|paused|failed`, sorted by `updated_at` desc). Document in README + `docs/CONFIG.md`. For `cmdTask show/update/done/block/remove`, no flag — auto-resolve via `getAllTasks` lookup on the task-id.

### 5.3 Delete obsolete defensive code

After files are per-feature, remove:

- `bin/jonggrang.js:802-805` — the `__legacy__` grouping branch in `cmdStatus`. Replace with `getAllTasks` + group by the source feature folder (or `task.feature_id`).
- `bin/jonggrang.js:1344-1349` — orphan purge in `cmdApprove`. A fresh feature file starts empty; nothing to purge.
- `bin/jonggrang.js:1369-1378` — `feature_id` stamping loop in `cmdApprove`. The decompose agent writes directly to the feature file; `feature_id` is set by the prompt (§5.5) and reinforced by the folder.
- `lib/jonggrang.js:1825` — `__default__` fallback in `groupPlans`. A task without a feature id is a bug, not a default group.

### 5.4 Aggregate views

- `cmdStatus` (`bin/jonggrang.js:789`) and `cmdList` (`:3050`): switch to `getAllTasks`. Group by `task.feature_id` (or by the folder name read during the glob). The single-feature vs multi-feature display branches stay; the data source changes.
- Counts in the work loop (`:602, :656, :714, :724, :786`): switch to per-feature counts via `countPending(tasksFileFor(root, fid))` etc. The progress line becomes "Progress: X/Y tasks for <feature>".
- `getTaskGroups` / `groupPlans` (`lib/jonggrang.js:1632, 1817`): these already filter runnable tasks. `groupPlans` must read across features for multi-feature worktree planning — feed it `getAllTasks` instead of a single file. Within a feature, behavior is unchanged.

### 5.5 Agent prompts — inject feature-scoped paths

Update the 4 prompt builders so the agent reads/writes the feature file and reads the feature progress log. Each already receives or can receive `featureId`:

- `buildDraftPlanPrompt(description, configFile, projectRoot, featureId)` — read `tasksFileFor(root, featureId)` for existing-task context (usually empty for a new plan). Update prompt text: "Read existing tasks at `.jonggrang/.output/features/<feature_id>/jonggrang-tasks.json`".
- `buildTasksFromPlanPrompt(planContent, configFile, projectRoot, featureId, skillsDir)` — the decompose agent must **write** tasks to `tasksFileFor(root, featureId)`. State this path explicitly in the prompt. Drop the "stamp feature_id" instruction in `cmdApprove` since the path carries it.
- `buildPlanPrompt(...)` and `buildBugsToTasksPrompt(openBugs, featureId, configFile, projectRoot)` — same treatment.
- `buildWorkPrompt` (`lib/jonggrang.js:471-476`): change the context-files block to
  ```
  - .jonggrang/.output/features/<feature_id>/progress.txt (learnings for this feature)
  - .jonggrang/.output/features/<feature_id>/plan.md (feature plan — archived after approval)
  ```
  Drop the note about `.jonggrang/plan.md` not existing (still true, but the path shown is now feature-scoped). Update step 8 ("Append learnings to …") to the feature progress path.

Signature changes (adding `projectRoot` where missing) ripple to call sites in `bin/jonggrang.js:1161, 1173, 1180, 1204, 1362, 1608`.

### 5.6 Init / validate relaxation

- `cmdInit` (`lib/jonggrang.js:1538-1548`): stop creating a root `jonggrang-tasks.json` and root `progress.txt`. These are created on demand when a feature is first approved. `init` only writes `jonggrang.json` + skills + `.gitignore`.
- `validateTasksFile` / `validateProgressFile` (`:109, :117`): relax — missing is **valid** (means "no feature yet"). Only `corrupt`/`unreadable` are invalid.
- `validateProjectState` (`:129`): drop the tasks/progress requirement; require only config. `ensureInit` (`bin/jonggrang.js:960`) stops auto-regenerating root files.
- The `cmdInit` "regenerate jonggrang-tasks.json" warnings (`bin/jonggrang.js:975, 980`) and the `doctor`/validate lines (`:1718, :1731, :1846`) are updated or removed.

### 5.7 Git base-state tracking — simplify

`lib/jonggrang.js:1945`:

```js
// Before
const BASE_STATE_PATHS = ['.jonggrang/.output', '.jonggrang/jonggrang-tasks.json', '.jonggrang/progress.txt'];
// After
const BASE_STATE_PATHS = ['.jonggrang/.output'];
```

Both tasks and progress now live under `.output/features/<id>/`, already covered by the `.output` glob. `commitBaseState` / `baseStateDirty` need no other changes.

### 5.8 Web dashboard — `lib/web-state.js`

- `:246` and `:301`: replace the single-file read with `getAllTasks(projectPath)`. The dashboard already renders tasks grouped; feed it the merged view.
- If the dashboard exposes per-feature drilldown in the future, it can read `tasksFileFor(projectPath, featureId)` directly.

### 5.9 Backward compatibility / migration

**Trigger: only `jonggrang init`.** No dedicated `migrate` subcommand, no lazy auto-migrate from other commands.

On `jonggrang init` in a repo that still has root `.jonggrang/jonggrang-tasks.json` (and/or root `progress.txt`):

- Read the legacy root tasks file, group tasks by `feature_id`, and write each group to `tasksFileFor(root, fid)`. Tasks with `feature_id == null` are written to a synthetic `legacy-<timestamp>` feature folder and the user is warned.
- The root `progress.txt` is copied into every existing feature folder (learnings are global anyway; per-feature split is not worth the parsing complexity). Then the root copy is deleted.
- After migration, root `jonggrang-tasks.json` and `progress.txt` are deleted. `BASE_STATE_PATHS` no longer references them.
- `cmdInit --force` on a fresh repo writes nothing for tasks/progress.
- Migration is idempotent: if root files don't exist, it's a no-op.

Other commands (`work`, `status`, `task`, …) do **not** detect or warn about stale root files — the user is expected to run `init` once after upgrading. This keeps the happy path free of surprise state mutations.

### 5.10 Docs (required by AGENTS.md)

- `docs/CONFIG.md` — update the state-structure section (`:319`) and the `output_dir` description. Document that tasks/progress are per-feature.
- `docs/JONGGRANG.md` — update the Project File Structure table (`:578`) and the per-feature folder listing.
- `docs/PHILOSOPHY.md` — Persistent State section: note tasks/progress are feature-scoped, consistent with plan.md/MANIFEST.
- `docs/WORKFLOW.md` — update the archive step (`:31`) to show tasks/progress landing in the feature folder.
- `README.md` — only if the `--feature` flag on `task` commands surfaces; otherwise no change.
- Add a closing comment on issue #64 linking this plan.

## 6. Acceptance criteria

- [ ] `tasksFileFor(root, fid)` and `progressFileFor(root, fid)` resolve to `.jonggrang/.output/features/<fid>/…` and are used by all call sites that previously used `TASKS_FILE` / `PROGRESS_FILE`.
- [ ] `getAllTasks(root)` merges every feature's tasks file; `cmdStatus` and `cmdList` render the merged view grouped by feature.
- [ ] No code path writes or reads root `.jonggrang/jonggrang-tasks.json` or root `.jonggrang/progress.txt` (except the one-shot migration read).
- [ ] The four `build*Prompt` functions and `buildWorkPrompt` inject feature-scoped paths into agent prompts; the decompose agent writes to the feature file.
- [ ] The `__legacy__` / `__default__` / `feature_id == null` defensive branches are deleted.
- [ ] `cmdInit` no longer creates root tasks/progress files; `validateProjectState` no longer requires them.
- [ ] `BASE_STATE_PATHS = ['.jonggrang/.output']`; `commitBaseState` still commits feature state.
- [ ] Work-loop progress counts are per-feature.
- [ ] `lib/web-state.js` serves a merged task view.
- [ ] Migration: a repo with legacy root files is migrated on `init`/`migrate`; root files deleted; behavior preserved.
- [ ] Docs (`CONFIG`, `JONGGRANG`, `PHILOSOPHY`, `WORKFLOW`) updated.

## 7. Out of scope (deferred)

These belong to #64's original spec but are explicitly **not** in this plan:

- `plans/<plan-id>/` directory hierarchy with features as subdirectories.
- Per-plan task numbering (`<plan-id>#<task-num>`).
- One plan spanning multiple features.
- Real-time conflict resolution between parallel plans touching the same files.

Rationale: per-feature isolation unblocks safe parallel features within one repo and satisfies the core intent of #49/#64. The plan-vs-feature model split is a larger conceptual change that should be proposed separately only if a real need for one-plan-multi-feature emerges.

## 8. References

- Issue #64 — https://github.com/porcupine-md/jonggrang/issues/64
- Proposal comment — https://github.com/porcupine-md/jonggrang/issues/64#issuecomment-4777318326
- Issue #49 (closed, superseded) — per-feature isolation request.
- `docs/plans/2026-06-08-per-plan-work-mode.md` — prior per-feature scoping work (UI/worktree).
- `docs/plans/2026-06-11-output-file-manifest.md` — established the `features/<id>/` output convention this plan extends.
