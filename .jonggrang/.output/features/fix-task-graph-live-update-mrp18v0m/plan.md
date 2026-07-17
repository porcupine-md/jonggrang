---
feature: fix-task-graph-live-update
branch: fix/graph-update-only-when-all-task-completed
base: "main"
work_type: BUGFIX
description: TaskGraphView used isolated local state instead of the shared Pinia store, so WebSocket task-status changes never reached the graph until a manual refresh
created_at: 2026-07-17T14:12:40.456Z
---

# Plan: Fix Task Graph Live Update

## Approach
The TaskGraphView component maintained its own local `tasks` ref that was only populated by an HTTP fetch on mount/route-change — it never subscribed to WebSocket `tasks.update` events. The shared Pinia store (`useTasksStore`) was already receiving live updates from the orchestration worker and file watchers, but the graph ignored them. Wire the graph to the shared store using a reactive computed (same pattern the KanbanBoard already uses) so that every per-task status change immediately re-renders the graph without requiring a manual refresh.

## Phases
1. **Wire TaskGraphView to shared tasksStore** — Replace the local `tasks` ref with a computed from `useTasksStore().visible`, call `fetchTasks` through the store, and add `setFeatureFilter` lifecycle management (onMount / onUnmount / watch featureId) matching the KanbanBoard pattern.
2. **Verify reactive graph re-render** — Confirm that VueFlow receives updated `nodes`/`edges` props when the computed task list changes, and that edge styles (animated for in-progress, green for completed) update per-task without a full page reload.
3. **Run test suite and manual smoke test** — Run `npm test`, then manually verify the task graph updates live when tasks transition through pending → in_progress → completed during an orchestration run.

## Key Decisions
- **Use shared Pinia store, not local state**: Tasks flow through a single store that the KanbanBoard already reads from. Duplicating state in the graph view was the root cause — the graph never received WebSocket pushes.
- **No server-side changes**: WebSocket `tasks.update` events are already emitted correctly by both the file watcher (`apis/projects/index.js`) and the orchestration worker (`emitFeatureProgress`). The issue was entirely client-side.
- **Follow KanbanBoard's lifecycle pattern**: `setFeatureFilter` on mount/unmount and `watch(featureId)` ensures the graph scopes to the correct feature and cleans up when navigating away.

## Out of Scope
- Server-side WebSocket event changes — the events already fire per-task and on the correct interval.
- Changes to `buildTaskGraph` utility — it already accepts any reactive array and produces correct nodes/edges.
- Other views (KanbanBoard, Pipeline) — they already use the shared store correctly.

## Dependencies
- `useTasksStore` (client/src/stores/tasks.js) — shared task state already receiving WebSocket updates
- `ws.js` store — already handles `tasks.update` events and calls `replaceAll`
- `emitFeatureProgress` in `orchestration-run.js` — already emits per-task on `task_status` signals
