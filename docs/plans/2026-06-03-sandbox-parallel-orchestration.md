---
feature: sandbox-parallel-orchestration
branch: feat/sandbox-parallel-orchestration
work_type: MEDIUM
description: Run parallel orchestration (per-plan worktree + branch) entirely INSIDE the project's Docker sandbox container — worktree creation, agent work, commit, and diff all via `docker exec`, so sandboxed projects get the same isolation guarantee as normal work.
created_at: 2026-06-03
status: draft
---

# Plan: Parallel Orchestration Inside the Docker Sandbox

## 1. Goal (user's words)

- The container is already started (auto-starts when a project is opened; there's also a manual start/restart trigger).
- **Create the worktrees inside the container**, and **do all activity inside the container** (worktree creation, agent work, commit, diff).
- This makes parallel runs honor the sandbox isolation, instead of today's host-only behavior.

## 2. Current behavior (host-only) — the gap

`apis/projects/orchestration-run.js` runs everything on the host regardless of `project.sandbox.enabled`:
- `lib.createWorktree` / `commitWorktree` / `worktreeChangedFiles` / `worktreeFileDiff` → host `execSync('git …', {cwd})`.
- `spawnGroupWorker` → host `spawn('node', [bin/jonggrang.js, 'work', '--worktree', …], {cwd: worktreePath})`.

For a sandboxed project this means the **agent runs on the host, not in the container** — breaking the isolation promise. (The legacy single-work path `spawnForProject` already does `docker exec` when `sandbox.enabled`; parallel does not.)

## 3. Sandbox facts (from `lib/sandbox.js`)

- Container name: `jonggrang-<projectId>` (`getContainerName`).
- Project is **bind-mounted**: `-v ${project.path}:${containerPath}` where `containerPath = /root/<safe-project-name>` (`getContainerPath`).
- Container runs `sleep infinity`; work happens via `docker exec`.
- `sandbox.isRunning(projectId)` reports container state; `sandbox.start(...)` launches it.
- **Key consequence of the bind mount:** files written inside the container under `containerPath` appear on the host under `project.path` and vice-versa — the `.git` dir is the *same files*. Only absolute paths differ (host `/Users/…/<proj>/.git` vs container `/root/<name>/.git`). So git worktree metadata is path-consistent **only if a given worktree is always operated on from the same side**. → We will create AND use each worktree **inside the container** (container paths throughout).

## 4. Design

Introduce an **execution context** per project: host vs container. Every git operation and the agent worker run through that context.

```
project.sandbox.enabled === true
   │
   ├─ ensure container running: await sandbox.isRunning; if not, await sandbox.start + wait for isRunning.
   │     if start FAILS (e.g. Docker daemon itself not up) → 409 SANDBOX_NOT_RUNNING with a clear message.
   │
   ├─ per plan (parallel):
   │     worktree dir (container path) = <containerPath>/.jonggrang/.worktree/<featureId>
   │     1. docker exec <c> git worktree prune
   │        docker exec <c> git branch -D <branch>            (ignore if absent)
   │        docker exec <c> git rev-parse HEAD                (baseSha)
   │        docker exec <c> git worktree add -b <branch> <wt> HEAD
   │     2. seed working state into <wt> (tasks.json, plans, scaffolding) — host-side fs copy
   │        is fine because the path is bind-mounted (visible in the container); OR docker exec cp.
   │     3. docker exec <c> git -C <wt> add -A && commit  (base commit → clean diff)  [baseSha = that commit]
   │     4. docker exec -i --workdir <wt> --env … <c> jonggrang work --worktree --group-tasks <ids> --branch <branch>
   │        (mirror spawnForProject's docker exec + secret env; agent runs IN the container)
   │     5. on exit 0: docker exec <c> git -C <wt> add -A && commit "feat(<feature>): <title>"
   │
   ├─ diff  (GET): docker exec <c> git -C <wt> diff --name-status <baseSha>  (+ per-file)
   └─ push  (POST): docker exec --env GIT_SSH_COMMAND='ssh -i /root/.ssh/id_jonggrang …' <c>
              git -C <containerPath> push -u origin <branch>   (in-container, mounted key — see §6)
```

Worker stdout parsing (task_status signals → single-writer host `tasks.json`) is unchanged — `docker exec -i` streams stdout the same way `spawn` does.

## 5. Component changes

### `lib/jonggrang.js` — make worktree/git helpers context-agnostic
Add an optional **runner** so the same logic works on host or in a container:
- A small helper `makeGitRunner(opts)` returning `(args, { cwd }) => string`:
  - **host**: `execSync('git ' + args, { cwd })`.
  - **container**: `execSync('docker exec --workdir <cwd> <container> git ' + args)` (or `execFile('docker', ['exec','--workdir',cwd,container,'git',...])`).
- Thread an optional `opts.run` into `createWorktree`, `commitWorktree`, `worktreeChangedFiles`, `worktreeFileDiff`, `gitHead`. Default `run` = host execSync (current behavior — **no change for host projects**).
- For sandbox, paths passed in are **container paths** (`/root/<name>/…`).

### `apis/projects/orchestration-run.js` — branch on `project.sandbox.enabled`
- Compute `ctx`:
  - host: `{ root: project.path, worktreeDir: project.path/.jonggrang/.worktree/<id>, run: hostRun, spawnWorker: spawn('node', …) }`
  - sandbox: `{ root: containerPath, worktreeDir: containerPath/.jonggrang/.worktree/<id>, run: dockerRun, spawnWorker: docker exec … jonggrang work … }`
- `spawnGroupWorker` (sandbox): build `docker exec -i --workdir <wt> --env …(secretVars + JONGGRANG_*) <container> jonggrang work --worktree --group-tasks <ids> --branch <branch>` — reuse the exact env/secret pattern from `spawnForProject` in `index.js`.
- Before starting a sandbox run: `await sandbox.isRunning(id)`; if not running, **auto-start** via `sandbox.start(...)` and poll `isRunning` until ready (bounded wait). If start fails (Docker daemon down, image missing) → `409 SANDBOX_NOT_RUNNING` with the reason so the user/trigger can bring Docker up.
- Snapshot/persistence, socket events, kanban single-writer: unchanged.

### Seeding (`COPY_INTO_WORKTREE`)
- Host-side `fs` copy into the (bind-mounted) container worktree path still works because it's the same files. Keep it host-side for simplicity; no `docker cp` needed. (If we ever move to non-bind-mount sandboxes, switch to `docker cp`.)

## 6. Push & credentials — in-container with a mounted SSH key

Decision: **push runs inside the container** too (truly "all in container"), authenticating with an **SSH private key mounted into the container**.

### Key resolution (custom override → host default)
1. `~/.jonggrang/web/ssh/<project_id>.key`  ← per-project custom key, if set
2. `~/.jonggrang/web/ssh/global.key`         ← global custom key, if set
3. **default: `~/.ssh/id_rsa`** (the user's standard host key) — used when no jonggrang key is configured.

The user can pick a custom key (cases 1/2) via the sandbox setting; **by default it just mounts the host `~/.ssh`**, so pushes work out of the box with the same key the user already uses on the host. If none of the above exist → clear error (don't hang).

### Mounting (done at container start, in `lib/sandbox.js`)
Mounts are fixed at `docker run`, so the key is mounted when the container starts (not addable via `docker exec` later); the auto-start path picks it up.
- **Custom key set (1 or 2)** → mount that single file read-only:
  `-v <resolvedKeyPath>:/root/.ssh/id_jonggrang:ro` and push uses `ssh -i /root/.ssh/id_jonggrang`.
- **Default (no custom key)** → mount the host SSH dir read-only:
  `-v ~/.ssh:/root/.ssh:ro` — brings `id_rsa` **and** `known_hosts`; push uses ssh's defaults (`~/.ssh/id_rsa`). This is the out-of-the-box path.
- Key file must be `chmod 600` (SSH refuses loose perms); a read-only mount preserves host perms. Document the requirement.
- known_hosts: the default `~/.ssh` mount already carries it; for a custom single-key mount use `-o StrictHostKeyChecking=accept-new` to avoid a prompt.
- Security note: the default mounts **all** host SSH material into the sandbox (read-only). Acceptable on a personal machine and opt-out by setting a dedicated custom key; call this out in the settings UI.

### Push command (in-container, async, non-blocking)
```
# custom key (mounted at /root/.ssh/id_jonggrang):
GIT_SSH_COMMAND='ssh -i /root/.ssh/id_jonggrang -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes'
# default (host ~/.ssh mounted at /root/.ssh): ssh uses id_rsa + known_hosts automatically
GIT_SSH_COMMAND='ssh -o BatchMode=yes'

docker exec \
  --env GIT_SSH_COMMAND='…(per above)…' \
  --env GIT_TERMINAL_PROMPT=0 \
  <container> git -C <containerPath> push -u origin <branch>
```
- Run via `execFile('docker', [...])` **async** with a timeout — same non-blocking discipline as the host `pushBranch` (never `execSync`; must not freeze the event loop). `BatchMode=yes` + `GIT_TERMINAL_PROMPT=0` make it fail fast on a bad/missing key instead of hanging.
- `git push origin <branch>` targets the shared branch ref, so cwd = `<containerPath>` (main repo) is fine; it does not depend on the worktree path.
- The remote URL must be SSH (`git@github.com:…`). If the project was cloned via HTTPS, note that an SSH-key push needs an SSH remote (or a token-based HTTPS flow) — surface a clear error rather than hang.

### Implementation shape
- New `lib/sandbox.js` helper `resolveProjectSshKey(projectId)` → per-project → global → `~/.ssh/id_rsa` (or null), and `SSH_KEY_MOUNT` const. `start()` mounts the resolved key read-only at `/jonggrang/ssh-key`.
- `orchestration-run.js` `pushBranchCtx(ctx, project)`: container mode → if the container has `ssh` AND a key resolves, push in-container (stage key to `/root/.ssh/id_jonggrang`, GIT_SSH_COMMAND); **else fall back to host-side push**.
- Config/docs: document `~/.jonggrang/web/ssh/{global.key, <project_id>.key}` in `docs/CONFIG.md`; expose the per-project key in sandbox settings UI later.

### IMPLEMENTED REALITY (E2E 2026-06-03)
The agent image originally shipped git but **no `openssh-client`**, so in-container SSH push wasn't possible. **Fixed:** `docker/Dockerfile` + `docker/Dockerfile.dev` now install `openssh-client`. After rebuilding `orcinus/jonggrang-agent:dev`, in-container SSH push works and was verified green: `feat/beta-note` (with BETA.md, agent commit + orchestrator commit) pushed to `git@github.com:anak10thn/jonggrang-sandbox-test.git` via `docker exec … git push` using the mounted key (proof: `/root/.ssh/id_jonggrang` staged inside the container).

A **host-side push fallback** remains for images that still lack ssh: since the project dir (incl. `.git`) is bind-mounted, the host can push the in-container-created branch (ref + objects are in the shared `.git`). `pushBranchCtx` probes `containerHasSsh` and chooses in-container vs host automatically.

Also discovered: the sandbox already bind-mounts host tool auth (`~/.local/share/opencode`, `~/.claude`, `~/.codex`, etc.) into the container, so agents authenticate in-container without per-project secrets — the agents ran and committed successfully inside the container.

## 7. Edge cases

- **Container not running** at start → auto-start via `sandbox.start` and wait for `isRunning`; if start fails (Docker daemon down) → 409 with the reason. Don't spawn workers against a dead container.
- **Container restarted mid-run** → workers die; groups marked failed (existing close-handler path). Worktrees persist on the bind-mounted volume for inspection.
- **`docker exec` quoting** → use `execFile('docker', ['exec', …, 'git', …argv])` (argv form) instead of a shell string to avoid branch-name/quoting issues.
- **Path consistency** → never mix host and container git ops on the same worktree. The whole lifecycle (create→commit→diff→push) runs in-container; push uses cwd `<containerPath>` (main repo) and the shared branch ref.
- **SSH key missing / wrong perms** → no key resolved → clear error (don't hang). Loose perms (not 600) → ssh refuses; document the requirement (or enforce on start). `BatchMode=yes` makes auth failure fail fast.
- **HTTPS remote + SSH key** → an SSH key can't push to an `https://` remote; detect and surface a clear message (suggest an SSH remote or token flow). Re-clone/import via SSH for sandbox push.
- **Key mount needs container restart** → since mounts are fixed at `docker run`, changing/adding a key requires restarting the container (the existing restart trigger). Note this in the UI.
- **Agent auth inside container** → relies on the same mechanism as normal sandboxed work (secret env vars via `--env`, mounted credentials). Out of scope here.
- **Non-sandbox projects** → unchanged (host path + host push), because the runner defaults to host.

## 8. Verification (E2E in sandbox)

- Create a project from a git repo with Docker sandbox **enabled**; confirm container auto-starts on open.
- Seed/decompose 2 plans; Start parallel run.
- Assert: `docker exec <c> git worktree list` shows 2 worktrees under `/root/<name>/.jonggrang/.worktree/`; agents run **inside** the container (`docker top`/process check, or logs show container paths); kanban updates live; navigation persistence holds.
- `View changes` diff drawer works (diff computed in-container).
- Push each branch host-side → lands on remote (green), same as host E2E.
- Confirm non-sandbox projects still run host-side (regression check).

## 9. Decisions / assumptions

- Worktrees live at `<containerPath>/.jonggrang/.worktree/<featureId>` (bind-mounted, gitignored).
- **Everything runs in-container** via `docker exec`: worktree create, agent work, commit, diff, **and push**.
- **Push auth = mounted SSH key.** Default mounts the host `~/.ssh` (uses `id_rsa` + `known_hosts`) so it works out of the box; a custom key can be set per-project (`~/.jonggrang/web/ssh/<project_id>.key`) or global (`~/.jonggrang/web/ssh/global.key`), mounted read-only at `/root/.ssh/id_jonggrang`. Requires an SSH remote + a `600` key.
- Container is auto-started (and waited on); if Docker can't start it → 409.
- Reuse `sandbox.getContainerName` / `getContainerPath` / `isRunning` / `start` and the `spawnForProject` docker-exec env/secret pattern; add `resolveProjectSshKey` + a key mount in `sandbox.start`.
- Default runner = host (host push unchanged), so this change is **opt-in by `project.sandbox.enabled`** and does not touch existing host-mode behavior or the CLI.
