# UI planning context

Jonggrang gives UI tasks enough product and design context to follow an existing
system without loading a complete design guide into every fresh agent.

## The three artifacts

- `.jonggrang/UI.md` is the canonical project rationale, source map, token
  contract, reusable patterns, and rules. It changes only with durable policy.
- `.jonggrang/.output/features/<id>/UI_HANDOFF.md` contains approved feature
  intent, direction, references, and one contract per UI task. Append may extend
  it.
- Task `ui_context` selects handoff sections, guide sections, source files,
  states, and checks for one task.

UI planning is automatic when the request or source document clearly affects a
screen, component, style, interaction, responsive behavior, or accessibility.
Backend-only plans are unchanged.

## Planning and approval

Before asking questions, `jonggrang plan` audits local evidence:

- frontend framework and component dependencies;
- token, theme, and global-style files;
- shared components and representative screens;
- Storybook, visual, accessibility, and test commands when present;
- `.jonggrang/UI.md` and the optional personal `~/.jonggrang/UI.md`.

The audit does not invent missing resources. If the project already has a usable
system, the plan follows it. Otherwise the planner asks only for material choices
that code cannot reveal, including product shape when no baseline can be chosen
confidently.

A UI draft session may contain:

```text
.jonggrang/.drafts/<session>/
  plan.md
  UI.md             # proposed project guide; absent when unchanged
  UI_HANDOFF.md     # approved feature direction before task ids exist
```

The interactive plan view shows these artifacts and a guide diff when an
existing guide would change. Approval validates the guide, decomposes tasks,
adds one `## Task task-xxx` section per UI task to the final handoff, and stores
bounded `ui_context` on UI tasks only.

## Project guide contract

`.jonggrang/UI.md` uses `format: jonggrang-ui-guide/v1` and contains:

1. Product and UX rationale
2. Visual direction and baseline
3. Source map
4. Token contract, typography, and spacing
5. Components and layout patterns
6. Interaction, responsive, and accessibility rules
7. References and verification
8. Rules summary

The guide points to the canonical token and component sources. It may include a
representative snippet, but it does not duplicate an entire CSS or DTCG file.
`token_status: ready` requires an existing source. `token_status: planned`
requires one designated foundation task; all later UI tasks depend on it.

## Starter baselines

Jonggrang ships three versioned, deliberately opinionated starting points:

- `landing-page-minimalist@1` — one conversion, proof-led narrative, editorial
  hierarchy, no generic gradient/card wallpaper;
- `dashboard-operational@1` — repeated scanning and exception handling, compact
  data patterns, explicit state, no oversized metric-card mosaic;
- `mobile-app-minimalist@1` — focused one-handed flows, edge-to-edge grouping,
  interruption safety, no nested card stacks or gesture-only critical actions.

The packs live under `templates/ui-baselines/`. Each has `manifest.yml`,
`guide-fragment.md`, and `tokens.css.template`. A pack is copied only into an
approved project token destination; projects then own that source. Guides and
handoffs pin `id@version`, so pack updates cannot silently change active work.

Selection order:

1. existing project `.jonggrang/UI.md` and local implementation evidence;
2. an explicit project reference or baseline;
3. optional `~/.jonggrang/UI.md` as personal input;
4. a matching built-in product-shape baseline;
5. a focused question when the product shape is uncertain.

`--yes` and `--no-ask` fail closed when a new UI project has no confident
baseline. State the product shape or run one interactive plan instead.

## Bounded runtime context

A UI task receives its `ui_context` plus only these handoff sections:

- `Feature intent`;
- `Shared direction`;
- its own `Task task-xxx` section.

The agent may then read only the named root-guide sections and source files. It
does not receive the full guide or unrelated task contracts. Storybook, Figma,
a browser, DTCG, Tailwind, and component frameworks remain optional.

If the handoff, guide, and code disagree, the agent reports
`UI_GUIDE_DRIFT` with the conflicting paths and rules. It must not invent a new
token or component to hide the conflict.

## Verification

Run the deterministic contract and end-to-end lifecycle smokes:

```bash
bash scripts/qa-ui-context.sh
bash scripts/smoke-ui-plan-lifecycle.sh
```

The first checks baseline manifests, repository audit, CLI task import, guide
and handoff validation, bounded prompt injection, planned-token promotion, and
drift behavior. The second uses a fake agent backend to exercise
`plan --yes --no-ask` → draft sidecars → approval → task import → final handoff
→ dry-run work prompt without spending model tokens. The normal gates remain:

```bash
npm test
npm run check
```
