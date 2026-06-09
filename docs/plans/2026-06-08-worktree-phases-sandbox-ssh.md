---
feature: worktree-phases-sandbox-ssh
branch: feat/worktree-phases-sandbox-ssh
work_type: MEDIUM
description: Fixes found during sandbox E2E — agents now run in the correct dir, worktree runs execute the full phase pipeline (not just Implement), the web pipeline view updates live, and the sandbox SSH key is always available at /root/.ssh/id_rsa with containers recreated when the key changes.
created_at: 2026-06-08
status: implemented
---

# Plan: Worktree phases + sandbox SSH fixes

Follow-up to [`2026-06-08-per-plan-work-mode.md`](2026-06-08-per-plan-work-mode.md) and
[`2026-06-08-centralize-worktrees.md`](2026-06-08-centralize-worktrees.md). Surfaced while
running a full E2E (host + Docker sandbox, OpenCode backend) on throwaway GitHub repos.

## 1. Agent ran in the wrong directory (host spawn) — FIXED ✅ (committed `b9b9bc6`)

**Symptom:** web "Generate Plan" streamed logs then silently vanished; `approve`/`work`
operated on the Jonggrang **source repo** instead of the project workspace.

**Cause:** `spawn('node', …, { cwd })` sets the child's real cwd but leaves the inherited
`PWD` env pointing at the server's launch dir. The agent CLI (OpenCode) resolves its project
root from `$PWD`, not `process.cwd()`.

**Fix:** set `PWD` in the local-spawn env:
- `apis/projects/index.js` `spawnForProject()` → `PWD: project.path`
- `apis/projects/orchestration-run.js` `spawnGroupWorker()` → `PWD: group.worktreePath`

Docker branches are unaffected (they pass `docker exec --workdir`).

## 2. Worktree runs stalled at Implement — FIXED ✅ (committed `dc12cee`)

**Symptom:** in worktree mode the pipeline view stayed at phase 8 (Implement); the post-work
phases (Simplify → Compliance → Quality → TestPlan → Test → Coverage → TestQuality →
Complete) never ran.

**Cause:** `bin/jonggrang.js` `cmdWork()` gated **all** manifest tracking and the
post-work-phases call on `!WORKTREE_MODE` — so a worktree worker did Implement only. The
"resume" path that was meant to run the rest used `findIncompleteManifest(PROJECT_ROOT)`,
which in a worktree (seeded with **every** plan's manifest) grabbed an arbitrary plan and ran
its tasks — cross-plan contamination.

**Fix:** in worktree mode (when `--group-tasks` is present), resolve **this** run's own
manifest by the group tasks' `feature_id` via `orchestration.getManifestPath(PROJECT_ROOT, fid)`
— never `findIncompleteManifest`. Complete planning phases 1-7, run/complete phase 8, then run
`runPostWorkPhases` scoped to that manifest. `runOrchestrationLoop` skips already-completed
phases, so with phase 8 pre-completed it starts at Simplify and never re-grabs tasks.

Verified (`--dry-run` + a real run): worktree manifest advances 8 → 9 → 11 → … → 17 →
`completed`; sibling plans' manifests in the same worktree stay untouched.

## 3. Pipeline view didn't update live — FIXED ✅ (uncommitted)

**Symptom:** even after a worktree run completed all phases, the web pipeline view stayed at
phase 8.

**Cause:** the worker updates the manifest in its **worktree copy**
(`<worktree>/.jonggrang/.output/features/<fid>/MANIFEST.yaml`), but the manifest API
(`apis/projects/manifest.js`) reads the **main project** copy. No copy-back existed.

**Fix (`apis/projects/orchestration-run.js`):** `syncManifest(project, group)` mirrors the
worktree manifest → main project path; wired as a `setInterval(…, 1500)` live mirror in
`wireWorker()` plus a final sync in `child.on('close')` (interval cleared on close). The main
project's chokidar watcher (`depth: 3`) then emits `manifest.updated` and the pipeline view
advances live. The group object now carries `hostWorktreePath` + `manifestSync`.

## 4. Sandbox container kept a stale SSH-key mount — FIXED ✅ (uncommitted)

**Symptom:** a global SSH key was configured (`~/.jonggrang/web/ssh/global.key`) but the
container still mounted the fallback `~/.ssh/id_rsa`; restart/rebuild "didn't take".

**Cause:** Docker fixes volume mounts at `docker run` time — `docker start`/`docker restart`
can't remount. `apis/projects/sandbox-routes.js` `/sandbox/start` reused an existing container
whenever the **image** matched (only compared image), so a container created before the key
was added kept the stale mount.

**Fix:**
- `lib/sandbox.js` `sshMountDrifted(projectId)` — compares the container's `/jonggrang/ssh-key`
  mount source against `resolveProjectSshKey(projectId)`.
- `/sandbox/start`: the "already running" early-return now also requires `!sshMountDrifted`;
  the reuse block recreates (`remove` + `start`) when the image **or** the SSH-key mount
  drifted (handles running *and* stopped containers).

Net: change the key → just open/start the project → it auto-recreates with the new key. The
**Rebuild** button (`POST /:id/sandbox/rebuild` → `remove` + `start`) was already a correct
full recreate; **Restart** is `docker restart` (keeps mounts) by design.

## 5. SSH key now lives at `/root/.ssh/id_rsa` in the container — FIXED ✅ (uncommitted)

The resolved key is bind-mounted **read-only** at `/jonggrang/ssh-key` (it can't sit directly
at `~/.ssh/id_rsa` — ssh rejects a bind mount's owner/permissions). Previously it was only
copied to `~/.ssh` during a push, so manual git/ssh inside the container had no default key.

**Fix (`lib/sandbox.js` `start()` run args):** container command changed from `sleep infinity`
to:

```sh
sh -c 'mkdir -p /root/.ssh && chmod 700 /root/.ssh;
       if [ -f /jonggrang/ssh-key ]; then cp /jonggrang/ssh-key /root/.ssh/id_rsa && chmod 600 /root/.ssh/id_rsa; fi;
       exec sleep infinity'
```

So a root-owned `0600` copy is staged at `/root/.ssh/id_rsa` on every container start, and
`git`/`ssh` use it **by default** (no `-i` / `GIT_SSH_COMMAND` needed). The in-container push
staging file in `orchestration-run.js` was also renamed `id_jonggrang` → `id_rsa`.

Verified: fresh container → `/root/.ssh/id_rsa` present (0600); `ssh -T git@github.com` (no
`-i`) authenticates; `git ls-remote git@github.com:…` works.

**SSH key resolution order** (`lib/sandbox.js resolveProjectSshKey`): per-project
`~/.jonggrang/web/ssh/<project_id>.key` → global `~/.jonggrang/web/ssh/global.key` →
`~/.ssh/id_rsa`.

## 6. Operational notes (sandbox image)

- Dev image: `ghcr.io/porcupine-md/jonggrang-agent:dev`, built from local source with
  `docker/build.dev.sh` (`Dockerfile.dev`, copies `bin/`+`lib/` and installs the CLI). The
  global default image lives in `~/.jonggrang/web/index.json` → `sandbox_config.image` (set via
  **Settings → Docker Sandbox → Default Image**).
- **Gotcha:** `lib/sandbox.js start()` runs `docker pull <image>` before `docker run`. If the
  tag also exists on the remote registry, the pull overwrites a locally-built image of the same
  tag. To test a local build that shares a published tag, retag it to a local-only tag and point
  the sandbox image setting at that (the pull 404s → `start()` falls back to the local image).

## Status

Items 1–2 are committed (`b9b9bc6`, `dc12cee`). Items 3–5 are implemented and verified but
left **uncommitted** for review (per the repo's "user commits" rule). All changes are
server/CLI/lib only — no config-schema or CLI-command changes, so README/CONFIG tables are
unaffected.
