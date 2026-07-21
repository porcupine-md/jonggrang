---
feature: fix-discard-plan-docker-sandbox
branch: feat/fix-discard-plan-docker-sandbox
base: "main"
work_type: BUGFIX
description: Fix draft plan deletion (discard) failing with permission errors when the project runs in Docker sandbox mode
created_at: 2026-07-21T14:09:51.845Z
---

# Plan: Fix Discard Plan in Docker Sandbox Mode

## Approach
When a project uses Docker sandbox mode, the plan draft files under `.jonggrang/.drafts/` are written by the container's root user but deleted by the host process via `fs.rmSync`, causing `EACCES` permission errors. The fix detects sandbox mode and performs the deletion inside the Docker container (where root owns the files), falling back to host `fs.rmSync` for non-sandbox projects. The existing `purgeProjectFiles` function in `lib/sandbox.js` already demonstrates this pattern — we extend the same container-delegation approach to the discard endpoint.

## Phases
1. Add a `removeDraftDir` helper to `lib/sandbox.js` that deletes a filesystem path using Docker container execution when sandbox mode is active
2. Update the `DELETE /:id/plan` route to use the new sandbox-aware helper instead of raw `fs.rmSync`
3. Run the existing test suite to verify no regressions

## Key Decisions
- Decision: Use a throwaway `docker run --rm` container (same image as the project's sandbox) to delete root-owned draft directories. Rationale: matches the existing `purgeProjectFiles` pattern; works even if the sandbox container is stopped; avoids host permission gymnastics.
- Decision: Keep `fs.rmSync` as the fallback after container deletion (mirroring `purgeProjectFiles`'s best-effort host cleanup). Rationale: the now-empty directory can safely be removed by the host process.

## Out of Scope
- CLI-based plan discard (currently web-only)
- Permission fixes for other write paths under `.jonggrang/` (e.g., questions/answers sidecar files)
- Generalizing all host filesystem writes in sandbox mode (this is a targeted bugfix)

## Dependencies
- `lib/sandbox.js` — existing `purgeProjectFiles` pattern for container-delegated file deletion
- `apis/projects/plan.js` — the `DELETE /:id/plan` route that must be updated
- `lib/jonggrang.js` — `draftDirFor` utility that resolves the target path
