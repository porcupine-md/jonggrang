---
feature_id: fix-task-graph-live-update-mrp18v0m
feature_name: fix-task-graph-live-update-mrp18v0m
tags: [task-graph, vueflow, reactive-store, pinia, live-updates]
updated_at: 2026-07-17T14:39:47.352Z
---

## Context

The TaskGraphView (VueFlow-based task dependency graph) used a local `ref([])` populated by a direct HTTP GET. It never subscribed to WebSocket `tasks.update` events, so task status changes during orchestration were invisible until a manual page refresh. The KanbanBoard already had the correct pattern — a `computed` backed by the shared Pinia `useTasksStore` with proper `setFeatureFilter` lifecycle management. This feature ports that pattern to TaskGraphView and verifies the full reactive chain end-to-end.

Three tasks in this feature ([task-001](.jonggrang/.output/features/fix-task-graph-live-update-mrp18v0m/jonggrang-tasks.json), [task-002](.jonggrang/.output/features/fix-task-graph-live-update-mrp18v0m/jonggrang-tasks.json), [task-003](.jonggrang/.output/features/fix-task-graph-live-update-mrp18v0m/jonggrang-tasks.json)): implementation, verification, and testing. All completed with no regressions.

## Facts

- **Files involved:** `client/src/views/TaskGraphView.vue`, `client/src/utils/taskGraph.js`, `client/src/stores/tasks.js`, `client/src/stores/ws.js`, `client/src/views/ProjectDetailView.vue`.
- **Store pattern:** `useTasksStore` exposes a `visible` computed that filters `tasks.value` by `featureFilter.value` (set via `setFeatureFilter(fid)`). Both KanbanBoard and now TaskGraphView consume this same `visible` computed.
- **Reactive chain (verified):** WebSocket event → `patchTask`/`replaceAll` in `tasks.js` → `tasks.value` mutation → `visible` computed re-evaluates → TaskGraphView `tasks` computed re-evaluates → `graph` computed calls `buildTaskGraph(tasks.value)` → fresh `{ nodes, edges }` → VueFlow `:nodes`/`:edges` receive new refs → VueFlow diffs by node/edge ID.
- **WebSocket handlers:** `task.started/completed/failed` calls `patchTask(id, { status: ... })`; `tasks.update` bulk calls `replaceAll(tasks)`. Both paths verified to trigger the full chain.
- **Edge styling (applied in `graph` computed, overwriting initial `buildTaskGraph` values):**
  - `animated: target?.status === 'in_progress'` — edges animate when target task is running.
  - `stroke` from `STATUS_STROKE`: completed=#4ade80 (green), in_progress=#fbbf24 (yellow), blocked/failed=#f87171 (red).
  - `markerEnd.color: stroke` — arrow color matches stroke.
- **Node identity:** `buildTaskGraph` uses `task.id` as node `id` and `e-${blockerId}-${task.id}` for edge `id` — stable across recomputations for VueFlow ID-based diffing.
- **`tasksStore.projectId`** must be set via `setProject()` for the `tasks.update` WebSocket bulk handler's project-ID guard to pass. `ProjectDetailView.vue` handles this on mount and project-ID watch.
- **`replaceAll`'s `shallowEqual` gate:** Status-changed objects produce different shallow-equal results, so new objects pass through to `tasks.value` while unchanged tasks preserve identity.
- **`patchTask`** mutates via `tasks.value[idx] = { ...prev, ...patch }` — the spread creates a new object, triggering Vue 3 Proxy reactivity.
- **Feature filter requirement:** Tasks must carry a `feature_id` field from the API for the `visible` computed filter to work.
- **Lifecycle management:** `setFeatureFilter(fid)` on mount + `watch(featureId)`, `setFeatureFilter(null)` on unmount. Mirrors KanbanBoard pattern exactly.

## What Done & Why

**task-001 — Wire TaskGraphView to shared Pinia tasksStore** (implementation, [progress](.jonggrang/.output/features/fix-task-graph-live-update-mrp18v0m/progress.txt)):
- Replaced local `ref([])` with `computed(() => tasksStore.visible)` sourced from `useTasksStore`.
- Replaced direct HTTP fetch with `await tasksStore.fetchTasks(projectId.value)`.
- Added `setFeatureFilter` lifecycle hooks (`onMounted`, `watch(featureId)`, `onUnmounted`).
- Added `onUnmounted` to Vue imports.
- `buildTaskGraph`, `graph` computed, `canRun`, `runTask`, template/styling all left untouched — they already accept a reactive array.
- Why: The local `ref([])` was a disconnected data island. WebSocket events updated the store but TaskGraphView never saw them. Routing through the shared store closes the gap without changing any rendering logic.

**task-002 — Verify reactive graph re-render on task status changes** (verification, [progress](.jonggrang/.output/features/fix-task-graph-live-update-mrp18v0m/progress.txt)):
- Traced the full reactive chain across `TaskGraphView.vue`, `taskGraph.js`, `tasks.js`, `ws.js`, and `ProjectDetailView.vue`.
- Five verification checks all passed: (1) reactive chain trace, (2) no stale copy — `buildTaskGraph` receives live `tasksStore.visible.value`, (3) edge styling logic correct — `animated`, `stroke`, `markerEnd` all derived from target status, (4) fresh array references on each recomputation with stable node/edge IDs, (5) no reactivity pitfalls — `shallowEqual` gate, spread mutation, `projectId` guard all correct.
- KanbanBoard regressions checked: uses same `visible` computed, no per-consumer logic was added.
- No code changes needed.
- Why: The wire-up in task-001 was the only code change; this task confirmed the existing infrastructure (Vue reactivity system, Pinia store, VueFlow) works together correctly end-to-end.

**task-003 — Run test suite and manual smoke test** (testing, [progress](.jonggrang/.output/features/fix-task-graph-live-update-mrp18v0m/progress.txt)):
- Full test suite: 11 suites, 120 tests, all passed (0 failures).
- Full check suite (`npm run check`): 28 passed, 0 failed — typecheck, lint, Vite production build.
- API-level smoke tests against live dev server: Projects API, Tasks API (7 tasks with valid structure), WebSocket connection all responsive.
- Reactive chain re-confirmed from task-002 verification.
- UI browser smoke test not possible in this environment, but the reactive chain from WebSocket → Pinia store → VueFlow props is complete and verified through code trace.
- Why: The changes are minimal (local ref → store-backed computed) and all existing tests + typecheck continue to pass, confirming no regressions.

## Lessons Learned

- The full reactive chain for live updates is: **WebSocket event → `patchTask`/`replaceAll` → `tasks.value` mutation → `visible` computed re-eval → component `tasks` computed re-eval → `graph` computed re-eval → VueFlow `:nodes`/`:edges` new refs**. This is the canonical pattern for any VueFlow-based view that needs live data.
- **`tasksStore.projectId` must be set via `setProject()`** for the `tasks.update` WebSocket bulk handler to work — `ProjectDetailView.vue` handles this on mount and project-ID watch. Missing this step would silently drop WebSocket bulk updates.
- **`visible` computed filters by `feature_id`** — tasks coming from the API must carry this field, otherwise they won't appear in any feature-scoped view.
- **`replaceAll`'s `shallowEqual` gate** correctly passes status-changed objects (new ref) while preserving identity for unchanged tasks — a critical optimization that also happens to be correct for reactivity.
- **`patchTask`'s spread at array index** (`tasks.value[idx] = { ...prev, ...patch }`) triggers Vue 3 Proxy reactivity properly because it replaces the array element with a new object.
- **`onUnmounted(() => tasksStore.setFeatureFilter(null))` cleanup** is important to avoid stale filters when navigating between projects or features — without it, the store retains the last project's feature filter.
- **`buildTaskGraph` returns fresh arrays** on every call — no mutation of previous references. Combined with stable node/edge IDs (`task.id`, `e-${blockerId}-${task.id}`), VueFlow can efficiently diff and only re-render changed nodes/edges.
- **The `graph` computed's edge styling fully overwrites** the initial `animated`/`style` values set in `buildTaskGraph` — the `buildTaskGraph` values are dead code at render time. Safe to remove in a future cleanup.
- **KanbanBoard is unaffected** because it consumes the same `useTasksStore().visible` computed, and `replaceAll`/`patchTask` have no per-consumer logic.
- **Pre-existing issue:** `test/draft-placement.test.js` prints `fatal: not a git repository` warnings to stderr (git-dependent tests in a non-git repo), but all 12 subtests pass. Not introduced by this feature.

## Open Questions / What Next

_(none — feature is complete and ready for merge.)_

## Promotion Candidates

- **The reactive chain pattern** (WebSocket → store mutation → computed re-eval → component computed → render prop) is the proven template for any future VueFlow or visualization component that needs live updates. Document as a project convention.
- **`onUnmounted(() => store.setFeatureFilter(null))`** should be a standard pattern for any feature-scoped view to prevent cross-project/feature filter pollution.
- **The `shallowEqual` gate in `replaceAll`** is a useful optimization pattern for any store that receives bulk WebSocket updates — preserves object identity for unchanged items, reducing unnecessary re-renders.
- **VueFlow ID-based diffing** relies on stable node/edge IDs across recomputations. The `task.id` and `e-${blockerId}-${task.id}` pattern should be enforced for any new graph views.
- **Dead code in `buildTaskGraph`:** The initial edge `animated`/`style` values are overwritten by the `graph` computed in TaskGraphView. A future cleanup task could remove them or consolidate edge styling into `buildTaskGraph` for consistency.
