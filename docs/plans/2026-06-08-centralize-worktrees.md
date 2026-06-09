---
feature: centralize-worktrees
branch: feat/centralize-worktrees
work_type: MEDIUM
description: Move per-plan git worktrees out of each project repo (.jonggrang/.worktree/) into a central, per-project, persistent location under ~/.jonggrang/worktree/<project_id>/, mounted into the sandbox container at a dedicated path.
created_at: 2026-06-08
status: draft
---

# Plan: Centralize worktrees under ~/.jonggrang/worktree

## 1. Goal (in the user's words)

- When jonggrang web starts, it ensures `~/.jonggrang/worktree` exists.
- When a project container starts, mount `~/.jonggrang/worktree/<project_id>` into it.
- **All worktrees are created there**, not inside `<project>/.jonggrang/.worktree` anymore.
- Stays **persistent** (survives container rebuild and keeps the project repo clean).

## 2. Current state (verified)

Worktrees today live **inside the project repo**, gitignored:
- Host path: `<project.path>/.jonggrang/.worktree/<featureId>`
- Container path: `<containerPath>/.jonggrang/.worktree/<featureId>` where `containerPath = /root/<safe-name>` (`lib/sandbox.js:139`)

Paths are produced by `buildCtx()` in `apis/projects/orchestration-run.js:54-76` (`wt`/`hostWt`), and duplicated in:
- `apis/projects/pty.js:30,35` — Agent/Terminal worktree cwd
- `apis/projects/files.js:27` — Lite editor worktree root
- (Full editor folder: `FilesView.initFullEditor` appends `/.jonggrang/.worktree/<featureId>`)

Worktree registry meta: `<project>/.jonggrang/.ephemeral/worktrees.json` (stays as-is).

Relevant facts:
- For **sandbox** projects, `git worktree add` runs **inside the container** via `docker exec` (`gitSync` container mode), so worktree↔main-repo links are stored as **container-absolute paths**. The host only uses the path for fs seeding (`copyToWorktree`) and never runs git inside a sandbox worktree.
- For **host** projects, everything runs with host paths.
- The default volume set already bind-mounts **all of `~/.jonggrang` → `/root/.jonggrang`** in every container (`lib/web-state.js:19`). So `~/.jonggrang/worktree/...` is *already visible* in containers at `/root/.jonggrang/worktree/...` — but a dedicated, per-project mount is cleaner and isolates a container to its own worktrees.

## 3. Target design

**Host layout** (central, per-project, persistent):
```
~/.jonggrang/worktree/<project_id>/<featureId>/   ← the git worktree working dir
```

**Container mount** (added at `docker run`, sandbox projects only):
```
-v ~/.jonggrang/worktree/<project_id> : /root/.worktrees
```
→ worktree container path: `/root/.worktrees/<featureId>`

So `buildCtx()` becomes:
- host:      `wt(fid)  = ~/.jonggrang/worktree/<project_id>/<fid>`
- container: `wt(fid)  = /root/.worktrees/<fid>`, `hostWt(fid) = ~/.jonggrang/worktree/<project_id>/<fid>`

`git worktree add` still runs in the right ctx (container for sandbox, host otherwise), so the worktree↔main-repo links use paths valid in that ctx. Because the mount target (`/root/.worktrees`) and `containerPath` are deterministic per project, the links remain valid across container **rebuilds** → persistent.

## 4. Decisions

| Question | Decision |
|---|---|
| Central dir name | `~/.jonggrang/worktree/` (singular, per the user) with `<project_id>/<featureId>` underneath. |
| Container mount target | `/root/.worktrees` (dedicated, short, clean — not nested under the broad `~/.jonggrang` mount). |
| Add dedicated mount even though `~/.jonggrang` is already mounted? | **Yes** — gives a clean path and per-project isolation; the broad mount overlap is harmless (same host data, more specific path wins for our ops). |
| CLI `lib.createWorktree` (used by `jonggrang orchestrate` standalone) | **Leave as-is** for now (still `.jonggrang/.worktree`); this plan is the **web** orchestration path only. Revisit later if we want parity. |
| Existing `<project>/.jonggrang/.worktree/*` | Abandoned. One-time cleanup on first run of the new code (prune + remove stale worktrees, delete the dir). Keep `.gitignore` entry harmless. |

## 5. Implementation tasks

- [ ] **A1 — central dir helper** (`lib/web-state.js` or `lib/sandbox.js`): `worktreeRoot()` = `~/.jonggrang/worktree`; `projectWorktreeDir(projectId)` = `<worktreeRoot>/<project_id>`. Ensure `~/.jonggrang/worktree` exists.
- [ ] **A2 — ensure on web start** (`server.js` or `webState` init): `fs.mkdirSync(~/.jonggrang/worktree, {recursive:true})` at startup.
- [ ] **A3 — container mount** (`lib/sandbox.js` `start()`): pre-create `~/.jonggrang/worktree/<project_id>` on host, then add `-v <hostWorktreeDir>:/root/.worktrees` to the `docker run` args. Export `EDITOR`/worktree constants as needed (`WORKTREE_MOUNT = '/root/.worktrees'`).
- [ ] **A4 — buildCtx** (`apis/projects/orchestration-run.js`): point `wt`/`hostWt` at the new central/mount paths. `createWorktreeCtx`/`ensureWorktree` `mkdir` the host parent (`~/.jonggrang/worktree/<project_id>`) before `git worktree add`.
- [ ] **A5 — pty.js**: worktree cwd → container `/root/.worktrees/<fid>`, host `~/.jonggrang/worktree/<project_id>/<fid>`.
- [ ] **A6 — files.js**: `ctxOf(project, featureId)` worktree root → new paths (container `/root/.worktrees/<fid>`, host `~/.jonggrang/worktree/<project_id>/<fid>`).
- [ ] **A7 — Full editor folder** (`apis/projects/code-server.js` `code-status` / `FilesView`): worktree folder for openvscode `?folder=` → `/root/.worktrees/<fid>` (container) instead of `<containerPath>/.jonggrang/.worktree/<fid>`.
- [ ] **A8 — one-time cleanup**: on worktree creation, if `<project>/.jonggrang/.worktree` exists, `git worktree prune` + remove stale entries (best-effort) so old in-repo worktrees don't linger.
- [ ] **A9 — docs**: `docs/JONGGRANG.md` (worktree location in Parallel Orchestration section), `docs/PHILOSOPHY.md` project-structure tree (`.worktree/` note), `docs/CONFIG.md` if a path/volume is documented.

## 6. Migration

- Existing containers must be **rebuilt** to pick up the new `-v …:/root/.worktrees` mount (same as the editor-port change). Note this in the UI/docs.
- Old `<project>/.jonggrang/.worktree/*` dirs are stale after the switch; A8 prunes them. The `.gitignore` entry can stay (harmless) or be dropped in A9.

## 7. Risks / notes

- **git worktree absolute-path coupling** is the main risk. Mitigation: always create the worktree in the same ctx it's used (container for sandbox), and keep mount target + containerPath deterministic so links survive rebuilds. Verify: create worktree → rebuild container → `git -C /root/.worktrees/<fid> status` still works.
- **Mount must exist before `docker run`** — A3 pre-creates the host dir (Docker would otherwise auto-create it as root, risking permission issues).
- **Overlap with the broad `~/.jonggrang` mount** — harmless, but if we later narrow that mount (data-isolation; a container currently can read every project's files + `web/secrets.json`), the dedicated worktree mount keeps worktrees working independently.
- Worktree registry (`.ephemeral/worktrees.json`) stores absolute `worktree_path`; existing entries point at old `.jonggrang/.worktree` paths → A8/ensureWorktree should treat a missing/!git dir as "recreate" (already the case in `ensureWorktree`).

## 8. Non-goals

- No CLI (`jonggrang orchestrate`/`work --worktree`) path change — web only.
- No change to branch-per-plan, push, or the worktree lifecycle/commit behavior — only the on-disk location.
- Not narrowing the broad `~/.jonggrang` container mount (separate concern; noted).
