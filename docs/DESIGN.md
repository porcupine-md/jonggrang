# Design Studio & Global Design Templates

Jonggrang lets you turn a design into a **reusable global template** stored at
`~/.jonggrang/design/<name>/`, author it in a web **Design studio** (the tool's own
interactive TUI on the left, a live preview on the right), pull tokens or a component
from the CLI, and reuse it in any `plan` — exactly like a built-in UI baseline pack.

Related: [UI planning context](UI_CONTEXT.md) · [UI baseline packs](UI_BASELINES.md).

---

## Storage format — `~/.jonggrang/design/<name>/`

A design template is a **superset of a UI baseline pack**, so it validates and loads
through the same machinery:

```
~/.jonggrang/design/<name>/
  manifest.yml          # pack manifest + a `components:` list
  guide-fragment.md     # guide body using the 8 canonical section headings
  tokens.css.template   # semantic --ui-* token contract (OKLCH)
  components/
    button.html         # framework-agnostic HTML fragment using --ui-* tokens
    ...
  .meta.json            # provenance (created_by, promoted_from, …)
```

`manifest.yml` adds a `components:` array to the [baseline manifest](UI_BASELINES.md):

```yaml
id: acme
version: 1
intent: Acme brand system
product_shapes: [dashboard]
guide_fragment: guide-fragment.md
token_template: tokens.css.template
components:
  - id: button
    file: components/button.html
    variants: [primary, quiet]
```

Templates are pinned `id@version`; bump `version` to fork a new pinned id.

---

## CLI — `jonggrang design`

```bash
jonggrang design new <name> [--intent "..."] [--shapes a,b] [--keywords a,b]
jonggrang design list
jonggrang design promote <name> [--from <project-path>]   # from a project's .jonggrang/UI.md + tokens
jonggrang design show <name>
jonggrang design <name> get <tokens|guide|manifest|component-id>   # raw, agent-facing
jonggrang design validate <name>
jonggrang design remove <name>
```

- **`promote`** builds a template from a project's `.jonggrang/UI.md` (guide body →
  `guide-fragment.md`) and its token source (→ `tokens.css.template`).
- **`get`** prints the raw artifact so a coding agent can consume it, e.g.
  `jonggrang design acme get button` → the HTML fragment; `… get tokens > acme.css`.
- **`validate`** checks the pack contract + that every component file resolves and uses
  `--ui-*` tokens (raw colors are warnings, not errors).

---

## Reuse in `plan`

`~/.jonggrang/design/*` is merged into the baseline catalog, so a personal template is
selectable in any `plan` **by its `id@version`** — the audit recommends it, and its
`guide-fragment` + `tokens.css.template` feed the agent's `.jonggrang/UI.md`. Built-in
packs win on a key collision. Nothing about the plan/consent flow changes; see
[UI planning context](UI_CONTEXT.md).

---

## Web Design studio (`/design`)

The **Design** top-nav tab lists templates and opens a studio per template:

- **Left — the tool's native TUI, in unsafe mode.** A pty-backed xterm runs the selected
  backend's own interactive harness (`claude --dangerously-skip-permissions`, `opencode`,
  `codex`, `jonggrang agent`, or a plain `shell`) with **CWD = the template dir**, so the
  agent edits `manifest.yml` / `tokens.css.template` / `components/*` directly. Jonggrang
  does not wrap the chat — you use the tool's own harness.
- **Right — live preview.** A sandboxed `<iframe>` renders the template's components with
  its tokens; toggles for component, light/dark, and viewport width. A **tokens editor**
  saves `tokens.css.template` and lints on save. File changes emit `design.changed`, which
  refreshes the preview live.

### Execution mode (default: sandbox)

The studio agent is intended to run **sandboxed** (a container from the agent image, with
`IS_SANDBOX=1`, the auth mounts, and the template dir mounted) so it runs as root without
the host `~/.claude/session-env` permission issue and its writes are isolated. A per-studio
toggle can switch to host execution (faster; `opencode` works on the host, `claude` is
subject to host perms). *v1 ships the host-spawn path; the sandbox-container path is a
small follow-up.*

---

## Environment

- **`JONGGRANG_DESIGN_HOME`** — override the design store location (default
  `~/.jonggrang/design`). Useful for testing or a shared team store.

---

## Prior art

The engine shape mirrors [open-design](https://github.com/nexu-io/open-design) (an
open-source Claude-Design alternative): a design contract (`DESIGN.md` there,
`guide-fragment` + tokens here) drives a coding-agent CLI spawned in a managed project
cwd, writing real files. Jonggrang scopes outputs to HTML/CSS + token components so a
template is directly reusable as a `plan` baseline.
