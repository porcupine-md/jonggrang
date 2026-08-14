---
title: jonggrang design — global design templates + design studio
date: 2026-08-15
status: proposed
branch: feat/design-studio
base: feat/ui-design-context   # builds on PR #93 baseline-pack machinery
---

# Plan — `jonggrang design`: global design templates + a design studio

## Goal

Let a user turn a design into a **reusable global template** stored at
`~/.jonggrang/design/<template_name>/`, author/edit it in a **web "Design" studio**
(chat on the left, live preview on the right), pull tokens or a component with
`jonggrang design <name> get <what>`, and have `plan` reuse it — exactly like a
built-in baseline pack. Conceptually similar to claude.com/product/design, but
self-contained: manifest + tokens + components + live preview, all local.

## Decisions (confirmed)

- **Component format:** framework-agnostic **HTML + CSS using `--ui-*` tokens**
  (canonical). Preview renders directly; `get` returns markup+tokens; project
  agents adapt it to the project's framework (React/Vue). Reuses PR #93's token
  contract (`templates/ui-baselines/core/semantic-token-contract.md`).
- **Plan integration:** design templates are **personal baseline packs**.
  `~/.jonggrang/design/*` becomes a second catalog merged into
  `listBaselinePacks()`, so `plan` selects them by `id@version` and the audit
  recommends them — full reuse of PR #93 selection/validation/bounded-context.
- **v1 scope:** the **full studio** ships in v1 — CLI + storage format + plan
  integration + the interactive Design tab (chat + live preview + agent authoring).
- **Studio chat = each tool's native interactive TUI, in UNSAFE mode.** The left
  pane is NOT a custom chat UI — it embeds the selected backend's own interactive
  harness as a **pty-backed xterm terminal** (reusing `apis/projects/pty.js` +
  `TerminalView`/xterm), launched with skip-permissions/yolo so the agent edits the
  template freely: `claude --dangerously-skip-permissions`, `opencode` TUI, `codex`
  (full-auto), `jonggrang agent` (Pi TUI). CWD = the template dir. Unsafe is
  acceptable because it runs sandboxed by default (below).
- **Execution mode:** the studio agent runs in a **sandbox (Docker) by default**,
  with a per-studio toggle to run on the host. Sandbox default matches the rest of
  jonggrang, isolates agent writes to the template dir, and avoids the host
  `~/.claude/session-env` EACCES that blocks claude on the host. Host mode is the
  opt-out (faster; claude is subject to host perms, opencode works on host).

## Storage format — `~/.jonggrang/design/<template_name>/`

A superset of the baseline-pack format (so it validates as a pack):

```
~/.jonggrang/design/<template_name>/
  manifest.yml            # pack manifest + `components:` list (see below)
  guide-fragment.md       # guide body using the canonical section headings
  tokens.css.template     # semantic --ui-* token contract (OKLCH)
  components/
    button.html           # HTML fragment using --ui-* tokens (+ scoped <style>)
    input.html
    card.html
    ...
  preview/
    index.html            # optional composed preview page (auto-generated)
  .meta.json              # provenance: promoted_from, created_at, tool, version
```

`manifest.yml` extends the pack manifest with:
```yaml
id: <template_name>
version: 1
components:                       # NEW — enumerates gettable components
  - id: button
    file: components/button.html
    variants: [primary, quiet, danger]
  - id: card
    file: components/card.html
```
Design templates are pinned `id@version`; bumping `version` forks a new pinned id.

## CLI — `jonggrang design <subcommand>`

Wired in `bin/jonggrang.js` `main()` like `task`/`memory` (`if (command === 'design') return cmdDesign(rest)`), backed by `lib/design.js`.

| Command | Behavior |
|---|---|
| `design list` | List `~/.jonggrang/design/*` templates (+ built-in packs, tagged source). |
| `design new <name>` | Scaffold an empty template (manifest + core token/guide stubs). |
| `design promote <name> [--from <project-path>] [--force]` | Build a template from a project's `.jonggrang/UI.md` + token source + representative components. Fulfils "promote my design". |
| `design show <name>` | Print manifest + guide + token/component summary. |
| `design <name> get <what>` | Emit for an agent/user: `get tokens` / `get guide` / `get manifest` / `get <component>` (HTML+CSS) / `get component <id> --variant primary`. Stdout is the raw artifact (agent-facing). |
| `design validate <name>` | Validate against pack + design contract (sections, token roles, component refs resolve). |
| `design remove <name>` | Delete a template (confirm; `--force` for headless). |

`get` is the "design token or code generate per component" path — it resolves the
component file, inlines its `--ui-*` usage, and prints markup ready to hand to a
coding agent, or the token block for the guide.

## Plan / UI-context integration (PR #93)

- `lib/ui-context.js`: `baselineCatalogPath()` stays for built-ins; add
  `designCatalogPath() = ~/.jonggrang/design`. `listBaselinePacks()` merges both
  (built-in + personal), personal tagged `source: 'design'`. `findExplicitBaseline`
  / `recommendBaseline` / consent already operate on the merged pack list — no flow
  change. A user's `design` template is now selectable in any `plan` by its
  `id@version`, and its `guide-fragment` + tokens feed the agent's `.jonggrang/UI.md`.
- Selection order gains: personal `design` templates rank with built-in packs
  (after project evidence + explicit reference, alongside product-shape match).

## Web "Design" studio — new **top-level** tab

Design templates are global, so "Design" is a top-level nav item (next to
projects/issues/secrets/settings), not a project sub-tab.

- **Router/nav:** add `/design` and `/design/:name` routes in
  `client/src/router/index.js`; add the nav link in the top bar
  (`client/src/components/app/TopBar.vue`).
- **`DesignListView.vue`:** gallery of templates (name, thumbnail preview,
  source badge built-in|personal), "New template", "Promote from project…".
- **`DesignStudioView.vue`** (`/design/:name`) — the studio, two panes:
  - **Left — Tool TUI** (pty-backed xterm, reusing `apis/projects/pty.js` +
    `TerminalView`): embeds the selected backend's **native interactive TUI in
    unsafe mode** (`claude --dangerously-skip-permissions`, `opencode`, `codex`
    full-auto, `jonggrang agent`), CWD = the template dir. The user talks to the
    tool's own harness; jonggrang does not wrap the chat. Backend picker + a
    "Sandbox on/off" toggle sit in the studio header.
  - **Right — Live preview** (sandboxed `<iframe>`): renders the template's
    components with its `tokens.css.template`; toolbar for light/dark, viewport
    width, and a component picker (button/card/…); a Tokens editor drawer.
  - Save writes to `~/.jonggrang/design/<name>/`; a WebSocket/file-watch pushes
    updates so the preview refreshes as the agent writes files.

## Backend APIs — `apis/design.js` (global, registered in `server.js`)

| Route | Purpose |
|---|---|
| `GET /api/design` | List templates (personal + built-in). |
| `GET /api/design/:name` | manifest + guide + tokens + components. |
| `POST /api/design/:name` | Create/update template files. |
| `DELETE /api/design/:name` | Remove template. |
| `GET /api/design/:name/preview?component=&theme=&width=` | Return a self-contained HTML doc (tokens + component) for the iframe. |
| `pty` (socket.io, reuse `apis/projects/pty.js`) | Design scope: spawn the selected backend's interactive TUI in **unsafe** mode, CWD = template dir (host or container). Streams `pty.data`/`pty.input`/`pty.resize`. This replaces a custom chat endpoint. |
| `POST /api/design/promote` | `{ name, fromProjectPath }` → build template from a project's UI.md/tokens/components. |
| `GET /api/design/:name/events` (WS) | Push file-change events → preview refresh. |

## Agent authoring (via the tool's own TUI)

The user drives the selected tool's **native interactive TUI** (unsafe) in the left
pane; jonggrang does not wrap the conversation. To steer it toward the template
contract, seed the tool's CWD (`~/.jonggrang/design/<name>/`) with an `AGENTS.md`
(and a `.claude/` skill stub) written by `design new`/`promote`, instructing: work
only inside this dir, keep the 8 canonical guide sections, use `--ui-*` token roles
only, write components as HTML fragments referenced from `manifest.components`, never
inline raw hex. The preview refreshes on file writes (watch → WS). Because the TUI is
the tool's own harness, per-tool features (claude skills, opencode agents) work
natively; jonggrang only provides the seeded contract + sandboxed CWD.

## Sandbox vs host execution (default: sandbox)

The studio chat turn (`POST /api/design/:name/chat`) runs the authoring agent in one
of two modes; **sandbox is the default**, toggled per-studio (persisted in the
template's `.meta.json` and defaulted from `~/.jonggrang/settings.json`
`design.sandbox` — default `true`).

- **Sandbox (default):** spawn/reuse a container from the agent image (reuse
  `lib/sandbox.js` + `web-state` `DEFAULT_VOLUMES`), with `IS_SANDBOX=1`, the auth
  mounts (`~/.claude`, `~/.claude.json`, `~/.opencode`, …), and the template dir
  mounted (e.g. `~/.jonggrang/design/<name>` → `/workspace`). The agent runs
  `node …/bin/jonggrang.js` design-authoring in-container as root, so claude's Bash
  works (no host `session-env` EACCES). Writes land on the host mount → the host
  preview server serves the updated files.
- **Host (opt-out):** run the agent directly on the host with the template dir as
  CWD. Faster, no container; but claude is subject to host perms (use opencode, or
  the user fixes `~/.claude` ownership). Surfaced in the UI as "Sandbox: off".

Container lifecycle mirrors project sandboxes: lazily started, reused across turns,
torn down with the studio session. The toggle lives next to the backend picker in the
studio header.

## Preview rendering

`GET /api/design/:name/preview` composes a minimal HTML doc: `<style>` from
`tokens.css.template` + the requested component fragment (or the composed
`preview/index.html`), wrapped with a theme attribute and a max-width container.
Served into a **sandboxed iframe** (`sandbox="allow-same-origin"`, no scripts) so
untrusted markup can't script the dashboard. Light/dark via `data-theme`; width via
the container. No build step — pure HTML/CSS with tokens.

## Build phases (verifiable increments; all land in v1)

1. **Storage + lib** — `lib/design.js`: paths, list/load/save/validate/get/promote;
   extend `manifest` schema with `components`. Unit tests. `scripts/qa-design.sh`.
2. **CLI** — `cmdDesign` in `bin/jonggrang.js` (list/new/promote/show/get/validate/remove) + `--help`.
3. **Plan integration** — merge `~/.jonggrang/design` into `listBaselinePacks`; audit/recommend; a smoke that a personal template is selectable + reused in a plan (fake backend).
4. **APIs** — `apis/design.js` + register in `server.js`; preview endpoint; promote endpoint.
5. **Studio UI** — `DesignListView`, `DesignStudioView`, top-nav + routes; live preview iframe; tokens editor; component picker.
6. **Studio chat/agent** — `/api/design/:name/chat` streaming + design-authoring skill; file-watch → preview refresh.
7. **Docs + seed** — see below; ship one seeded example personal template via `design new`/promote demo.

## Docs to update (Iron Rule)

- `README.md` (Commands at a Glance: `jonggrang design`), `docs/QUICKSTART.md`,
  `docs/EXAMPLE.md` (a promote→reuse walkthrough).
- `docs/CONFIG.md` (new `~/.jonggrang/design/` store), `docs/JONGGRANG.md` (state
  section), `docs/UI_CONTEXT.md` + `docs/UI_BASELINES.md` (personal templates as
  packs), `docs/SKILLS.md` (authoring-design-template skill).
- `templates/CLAUDE.md.template` / `AGENTS.md.template` if agents should know
  `jonggrang design <t> get <component>`.

## Verification

- `lib/design.js` unit tests; `scripts/qa-design.sh` (contract: promote, validate,
  get, catalog merge, plan selects a personal template).
- E2E: `design promote` a real project → template appears in `design list` and in a
  `plan` baseline selection; studio renders live preview; chat edits a token and the
  preview updates. Browser-validate the Design tab (agent-browser/claude-in-chrome).
- Deterministic guide/token validation reuses PR #93's `validateUiGuide`.

## Risks / open questions

- **Preview fidelity** for framework-specific components (we store framework-agnostic
  HTML; project agents adapt). Acceptable per the format decision; flag in docs.
- **Studio agent write scope** — must be sandboxed to the template dir (enforce in
  the API/skill). Security: iframe is script-sandboxed.
- **Sandbox root-ownership** — in sandbox mode the container writes template files as
  root on the bind mount, so later host-side edits (UI token editor, `design` CLI as
  the host user) can hit EACCES. Mitigate by routing ALL writes through one owner:
  either always write via the container in sandbox mode, or `chown`/`--user` the
  mount to the host uid. Same class as the known sandbox root-ownership issue; decide
  the write-path in Phase 4.
- **Component taxonomy** — start with a small canonical set (button, input, card,
  nav, section) and let `manifest.components` grow.
- **Versioning UX** — how a user bumps `version` (fork) vs edits in place; propose:
  edit-in-place for drafts, explicit `design <name> bump` to pin a new `id@version`.

## Out of scope (v1)

- Publishing/sharing templates to a remote registry (local-only for now).
- Auto-generating framework-specific component code (agents do that per project).
- Figma/DTCG import.
