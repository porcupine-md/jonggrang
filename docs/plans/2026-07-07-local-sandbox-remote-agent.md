# Local Sandbox — Remote Agent, Local Execution via Reverse SSH Tunnel

> Status: **DESIGN / DISCUSSION** (not yet implemented). Feature #TBD.
> Decisions captured from discussion 2026-07-07. Open decisions marked **[DECIDE]**.

## 1. Goal

Let the AI agent run on a **consistent, always-on jonggrang server** (Claude CLI + toolchain
authenticated once, centrally), while the **user's code stays on their local machine** and is
never uploaded. A **reverse SSH tunnel** lets the server reach back into the local machine, and
every command the agent runs is transparently executed on the local machine — the agent behaves
as if it were working in its own environment.

Motivation: avoid per-machine Docker sandbox setup (image pulls, root-ownership, auth mounting)
and get one consistent agent control plane, without moving private code off the developer's box.

### Non-goals (for now)
- Hardened security of the inbound server→local access (deferred — see §7).
- Multi-tenant server isolation, quotas.
- Live pair-editing / multi-device-per-project.

## 2. Roles

| | Local machine ("device") | Jonggrang server |
|---|---|---|
| Runs | `sshd`, the tunnel agent (`autossh`), the user's code | jonggrang dashboard + orchestration + **Claude CLI** + toolchain |
| Holds | **source of truth (code)** — never uploaded | agent brain, per-device reserved tunnel port, project state |
| Weight | light (just SSH + tunnel) | heavy / consistent env |

Reverse tunnel: `autossh -M 0 -f -N -R <port>:localhost:22 <serveruser>@<server>`.
`-R` binds the forwarded port on the **server loopback**, so only processes *on the server* (the
agent) can use it — it is not exposed to the internet.

## 3. Core mechanism — transparent Bash redirect ("agent tak sadar")

Claude runs **on the server**. When the agent runs a Bash command, jonggrang transparently
executes it **on the local machine** through the tunnel, and returns the output as if it ran
locally. The agent is never aware.

> **VERIFIED (2026-07-07 PoC).** Claude Code's PreToolUse hook officially supports rewriting tool
> input via `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"ssh … '<cmd>'"}}}` — Claude re-executes the rewritten command and is
> unaware. Empirically: a local `claude` with a Bash-matcher hook that rewrote commands to
> `ssh ubuntu@sj '<cmd>'` ran `hostname; whoami; uname -s` and Claude reported sj's identity
> (`temet01bare87 / ubuntu / Linux`), not the local Mac's — fully transparent. PoC at
> `/tmp/localsandbox`. This is the supported, working mechanism.

Mechanism (a plain PreToolUse block/allow hook **cannot** run-elsewhere-and-return — it only
blocks/allows, and its reason goes to the *user*, not the model). The supported lever is the
**`updatedInput` command rewrite** above (agent-transparent). Notes:

- **Primary: shell wrapper/shim.** jonggrang controls the agent's launch env (`spawnForProject`
  already sets env). Put a shim on the agent's PATH (or configure the tool's shell) so the
  effective execution is:
  ```
  ssh -p <port> <localuser>@localhost 'cd <local-workdir> && <cmd>'
  ```
  Transparent, no agent awareness, works for any command. Multiplex with SSH `ControlMaster` /
  `ControlPath` so many commands reuse one connection (fast).
- **Alt: command-rewrite hook** — if the backend supports rewriting tool input (`updatedInput`),
  a PreToolUse hook rewrites the command into the `ssh …` form. **[VERIFY]** per backend
  (claude-code / opencode) — capability not confirmed.
- **Avoid: MCP `remote_bash` tool** — makes the agent *aware* (different tool), breaks "tak sadar".

Interactivity/signals (Ctrl-C, resize, prompts, long-running processes) are handled by running the
SSH session through **node-pty** — reusing jonggrang's existing Terminal/Agent PTY infrastructure
(`apis/projects/pty.js`, `useInteractiveTerminal`).

## 4. Hook separation (design principle)

Two **distinct, non-merged** hook bundles:

1. **Remote-redirect hook (server-only, local-sandbox mode only).** A *separate* bundle installed
   into the **server-side agent config** for local-sandbox projects. Its job: route Bash (and,
   depending on §5, file ops) to the local machine. **NOT** part of the standard `jonggrang init`
   bundle; **NOT** installed on the local machine.
2. **Standard jonggrang hooks** (secrets blocker, compaction gate, quality gate, etc.). Installed
   by `jonggrang init` on the **local** project (and normally on any agent host). The remote-redirect
   logic must never be folded into these — the standard bundle also lands on local, and a redirect
   hook there would be nonsensical / could loop.

**Consequence [RISK].** Because the redirected Bash reaches local as a raw `ssh '<cmd>'`, the
**local** jonggrang hooks (Claude-Code PreToolUse) do **not** fire for it — Claude's tool lifecycle
runs on the *server*, not local. Therefore the standard protections (secret-block, quality gate)
must run on the **server** side (they fire before the redirect). The local standard hooks are
dormant scaffold in this mode.

## 5. File tools (Read / Edit / Write / Grep / Glob) — **[DECIDE]**

The Bash redirect covers `Bash`, but Claude's file tools touch the filesystem **where Claude runs
(server)** — while the code is on **local**. Options:

- **Recommended — mount local project → server workdir (SSHFS over the tunnel).** File tools become
  transparent (they read/write the mount = local files); Bash still redirects to local via the
  wrapper (so the execution env is the *real* local box, not the mount view). Result: **both files
  and bash are transparent**, agent unaware. SSHFS latency only affects small edit/read ops here —
  build/test go through the Bash redirect, so they are **not** slowed by SSHFS.
- **Alt — no mount, everything via Bash.** Disable/redirect native Edit/Write and force the agent to
  edit via shell (heredoc/`sed`) so file ops ride the Bash redirect. Lighter infra, but fragile
  (edit quality drops, must be enforced via skill/prompt).

> **DECISION (2026-07-07): MOUNT model.** User wants a *consistent + stable* solution, not an MVP
> shortcut — bash-only is rejected (clumsy for real edits). Native file tools operate on the SSHFS
> mount (= local files). PoC (a) confirmed the safety net: with native Read/Edit/Write *not* granted
> the agent falls back to Bash→redirect and **nothing leaks** to the server fs (verified — file
> existed only on sj, agent read+edited it via `cat`/`printf`, local stayed empty). But native edits
> are preferred for quality → mount.
>
> Sub-decision still open [DECIDE-b]: with the mount, does **Bash** run (i) on the server against the
> mount (most consistent env, but heavy SSHFS I/O for `node_modules`/builds), or (ii) redirect to
> local via the §3 hook (fast native I/O, but local runtime)? Resolve in phase (b) by testing real
> build/test stability over SSHFS.

## 6. Trust & keys — two directions

The reverse tunnel needs **two** trust relationships (the user's "register a public key" covers the
second one):

1. **local → server** (to *open* the tunnel `-R`): the local machine's key must be accepted by the
   server. Provisioned at registration.
2. **server → local** (for the agent to *enter* via the tunnel): the **server's public key** must be
   in the local machine's `~/.ssh/authorized_keys`. The user adds it during device registration —
   this is the "jonggrang provides a public key to register on your local machine" step.

## 7. Security (MVP: deferred, per decision)

MVP: the user supplies **their own SSH user** on local and registers the server's pubkey — full
access as that user. No hardening yet.

Future hardening (documented, not built): dedicated restricted `jonggrang` local user, forced-command
allowlist (only jonggrang/agent commands, no free shell), workspace scoping, per-session ephemeral
keys, key rotation, audit log. Giving a remote server shell into a dev machine is a large grant;
loopback-bound `-R` limits exposure to server-local processes only, but the server itself is trusted.

## 8. Flows

**Registration (P0)** — from local:
```
jonggrang device register --server <server>
  → server reserves a tunnel port for this device, returns { port, token, server_pubkey }
  → local: add server_pubkey to ~/.ssh/authorized_keys  (inbound trust)
  → local: register local pubkey with server               (outbound tunnel trust)
  → local: save ~/.jonggrang/device.json { server, port, token, localuser }
```

**Tunnel (P1)** — from local:
```
jonggrang tunnel up     # autossh -M 0 -f -N -R <port>:localhost:22 <serveruser>@<server>
jonggrang tunnel status # health, uptime, reconnect state
jonggrang tunnel down
```

**Run (P2+)** — on server:
```
agent (Claude) runs on server for a local-sandbox project
  → Bash tool → shell wrapper → ssh -p <port> localhost 'cd <workdir> && <cmd>' → runs on LOCAL
  → file tools → server workdir = SSHFS mount of local → hit LOCAL files      [per §5]
  → output streams back through node-pty; agent sees it as local
  step repeats through the session
```

## 9. Integration with existing jonggrang

- **New project mode** alongside `local` and `sandbox` (docker): e.g. `device` / `local-sandbox`.
  Project record carries `{ device_id, reserved_port, localuser, workdir }`.
- **`spawnForProject`** (`apis/projects/index.js`) gains a third branch: after `docker exec` (sandbox)
  and `node bin/jonggrang.js` (local), add the **tunnel/device** branch that runs via the SSH-PTY
  transport to the registered device.
- **`lib/tunnel.js`** (new) — registration, port reservation, key exchange, tunnel lifecycle,
  device registry (mirrors how `lib/sandbox.js` manages containers).
- **PTY reuse** — `apis/projects/pty.js` + the interactive-terminal composable already speak node-pty;
  the SSH session is just a PTY whose child is `ssh`.
- **Worktrees** — `jonggrang work --worktree` executes on the device (git worktree on the local repo),
  commit/push from the device — same shape as sandbox (which does worktree-in-container), just over SSH.
- **Docs to update on build**: `docs/JONGGRANG.md` (modes, project structure), `docs/CONFIG.md`
  (device config), `docs/AGENTTOOLS.md` if the transport counts as a backend, `README.md` (modes).

## 10. Data model

- `~/.jonggrang/device.json` (local): `{ server, reserved_port, token, localuser, created_at }`.
- Server device registry: `device_id → { pubkey, reserved_port, owner, last_seen }`.
- Project record (server): `{ mode: 'device', device_id, workdir, ... }`.

## 11. Phased plan

- **P0 — Registration & key exchange.** `jonggrang device register`, server endpoint, port
  reservation, two-way key provisioning, `device.json`.
- **P1 — Tunnel lifecycle.** `jonggrang tunnel up/down/status`, autossh wrapper, reconnect/health.
- **P2 — SSH-PTY execution transport.** Wrapper/shim for Bash redirect; `ControlMaster` multiplex;
  `spawnForProject` device branch; node-pty session. **Verify** transparent-redirect mechanism.
- **P3 — File tools.** Implement chosen §5 approach (mount, or bash-only).
- **P4 — Project binding & dashboard.** `device` mode, device picker, tunnel status UI, project = a
  path on a registered device.
- **P5 — Orchestration integration.** Worktrees on device, commit/push from device, work loop end-to-end.
- **P6 — Security hardening (future).** Restricted user, forced-command, key rotation, audit.

## 12. Open questions / risks

- **[DECIDED ✅] §5** file-tools: **mount** (consistent + stable; proven end-to-end, b4-agent).
  Remaining sub-decision **[DECIDE-b]**: with the mount, does Bash run on the server against the
  mount, or redirect to local (§5)? — resolve by stress-testing heavy build I/O over SSHFS.
- **[RESOLVED ✅]** transparent Bash redirect on claude-code = PreToolUse `updatedInput` rewrite
  (proven, §3). Still **[VERIFY]** the same for **opencode** (different hook/plugin model).
  Also: `updatedInput` rewrites *args* only — it can redirect `Bash`, but it can NOT relocate the
  filesystem for `Read`/`Edit`/`Write` (those act where claude runs). So file tools still need the
  §5 mount, OR steer the agent to do file ops via Bash (which now redirects transparently).
- **[RISK] §4** standard local hooks don't fire on redirected bash → protections must live server-side.
- **NAT/connectivity**: reverse tunnel assumed because local is behind NAT (no inbound). Confirm.
- **Reconnect mid-run**: tunnel drop during a run — how to pause/resume the agent gracefully.
- **Toolchain on local**: local needs the tools the tests invoke (node/go/…); "consistency" here is
  the *control plane* + Claude env, not the test runtime (that runs on local). Confirm this matches intent.
- **SSHFS performance** if mount is chosen (large `node_modules`/build dirs) — mitigated by keeping
  build/test on the bash-redirect path, not the mount.

## 13. MVP boundary

Per decision: **design only for now, do not build.** First implementation slice (when we proceed)
= P0 + P1 (registration + working tunnel with two-way auth), proven before wiring the agent transport.

## 14. Validation log — end-to-end PoC (2026-07-07)

All against the real server `sj` (= `sandbox.jonggrang.dev`, Ubuntu 24.04) and this Mac as the
local device. **Every core mechanism was proven with real commands.**

| # | What | Result |
|---|------|--------|
| a | **Transparent Bash redirect via hook** | ✅ Local `claude` + a PreToolUse Bash hook rewriting `command`→`ssh ubuntu@sj '<cmd>'` (`updatedInput`). `claude` ran `hostname;whoami;uname -s` and reported **sj's** identity (`temet01bare87/ubuntu/Linux`), not the Mac's — fully transparent, agent unaware. |
| a2 | **File-tool safety (no mount)** | ✅ File that existed only on sj: `claude` tried native `Read` (not granted) → fell back to `cat`/`printf` (Bash) → read+edited it on sj; **nothing leaked** to the Mac. Confirms bash-only is safe but relies on denying native file tools. |
| b1 | **sshfs/FUSE on server** | ✅ `apt install sshfs` on sj; `/dev/fuse` present; loopback `sshfs` mount succeeded. Server-side mount viable. |
| b2 | **Reverse tunnel** | ✅ `ssh -N -R 22222:localhost:22 ubuntu@sj` from the Mac; from sj `ssh -p 22222 localhost` reached the Mac (`anak10thn-mini.local`, Darwin). Needed macOS **Remote Login ON** + sj's pubkey in the Mac's `authorized_keys`. |
| b3 | **SSHFS mount local→server** | ✅ `sshfs -p 22222 anak10thn@localhost:/tmp/localsandbox /home/ubuntu/localmnt` on sj; server sees the laptop's project. |
| b4-core | **Server edits land on laptop + reads + hooks visible** | ✅ Write from sj into the mount appeared on the Mac; sj read a laptop-only file; the project's `.claude/settings.json` + `hooks/` were visible/readable from sj via the mount. |
| b4-stability | **Real workload over SSHFS from sj** | ✅ Multi-file Node app + test ran on sj against the mount (`TEST PASS`, ~0.35s); all files landed on the laptop. ⚠️ Git over the mount hits `dubious ownership` (uid 501 mount vs `ubuntu`) → needs `git config --global --add safe.directory` (jonggrang's image already sets `safe.directory '*'`). |
| b4-agent | **Real Claude agent ON sj (native edits on mount)** | ✅ **PROVEN.** `claude` (logged in as **ibnu** on sj) ran headless in the mount (`/home/ibnu/localmnt`): created `agent-demo.js` via the native Write tool, ran it with node, edited it via native Edit, ran again. On the **laptop**, `/tmp/localsandbox/agent-demo.js` ended up with the edited content (`console.log('edited by agent')`) — native server-side edits landed on the laptop. The project's mounted `.claude` hook **fired on the server** (`agent-hook.log`: 4× `HOOK_FIRED host=temet01bare87`, `cwd=/home/ibnu/localmnt`). Full mount model works with a real agent. |

> **Auth note:** `claude` must be logged in **as the user the agent runs as** on the server. The
> `sj` alias user is `ibnu` (not `ubuntu`); login + the agent run must use the same user. The
> server agent needs an ssh keypair (generated for `ibnu`) whose pubkey is in the laptop's
> `authorized_keys` for the sshfs-back mount.

### Validated setup steps (for the feature)
1. **Local**: macOS Remote Login ON (`sudo systemsetup -setremotelogin on`); server's pubkey in `~/.ssh/authorized_keys`.
2. **Server**: `sshfs` installed (FUSE available); `git config --global --add safe.directory '*'`.
3. **Reverse tunnel** (local→server): `ssh -N -R <port>:localhost:22 <serveruser>@<server>` (autossh for keepalive).
4. **Mount** (on server): `sshfs -p <port> -o reconnect <localuser>@localhost:<project> <mnt>`.
5. Server agent runs in `<mnt>`: native file tools → laptop; bash → server against mount (or redirect per §5 [DECIDE-b]); hooks come from the mounted `.claude`.

### Notes / follow-ups surfaced by the PoC
- **Git ownership**: set `safe.directory` in the server env (jonggrang image already does).
- **`claude` login on server** is a real prerequisite for the "consistent Claude env" premise — now
  satisfied on sj (logged in as `ibnu`; real agent run proven, see b4-agent). Must be logged in as
  the same user the agent runs as.
- **Hook context**: the mounted `.claude` carries the *local* project hooks; the remote-redirect hook (if used for bash per §5(ii)) must be a *separate, server-side* bundle (§4) — never merged into the mounted local hooks.
- **SSHFS perf** was fine for small multi-file Node work; heavy `node_modules`/build I/O still to be stress-tested (§12).
- PoC artifacts on the Mac: `/tmp/localsandbox/` (`.claude/`, `connect.sh`, `mount-on-sj.sh`).
